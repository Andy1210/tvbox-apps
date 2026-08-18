// The Plex Companion receiver, in the SHELL rather than in the page.
//
// A phone can only cast to a television it can find, and a Plex player is
// findable only while something is polling the server for commands. When that
// something is the app's own page, the box is a player only after somebody has
// walked to the television and opened it - which is the one thing casting exists
// to avoid, and not how the box's other receivers work: YouTube's DIAL listener
// and Spotify's librespot both live out here and are up whether or not their
// app is.
//
// So this polls, and a command LAUNCHES the app rather than being executed here.
// Nothing about playback lives in this file: it holds no player, decides no
// track, and its whole job is to be reachable and then get out of the way.
//
// The credential is the app's, read from the store the app already writes it to
// (the `storage` capability -> ~/.tvbox/appdata/mediaclient.json). Nothing is
// duplicated and nothing new is asked of the page; if nobody has signed in, this
// simply does not run.
const fs = require("fs");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const PLEX_TV = "https://plex.tv";
/** What this player says it is. Matched to Plex's own client - see the app's
 *  companion.ts for the measurement that settled the version and the list. */
const POLL_ARGS = {
  deviceClass: "stb",
  protocolCapabilities: "timeline,playback,navigation,playqueues",
  protocolVersion: "2",
};
/** A floor between polls, so a server that answers at once cannot spin this. */
const MIN_POLL_MS = 500;
const RETRY_MS = 5_000;
const RETRY_MAX_MS = 60_000;
/** A poll is meant to hang; this is only a backstop against a dead socket. */
const POLL_TIMEOUT_MS = 10 * 60_000;
const SHORT_TIMEOUT_MS = 15_000;
const MAX_BODY = 256 * 1024;

/** One request, with a body cap and no redirects. */
function req(method, urlStr, headers, body, timeoutMs) {
  let request = null;
  const p = new Promise((resolve, reject) => {
    // Settled once, from whichever of the several endings arrives first.
    let done = false;
    const settle = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const fail = (e) => {
      if (done) return;
      done = true;
      reject(e);
    };
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return fail(e);
    }
    const mod = url.protocol === "https:" ? https : http;
    const r = mod.request(
      url,
      {
        method,
        headers: body ? { ...headers, "Content-Length": Buffer.byteLength(body) } : headers,
        // The server presents a certificate for a *.plex.direct name that
        // resolves to a private address; Node has the root, so this is ordinary
        // verification and not a place to turn it off.
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_BODY) return r.destroy(new Error("answer too large"));
          chunks.push(c);
        });
        res.on("end", () => settle({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") }));
        // A body cut off mid-flight - a wifi blip, a NAT timeout, a server
        // restart - emits `aborted`/`close` on the RESPONSE and nothing on the
        // request, so a handler only on the request leaves this promise unsettled
        // for ever. The poll is meant to hang, so its own timeout cannot save it
        // either: the socket is already gone, so no inactivity fires. Measured:
        // the loop parked and the box silently stopped being a player.
        res.on("aborted", () => fail(new Error("the answer was cut off")));
        res.on("close", () => fail(new Error("the answer was cut off")));
      },
    );
    r.on("timeout", () => r.destroy(new Error("timed out")));
    r.on("error", fail);
    r.on("close", () => fail(new Error("the connection closed")));
    request = r;
    if (body) r.write(body);
    r.end();
  });
  // Not an AbortController: this runs on whatever Node the box's Electron has,
  // and destroying the request is the one thing every version agrees on.
  p.abort = () => {
    try {
      if (request) request.destroy(new Error("stopped"));
    } catch (e) {
      /* already gone */
    }
  };
  return p;
}

/**
 * The commands in a poll's answer.
 *
 * Attributes only, which is what the server sends: `<Command path="…"
 * commandID="…" queryKey="…" />`. Parsed with a regex rather than an XML
 * library because the shape is fixed and a dependency in the host process is
 * worth more than this is.
 */
/** No more than this many from one answer, whatever it contains. */
const MAX_COMMANDS = 16;

function parseCommands(xml) {
  // Comments and CDATA first: `<!-- <Command path="…"/> -->` is not a command,
  // and matching one is a box acting on something the server wrote down rather
  // than sent.
  const text = String(xml)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const out = [];
  // The element ends at the first `>` that is not inside a quoted value: a raw
  // `>` is LEGAL inside an attribute value, and stopping at it truncated the
  // command - measured, a key containing one lost both its value and its
  // commandID, so the box acted on a paramless command and answered nobody.
  for (const m of text.matchAll(/<Command\b((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g)) {
    const params = {};
    for (const a of m[1].matchAll(/([A-Za-z0-9_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      params[a[1]] = decodeEntities(a[2] !== undefined ? a[2] : a[3]);
    }
    if (params.path) out.push({ path: params.path, params });
    if (out.length >= MAX_COMMANDS) break;
  }
  return out;
}

function decodeEntities(s) {
  return (
    s
      // Numeric references too: a key carrying one arrived unusable otherwise.
      // Bounded to the BMP, and anything else is left as written rather than
      // turned into a replacement character.
      .replace(/&#x([0-9a-fA-F]{1,6});/g, (m, h) => codePoint(parseInt(h, 16), m))
      .replace(/&#(\d{1,7});/g, (m, d) => codePoint(parseInt(d, 10), m))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      // Last, or a doubly-escaped value decodes one level too far.
      .replace(/&amp;/g, "&")
  );
}

function codePoint(n, original) {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return original;
  try {
    return String.fromCodePoint(n);
  } catch (e) {
    return original;
  }
}

/**
 * Start being a player.
 *
 * `onCommand(cmd)` answers one of three things: `true` for a command handed to
 * the app (which ALSO ends this loop - the app's own poll is about to start, and
 * two pollers sharing one client identifier take each other's commands), `"ok"`
 * for one this receiver answered itself, and anything else for a refusal.
 */
function startCompanion(opts) {
  let stopped = false;
  let commandId = 0;
  let backoff = RETRY_MS;
  let current = null;
  /** The poll in flight, so stopping can really stop it. */
  let inFlight = null;

  const headers = (extra) => ({
    Accept: "application/xml",
    "X-Plex-Token": opts.session.token,
    "X-Plex-Client-Identifier": opts.identity.clientId,
    "X-Plex-Product": "tvbox",
    "X-Plex-Version": "0.1.0",
    "X-Plex-Platform": "Linux",
    "X-Plex-Platform-Version": "1",
    "X-Plex-Device": "tvbox",
    "X-Plex-Device-Name": opts.identity.host || "tvbox",
    "X-Plex-Provides": "player",
    ...(extra || {}),
  });

  /**
   * Tell the account this box is a player the server proxies to.
   *
   * Without it the box is commandable and not OFFERED: measured on this
   * account, a polling client that had not registered was listed by the server
   * and shown by no phone.
   */
  async function register(asPlayer) {
    if (!opts.session.serverId) return;
    const url = `${PLEX_TV}/devices/${encodeURIComponent(opts.identity.clientId)}?proxiedBy=${encodeURIComponent(
      opts.session.serverId,
    )}`;
    try {
      await req(
        "PUT",
        url,
        headers({ "X-Plex-Provides": asPlayer ? "client,player" : "client" }),
        null,
        SHORT_TIMEOUT_MS,
      );
    } catch (e) {
      opts.log("could not register as a player: " + (e && e.message));
    }
  }

  async function respond(id, ok) {
    const url = `${opts.session.baseUrl}/player/proxy/response?commandID=${encodeURIComponent(id)}`;
    const body = `<Response code="${ok ? 200 : 500}" status="${ok ? "OK" : "the media app is not open on this box"}" />`;
    try {
      await req("POST", url, headers({ "Content-Type": "application/xml" }), body, SHORT_TIMEOUT_MS);
    } catch (e) {
      /* the controller times out on its own; nothing here can fix it */
    }
  }

  async function loop() {
    while (!stopped) {
      const startedAt = Date.now();
      try {
        const q = new URLSearchParams({ ...POLL_ARGS, commandID: String(commandId) });
        // Held, because a poll is MEANT to hang: without a handle, standing
        // down left a socket registered with the server for up to ten minutes,
        // and a command delivered into it was swallowed - taken from the
        // server, never answered, with the controller waiting out its own
        // timeout. That is the "two pollers take each other's commands" this
        // file's header says cannot happen.
        const pending = req("GET", `${opts.session.baseUrl}/player/proxy/poll?${q}`, headers(), null, POLL_TIMEOUT_MS);
        inFlight = pending;
        const res = await pending.finally(() => {
          if (inFlight === pending) inFlight = null;
        });
        if (stopped) return;
        if (res.status === 401 || res.status === 403) {
          opts.log("the server refused this box's credential; standing down");
          if (opts.onUnauthorized) opts.onUnauthorized();
          return;
        }
        if (res.status >= 400) throw new Error("poll answered " + res.status);
        backoff = RETRY_MS;

        for (const cmd of parseCommands(res.text)) {
          if (stopped) return;
          const id = cmd.params.commandID;
          if (id) commandId = Math.max(commandId, Number(id) || 0);
          // Three answers, not two. `"ok"` is a command this receiver really
          // did answer - a phone subscribing before it casts - and the loop
          // stays up for the cast that follows. `true` is a handover: the app
          // is coming up and will poll for itself. Anything else is a refusal.
          let answer = false;
          try {
            answer = opts.onCommand(cmd);
          } catch (e) {
            opts.log("command failed: " + (e && e.message));
          }
          if (id) await respond(id, answer === true || answer === "ok");
          if (answer === true) return;
        }
        const took = Date.now() - startedAt;
        if (took < MIN_POLL_MS) await new Promise((r) => setTimeout(r, MIN_POLL_MS - took));
      } catch (e) {
        if (stopped) return;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(RETRY_MAX_MS, backoff * 2);
      }
    }
  }

  void register(true);
  // Whichever way the loop ends - a refused credential, a handover, an error it
  // gave up on - the owner has to hear it, or the handle stays set and the next
  // tick reads it as "already listening" for the life of the box.
  current = loop().finally(() => {
    if (!stopped && opts.onEnded) opts.onEnded();
  });

  return (deregister) => {
    stopped = true;
    // The account still lists this box as a player otherwise, so a phone offers
    // a television that answers nothing. Only when asked: standing down for a
    // handover is not leaving, the app registers again a moment later.
    if (deregister) void register(false);
    if (inFlight && inFlight.abort) inFlight.abort();
    return current;
  };
}

/** The app's own store, or null when nobody has signed in on this box. */
function readSession(path) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (e) {
    return null;
  }
  const get = (k) => {
    try {
      return JSON.parse(raw[k]);
    } catch (e) {
      return null;
    }
  };
  const session = get("session");
  const identity = get("identity");
  // The app's own setting, from the same store. Absent means a box nobody has
  // asked yet, and a television that answers no phone is the surprise - so the
  // default is on, and only an explicit `false` turns it off.
  const prefs = get("prefs") || {};
  if (prefs.cast === false) return null;
  if (!session || !identity) return null;
  // Plex only: the poll is a Plex route, and a Jellyfin session has no business
  // on it. A session written before there was a second backend has no `kind`.
  if (session.kind && session.kind !== "plex") return null;
  if (!session.token || !session.baseUrl || !identity.clientId) return null;
  return { session, identity, profileId: String(session.profileId || "") };
}

module.exports = { startCompanion, readSession, parseCommands };

/**
 * Leave a command for the app to pick up when it opens.
 *
 * Written into the app's OWN store, which is the only channel a page has to
 * this side (the `storage` capability). Not on the launch url: a playMedia
 * carries the key, the queue, the server and its address, well past what the
 * shell lets a sender put on a page - and that limit is right, since that path
 * exists for untrusted senders.
 *
 * Read-modify-write of one key. The app is not running when this happens, which
 * is what makes that safe.
 */
/** What a stashed command may weigh. The store has a 256 KB quota the shell
 *  enforces on the APP's writes and cannot enforce on this one, and a store over
 *  quota is one the app can no longer write a token to - or shrink back. */
const MAX_PENDING_BYTES = 8 * 1024;

function leaveCast(storePath, cmd, profileId) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch (e) {
    return false;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const pending = JSON.stringify({
    at: Date.now(),
    // Whose cast this is. The app runs it when somebody has been chosen, and
    // without this it would run under whoever that turns out to be - the box
    // answered Plex as the last person signed in, and the command would then
    // play as the next one, history and all, past the picker it never saw.
    profileId: profileId || "",
    path: cmd.path,
    params: cmd.params,
  });
  if (Buffer.byteLength(pending) > MAX_PENDING_BYTES) return false;
  raw["pending-cast"] = pending;
  // Temp file, then rename. Two writers on a file whose reader maps a parse
  // failure to an EMPTY store: torn here, the box loses the session token and
  // the identity with it and just shows a sign-in screen, with nothing anywhere
  // saying why. Same shape as every other write on this box that matters.
  const tmp = storePath + ".tmp-cast";
  try {
    fs.writeFileSync(tmp, JSON.stringify(raw), { mode: 0o600 });
    fs.renameSync(tmp, storePath);
    return true;
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch (x) {
      /* nothing to clean up */
    }
    return false;
  }
}

module.exports.leaveCast = leaveCast;
