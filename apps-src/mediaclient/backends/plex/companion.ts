// Being a player something else can drive.
//
// Plex calls this Companion. A player on a television is not reachable the way a
// server is - it opens no port and answers no discovery probe - so it LONG-POLLS
// its server instead, and the server hands it whatever a controller has aimed at
// it. That controller is a phone running the Plex app, or the house assistant
// asking for a film out loud; both arrive down the same wire.
//
// Every part of the contract below was measured against this server rather than
// taken from documentation, because the failure mode is silent: a poll the
// server does not like is answered 400, and a client that retries in a loop
// looks exactly like a box that is simply never chosen.

import { PLEX_TV, plexHeaders, type PlexIdentityHeaders } from "./http";
import { isActive, timelineXml, type Timeline } from "../../playback/timeline";
import { log, redactString } from "../../redact";

/**
 * What the poll must carry.
 *
 * The server names each missing piece one at a time, in its own log, and
 * answers 400 until every one is present:
 *   - header `X-Plex-Platform-Version`
 *   - argument `deviceClass`
 *   - argument `protocolCapabilities`
 * Nothing in the 400 body says which, so this list is the whole of it.
 */
/**
 * What this player says it is, and what it can be asked to do.
 *
 * Read off the working client rather than chosen: Plex's own HTPC app on one of
 * the boxes registers `protocolVersion: 2` with
 * `timeline,playback,navigation,playqueues,provider-playback`, and a phone
 * controlling it draws a full remote. This app said `protocolVersion: 1` with
 * `playback,playqueues,timeline` - measured side by side on the same server -
 * and a phone that cast to it connected, played the music, and drew no controls
 * at all.
 *
 * `provider-playback` is deliberately NOT claimed: it means the player can be
 * handed something from Plex's own providers rather than from the server's
 * library, which this app cannot do. Claiming a capability that answers a
 * command with a refusal is worse than not claiming it.
 */
const POLL_ARGS = {
  deviceClass: "stb",
  protocolCapabilities: "timeline,playback,navigation,playqueues",
  protocolVersion: "2",
};

/**
 * A floor between polls.
 *
 * The poll is meant to block until the server has something to say, so a
 * round trip that returns at once means the server is not doing that - a proxy
 * in the way, an old build, an error page with a 200 on it. Without a floor the
 * loop would then spin as fast as the network allows, which on a Pi is a core
 * spent on nothing. Short enough to be invisible when the server behaves.
 */
const MIN_POLL_MS = 250;
/**
 * How long a command may take before the controller is told it failed.
 *
 * The loop does not poll while one runs, so an unbounded handler is not a slow
 * command - it is the end of this box as a player, and every later command is
 * dropped rather than queued because delivery is fire-once into whatever poll
 * is registered at that instant.
 */
const COMMAND_TIMEOUT_MS = 12_000;
/** An acknowledgement is a local round trip; it has no business taking longer. */
const RESPOND_TIMEOUT_MS = 10_000;
/**
 * How often the box says where it is while something plays.
 *
 * One second, which is the reference client's cadence and also the coarsest a
 * phone's position bar can move without visibly stepping. It costs one small
 * POST to a server on the same LAN, and only while playing: a stopped box
 * publishes on change and then falls silent.
 */
const TIMELINE_MS = 1_000;
/** How long to wait after a failed poll before trying again. */
const RETRY_MS = 5_000;
/**
 * What puts this box in a phone's cast list.
 *
 * Polling the server is enough to BE commandable - the house assistant proves
 * that - but not to be OFFERED. Measured on this account, with the app open and
 * polling on both boxes: PMS lists them in `/clients`, PMS announces them over
 * GDM on the LAN with the right identifier, plex.tv lists them with
 * `provides="player"` - and neither Plexamp nor the Plex app shows either one.
 *
 * The answer came from the box itself. The old `apps/plex` client (Plex's own
 * HTPC bundle) IS castable from a phone, and its device row differs in exactly
 * one field: `provides="client,player"` against our `provides="player"`. Its
 * code says why, in as many words:
 *
 *     [Plex Companion] Registering PMS <name> as a proxy for Plex Companion
 *     PUT /devices/<clientIdentifier>
 *         X-Plex-Provides: client,player
 *         proxiedBy=<the server's machineIdentifier>
 *
 * So a Companion player is not something the account infers from a poll: the
 * client REGISTERS itself as a player and names the server that will relay to
 * it. That is what this does, and what the teardown undoes - the same client
 * drops back to `X-Plex-Provides: client` when it stops being a player.
 */
/** Ceiling for the backoff, so a server that is down is asked about calmly. */
const RETRY_MAX_MS = 60_000;

/**
 * What to tell the controller.
 *
 * Measured: the server proxies this XML to the controller VERBATIM, and the
 * assistant reads the code - its own comment says "a client that rejects the
 * command says so here, and reporting that as success would be a lie". So a
 * command that could not be carried out must not answer 200, or the house says
 * a film is playing while the television shows the launcher.
 */
export type CommandResult = { ok: true } | { ok: false; reason: string };

export interface CompanionCommand {
  /** e.g. "/player/playback/playMedia" */
  path: string;
  /** Every attribute the controller sent, `key` and `offset` included. */
  params: Record<string, string>;
}

/**
 * Poll for commands until the returned function is called.
 *
 * The loop owns its own errors: a server that goes away, a token that stops
 * working and a malformed answer all become a backoff rather than an exception,
 * because there is nobody to catch one here and a player that stops polling
 * stops being a player with nothing on screen to say so.
 */
export function startCompanion(opts: {
  baseUrl: string;
  token: string;
  /** The server's machineIdentifier: who relays to this player. */
  serverId?: string;
  id: PlexIdentityHeaders;
  onCommand: (cmd: CompanionCommand) => Promise<CommandResult> | CommandResult;
  /**
   * What this box is doing, asked for whenever a controller needs telling.
   *
   * Without it the player answers a subscribe and then says nothing, and a
   * phone waits for a first report that never comes - which it shows as still
   * connecting. See `timeline.ts` for the shape and where it came from.
   */
  timelines?: () => Timeline[];
  /** The token stopped working. The loop ends; the app decides what to show. */
  onUnauthorized?: () => void;
}): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  /** In-flight acknowledgements, so `stop()` can free a loop parked in one. */
  const responders = new Set<AbortController>();
  const once = runOnce();
  let commandId = 0;
  let backoff = RETRY_MS;
  /** The last report sent, so a stopped box does not repeat itself forever. */
  let lastReport = "";
  let timelineTimer: ReturnType<typeof setTimeout> | null = null;
  /** One publish in flight at a time; a second is folded into the next tick. */
  let publishing = false;
  /** Whether a refused status report has already been said. */
  let reportRefused = false;
  /** Whether the oversize refusal has already been said. */
  let oversize = false;

  const headers = (): Record<string, string> => ({
    ...plexHeaders(opts.id, { "X-Plex-Token": opts.token }),
    // The one header that makes this a player rather than a browser. Without it
    // the account lists the box as a client and nothing can be sent to it.
    "X-Plex-Provides": "player",
    Accept: "application/xml",
  });

  const respond = async (id: string, result: CommandResult): Promise<void> => {
    // What actually releases the controller. Without it the phone's press - or
    // the assistant's playMedia - hangs until ITS timeout, which reads as the
    // box having ignored the command even when the command has already run.
    const url = new URL("player/proxy/response", base(opts.baseUrl));
    url.searchParams.set("commandID", id);
    const code = result.ok ? "200" : "500";
    // Through the redactor, because this is the one string this app sends to a
    // third party that the redactor never saw: the reason is an error message
    // from anywhere in the command path, and the server hands the answer on to
    // the controller byte for byte (verified against the live server).
    const status = result.ok ? "OK" : redactString(result.reason).slice(0, 120);
    // Its own signal, and a timeout. `stop()` aborts the POLL, and a response
    // that never settles left the loop parked in an in-flight request carrying
    // the previous session's token - so sign-out did not actually stop it.
    //
    // A response created AFTER stop() was never in `responders` for stop() to
    // abort, so it went out under the old token however long the command had
    // taken. There is nothing to release either: the loop is gone.
    if (stopped) return;
    const timer = setTimeout(() => respondController.abort(), RESPOND_TIMEOUT_MS);
    const respondController = new AbortController();
    responders.add(respondController);
    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: { ...headers(), "Content-Type": "text/xml" },
        body: `<?xml version="1.0" encoding="utf-8"?>\n<Response code="${code}" status="${escapeAttr(status)}" />`,
        signal: respondController.signal,
      });
      // Checked, because a refused acknowledgement means the controller is
      // still waiting and nothing else will tell us.
      if (!res.ok) log.warn(`companion response answered ${res.status}`);
    } finally {
      clearTimeout(timer);
      responders.delete(respondController);
    }
  };

  /**
   * Tell the controller what this box is doing.
   *
   * Sent to the same proxy the commands arrive through, carrying the last
   * command answered - that number is how the server pairs a report with the
   * controller waiting for one.
   *
   * Failures are swallowed on purpose. A report is a courtesy repeated every
   * second; a warning per failure would be a log line per second for as long as
   * a server is unreachable, and the poll loop already says that once.
   */
  const publish = async (): Promise<void> => {
    if (stopped || !opts.timelines || publishing) return;
    let lines: Timeline[];
    try {
      lines = opts.timelines();
    } catch (e) {
      return;
    }
    const body = timelineXml(lines);
    // While something plays the position moves, so every tick is worth sending.
    // While nothing does, only a change is: otherwise a box sitting on a poster
    // grid posts the same three stopped lines forever.
    const moving = isActive(lines);
    if (!moving && body === lastReport) return;
    publishing = true;
    const url = new URL("player/proxy/timeline", base(opts.baseUrl));
    url.searchParams.set("commandID", String(commandId));
    try {
      const res = await fetch(url.toString(), {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/xml" },
        body,
      });
      // Said ONCE, not once a second - but said. A refused report is invisible
      // from every other angle: the box goes on playing, the controller goes on
      // waiting, and a phone showing no controls looks like a phone that never
      // asked. Silence here is what would hide that.
      if (!res.ok && !reportRefused) {
        reportRefused = true;
        log.warn(`the server refused this player's status report (${res.status})`);
      }
      // Cleared on the way back up, like the oversize flag below: said once per
      // spell of trouble, not once per process. One transient refusal would
      // otherwise silence a permanent one that starts an hour later.
      if (res.ok) reportRefused = false;
      lastReport = body;
    } catch (e) {
      if (!reportRefused) {
        reportRefused = true;
        log.warn("this player's status report did not reach the server", e);
      }
    } finally {
      publishing = false;
    }
  };

  /**
   * Keep reporting while anything is playing, then stop.
   *
   * A timer rather than a loop so it can be armed from a command handler - a
   * subscribe has to be answered with a report immediately, or the phone that
   * sent it waits a whole second before it has anything to draw.
   */
  const scheduleTimeline = (): void => {
    if (stopped || timelineTimer || !opts.timelines) return;
    timelineTimer = setTimeout(() => {
      timelineTimer = null;
      void publish().finally(() => {
        let active = false;
        try {
          active = isActive(opts.timelines?.() ?? []);
        } catch (e) {
          active = false;
        }
        // Kept ticking while something plays; otherwise the next report is
        // whatever arms this again (a command, or playback starting).
        if (active) scheduleTimeline();
      });
    }, TIMELINE_MS);
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      const startedAt = Date.now();
      controller = new AbortController();
      try {
        const url = new URL("player/proxy/poll", base(opts.baseUrl));
        for (const [k, v] of Object.entries({ ...POLL_ARGS, commandID: String(commandId) })) {
          url.searchParams.set(k, v);
        }
        // No timeout: this request is MEANT to hang. The server holds it open
        // until it has something to say, which is what makes a command arrive
        // in the moment it is sent rather than on the next tick of a poll.
        const res = await fetch(url.toString(), { headers: headers(), signal: controller.signal });
        // A dead credential is not a transient failure, and this is the one
        // place in the app that would otherwise swallow it: everywhere else a
        // 401 becomes "signed out" on screen. Here it would be a warning line
        // every sixty seconds, forever, with the box looking fine.
        if (res.status === 401 || res.status === 403) {
          log.warn("companion poll rejected the credential; stopping");
          opts.onUnauthorized?.();
          return;
        }
        if (!res.ok) throw new Error(`poll answered ${res.status}`);
        backoff = RETRY_MS;

        const answer = await boundedText(res, MAX_ANSWER_BYTES);
        // Nothing to answer with: the commandID the controller is waiting on is
        // inside the body that was refused, so all this can do is say why and
        // let the poll come round again.
        if (answer.over) {
          // Backed off like any other failed poll, and said once. A server
          // answering oversize does it every time, so at the poll floor this
          // would be four log lines a second for as long as the box is on.
          if (!oversize) log.warn("companion poll answered more than this player will read; ignored");
          oversize = true;
          await sleep(backoff);
          backoff = Math.min(RETRY_MAX_MS, backoff * 2);
          continue;
        }
        oversize = false;
        for (const cmd of parse(answer.text)) {
          const id = cmd.params.commandID;
          // Kept although THIS server ignores it: measured, PMS discards the
          // poll's commandID and keeps its own per-controller sequence. The
          // protocol defines it as "the last command processed", and answering
          // it correctly costs a number.
          if (id) commandId = Math.max(commandId, Number(id) || 0);
          // Without a number there is nothing to acknowledge, and the server
          // would hand the same command over on the next poll - measured, a
          // server answering an unnumbered command had the box run it about
          // four times a second, forever. Run it once and move on.
          if (!id && !once.add(cmd.path)) continue;
          // Stopped while this answer was being read. Sign-out and the profile
          // picker both land here, and running the command anyway would play as
          // the person who just left.
          if (stopped) return;
          // Every command that arrives, by path. A controller that draws no
          // buttons is either sending something this player refuses or sending
          // nothing at all, and those two look identical from the sofa - this
          // line is what tells them apart. One line per press.
          log.info(`companion command ${cmd.path}`);
          let result: CommandResult;
          try {
            // Bounded, because the loop does not poll while a command runs: a
            // handler that never settles ends the box's life as a player with
            // nothing on screen to say so, and every later command is then
            // lost rather than queued.
            result = await withTimeout(opts.onCommand(cmd), COMMAND_TIMEOUT_MS);
          } catch (e) {
            log.warn("companion command failed", e);
            result = { ok: false, reason: e instanceof Error ? e.message : "command failed" };
          }
          // Answered either way: the alternative is a controller that hangs,
          // and "it did not work" is a better answer than no answer at all.
          if (id) await respond(id, result).catch((e: unknown) => log.warn("companion response failed", e));
          // After the answer, never before it: the controller is waiting on the
          // answer, and a report that goes first delays the press it belongs to.
          // Every command is followed by one, not only subscribe - a phone that
          // pressed pause wants the new state, and a playMedia is the first
          // thing the report has to describe.
          void publish();
          scheduleTimeline();
        }
        const took = Date.now() - startedAt;
        if (took < MIN_POLL_MS) await sleep(MIN_POLL_MS - took);
      } catch (e) {
        if (stopped) return;
        // An aborted poll is this loop being torn down, not a failure.
        if (e instanceof Error && e.name === "AbortError") return;
        log.warn("companion poll failed", e);
        await sleep(backoff);
        backoff = Math.min(RETRY_MAX_MS, backoff * 2);
      }
    }
  };

  /**
   * Register as a player that this server proxies, and stop being one on the way
   * out. Failure is logged and ignored: it costs the cast pickers, and nothing
   * else in the app depends on it.
   *
   * `keepalive` on the deregister because it fires while the window is going
   * away, which is the one request here that would otherwise be cancelled by
   * the navigation that caused it.
   */
  const registerAsPlayer = async (asPlayer: boolean): Promise<void> => {
    if (!opts.serverId) return;
    const url = new URL(`devices/${encodeURIComponent(opts.id.clientId)}`, `${PLEX_TV}/`);
    url.searchParams.set("proxiedBy", opts.serverId);
    try {
      const res = await fetch(url.toString(), {
        method: "PUT",
        keepalive: !asPlayer,
        headers: {
          ...plexHeaders(opts.id, { "X-Plex-Token": opts.token }),
          Accept: "application/xml",
          // The whole point: "client" alone is a browser, "client,player" is
          // something a phone may cast to.
          "X-Plex-Provides": asPlayer ? "client,player" : "client",
        },
      });
      if (!res.ok) log.warn(`plex.tv refused the player registration (${res.status})`);
    } catch (e) {
      log.warn("could not register this box as a player", e);
    }
  };

  void loop();
  // After the loop: the poll is what makes the box commandable and must not
  // queue behind an internet round trip that only decides who can find it.
  void registerAsPlayer(true);

  return () => {
    stopped = true;
    if (timelineTimer) clearTimeout(timelineTimer);
    timelineTimer = null;
    void registerAsPlayer(false);
    controller?.abort();
    for (const r of responders) r.abort();
  };
}

/**
 * How many commands one answer may carry.
 *
 * The server sends one at a time, measured - but the answer is parsed and every
 * element in it dispatched, so a broken or hostile server could hand over an
 * arbitrarily long list and be obeyed item by item. This app will sign into a
 * server it does not own (an account with no server of its own uses a shared
 * one), so "the server is trusted" is not a property to rely on here.
 */
const MAX_COMMANDS = 16;
/** And how much of an answer to read at all. A real one is a few hundred bytes. */
const MAX_ANSWER_BYTES = 64 * 1024;

/** Commands arrive as attributes on a `<Command>` element, one per press. */
function parse(xml: string): CompanionCommand[] {
  const out: CompanionCommand[] = [];
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, "application/xml");
  } catch {
    return out;
  }
  if (doc.querySelector("parsererror")) return out;
  for (const el of Array.from(doc.getElementsByTagName("Command"))) {
    const path = el.getAttribute("path");
    if (!path) continue;
    const params: Record<string, string> = {};
    // Verbatim. The server renames a controller's query arguments - `key`
    // arrives as `queryKey` - and that renaming belongs to whoever reads them
    // by name, not to the wire. See `arg()` in remoteControl.ts.
    for (const a of Array.from(el.attributes)) params[a.name] = a.value;
    out.push({ path, params });
    if (out.length >= MAX_COMMANDS) break;
  }
  return out;
}

function base(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * Remembers the unnumbered commands already run, so they run once.
 *
 * One per loop rather than one per page: as a module singleton it outlived
 * sign-out and the profile picker, so a command was remembered across the
 * change of person, and it grew without limit on a server that sends paths
 * (96 distinct ones inside 1.5 s, measured) - the set is keyed by a string the
 * SERVER chooses.
 */
function runOnce(limit = 256): { add(path: string): boolean } {
  const seen = new Set<string>();
  return {
    add(rawPath: string): boolean {
      // Bounded, because the KEY is chosen by the server: 256 entries of an
      // arbitrarily long path is a cap on the count and none on the memory -
      // measured at 60 KB a path, 26 MiB. Two paths sharing a 256-character
      // prefix are treated as one, which costs at most a command not run and
      // needs a path far longer than any this protocol uses.
      const path = rawPath.length > 256 ? rawPath.slice(0, 256) : rawPath;
      if (seen.has(path)) return false;
      // Full: the oldest is forgotten rather than the newest refused, because
      // refusing would drop a command that has never run. The cost is that a
      // path can run a second time after 256 distinct ones - which needs a
      // server sending unnumbered commands, and PMS numbers every one.
      if (seen.size >= limit) seen.delete(seen.values().next().value as string);
      seen.add(path);
      return true;
    },
  };
}

/**
 * Read an answer without buffering all of it.
 *
 * The cap used to be a `slice` on an already-read body, which bounds parsing
 * and nothing else: measured, an 8 MB answer materialised in full behind a
 * 64 KB limit. This app signs into servers it does not own, and the box talks
 * to them over plain HTTP, so the far end is not a size we get to assume.
 */
async function boundedText(res: Response, max: number): Promise<{ text: string; over: boolean }> {
  const declared = Number(res.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    // Cancelled, not merely abandoned: this path returns before the reader
    // exists, so nothing else would ever close the body - and the loop asks
    // again immediately, so an unclosed one per poll is a leak with a clock on
    // it.
    void (res as { body?: ReadableStream<Uint8Array> | null }).body?.cancel().catch(() => {});
    return { text: "", over: true };
  }
  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body;
  // No stream to read: everything this runs on has one, so this is the shape a
  // test double takes. Bounded by the length check above and by the guard here.
  if (!body || typeof body.getReader !== "function") {
    const text = await res.text();
    return text.length > max ? { text: "", over: true } : { text, over: false };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.length > max) return { text: "", over: true };
    }
    text += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { text, over: false };
}

async function withTimeout<T>(work: Promise<T> | T, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error("command timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An attribute value goes into XML the server hands on verbatim.
 *
 * Control characters are dropped rather than escaped: most of C0 cannot be
 * represented in XML 1.0 at all, not even as a character reference, and the
 * server forwards whatever it is given - measured, a NUL in a reason reached
 * the controller inside the attribute, which is a document no conforming parser
 * on the other end has to accept.
 */
function escapeAttr(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
