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
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (e) {
      return reject(e);
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
        res.on("end", () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    r.on("timeout", () => r.destroy(new Error("timed out")));
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

/**
 * The commands in a poll's answer.
 *
 * Attributes only, which is what the server sends: `<Command path="…"
 * commandID="…" queryKey="…" />`. Parsed with a regex rather than an XML
 * library because the shape is fixed and a dependency in the host process is
 * worth more than this is.
 */
function parseCommands(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<Command\b([^>]*)\/?>/g)) {
    const params = {};
    for (const a of m[1].matchAll(/([A-Za-z0-9_:-]+)="([^"]*)"/g)) params[a[1]] = decodeEntities(a[2]);
    if (params.path) out.push({ path: params.path, params });
  }
  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Start being a player.
 *
 * `onCommand(cmd)` is called for each command and answers whether it was taken
 * on. Returning true ALSO ends this loop: handing a command to the app means the
 * app's own poll is about to start, and two pollers sharing one client
 * identifier take each other's commands - measured, the second answer to a
 * command is refused and the controller waits out its own timeout.
 */
function startCompanion(opts) {
  let stopped = false;
  let commandId = 0;
  let backoff = RETRY_MS;
  let current = null;

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
    const body = `<Response code="${ok ? 200 : 500}" status="${ok ? "OK" : "the player is not ready"}" />`;
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
        const res = await req(
          "GET",
          `${opts.session.baseUrl}/player/proxy/poll?${q}`,
          headers(),
          null,
          POLL_TIMEOUT_MS,
        );
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
          let taken = false;
          try {
            taken = !!opts.onCommand(cmd);
          } catch (e) {
            opts.log("command failed: " + (e && e.message));
          }
          if (id) await respond(id, taken);
          // Handed over: the app is coming up and will poll for itself.
          if (taken) return;
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
  current = loop();

  return () => {
    stopped = true;
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
  return { session, identity };
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
function leaveCast(storePath, cmd) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(storePath, "utf8")) || {};
  } catch (e) {
    return false;
  }
  raw["pending-cast"] = JSON.stringify({ at: Date.now(), path: cmd.path, params: cmd.params });
  try {
    fs.writeFileSync(storePath, JSON.stringify(raw), { mode: 0o600 });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports.leaveCast = leaveCast;
