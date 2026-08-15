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

import { plexHeaders, type PlexIdentityHeaders } from "./http";
import { log } from "../../redact";

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
const POLL_ARGS = {
  deviceClass: "stb",
  protocolCapabilities: "playback,playqueues,timeline",
  protocolVersion: "1",
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
/** How long to wait after a failed poll before trying again. */
const RETRY_MS = 5_000;
/** Ceiling for the backoff, so a server that is down is asked about calmly. */
const RETRY_MAX_MS = 60_000;

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
  id: PlexIdentityHeaders;
  onCommand: (cmd: CompanionCommand) => Promise<void> | void;
}): () => void {
  let stopped = false;
  let controller: AbortController | null = null;
  let commandId = 0;
  let backoff = RETRY_MS;

  const headers = (): Record<string, string> => ({
    ...plexHeaders(opts.id, { "X-Plex-Token": opts.token }),
    // The one header that makes this a player rather than a browser. Without it
    // the account lists the box as a client and nothing can be sent to it.
    "X-Plex-Provides": "player",
    Accept: "application/xml",
  });

  const respond = async (id: string): Promise<void> => {
    // What actually releases the controller. Without it the phone's press - or
    // the assistant's playMedia - hangs until ITS timeout, which reads as the
    // box having ignored the command even when the command has already run.
    const url = new URL("player/proxy/response", base(opts.baseUrl));
    url.searchParams.set("commandID", id);
    await fetch(url.toString(), {
      method: "POST",
      headers: { ...headers(), "Content-Type": "text/xml" },
      body: '<?xml version="1.0" encoding="utf-8"?>\n<Response code="200" status="OK" />',
    });
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
        if (!res.ok) throw new Error(`poll answered ${res.status}`);
        backoff = RETRY_MS;

        for (const cmd of parse(await res.text())) {
          const id = cmd.params.commandID;
          if (id) commandId = Math.max(commandId, Number(id) || 0);
          try {
            await opts.onCommand(cmd);
          } catch (e) {
            log.warn("companion command failed", e);
          }
          // Answered even when it failed, and deliberately: the alternative is
          // a controller that hangs, and "it did not work" is a better answer
          // than no answer at all.
          if (id) await respond(id).catch((e: unknown) => log.warn("companion response failed", e));
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

  void loop();

  return () => {
    stopped = true;
    controller?.abort();
  };
}

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
    for (const a of Array.from(el.attributes)) params[a.name] = a.value;
    out.push({ path, params });
  }
  return out;
}

function base(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
