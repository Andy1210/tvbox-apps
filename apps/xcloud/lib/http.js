// Dependency-free HTTPS for the xCloud plugin. A plugin.js has no node_modules on
// the box (AUTHORING.md: Node built-ins plus the package's own lib/*.js), so every
// Xbox call goes through here.
//
// It does NOT reject on a non-2xx status. The device-code poll depends on reading
// the error BODY of a 400 — `authorization_pending` means keep waiting while
// `expired_token` means stop — and a helper that rejects on status collapses those
// into one failure, which is how a poll loop ends up retrying a dead request until
// its timeout.
const https = require("https");

const DEFAULT_TIMEOUT = 15000;

// Keep-alive: the token chain is five requests to four hosts, and the catalogue
// hydration is many small batches to the same one. maxSockets is deliberately
// generous - a low cap here silently becomes the concurrency limit of every
// caller, so the pool sizes itself and the CALLER bounds its own fan-out where
// that matters (see hydrate()).
const agent = new https.Agent({ keepAlive: true, maxSockets: 32 });

function request(method, host, path, headers, body, opts) {
  const timeout = (opts && opts.timeout) || DEFAULT_TIMEOUT;
  const payload = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const h = { ...(headers || {}) };
    // Content-Length in bytes, not characters: a gamertag or a title in the body
    // is UTF-8, and a length short by the multibyte difference truncates it.
    if (payload != null && h["Content-Length"] == null) h["Content-Length"] = Buffer.byteLength(payload);

    // A real deadline, not a socket timeout. `req.setTimeout` only starts counting
    // once the agent hands the request a socket, so a request queued behind a busy
    // pool waits its queue time PLUS the timeout - measured at 30 s against a 20 s
    // setting, which makes every timeout budget a guess. This timer starts now.
    let deadline = null;
    let settled = false;
    const finish = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      fn(arg);
    };
    const done = finish(resolve);
    const fail = finish(reject);

    const req = https.request({ method, hostname: host, path, port: 443, headers: h, agent }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", fail);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        done({
          status: res.statusCode || 0,
          headers: res.headers || {},
          text,
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) <= 299,
          json() {
            if (!text) return {};
            try {
              return JSON.parse(text);
            } catch {
              return null; // a non-JSON body is a fact the caller has to see, not a throw
            }
          },
        });
      });
    });

    deadline = setTimeout(() => req.destroy(new Error("timeout after " + timeout + "ms: " + host + path)), timeout);
    req.on("error", fail);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const postJson = (host, path, headers, obj, opts) =>
  request("POST", host, path, { "Content-Type": "application/json", ...(headers || {}) }, JSON.stringify(obj), opts);

const postForm = (host, path, headers, fields, opts) =>
  request(
    "POST",
    host,
    path,
    { "Content-Type": "application/x-www-form-urlencoded", ...(headers || {}) },
    new URLSearchParams(fields).toString(),
    opts,
  );

const get = (host, path, headers, opts) => request("GET", host, path, headers, null, opts);

// A one-line description of a failed response for a log or an error message. The
// body is truncated because an Xbox error page is HTML and a token response is a
// credential we must not spill into a log in full.
function describe(res, limit = 300) {
  const body = (res.text || "").replace(/\s+/g, " ").slice(0, limit);
  return "HTTP " + res.status + (body ? " " + body : "");
}

module.exports = { request, get, postJson, postForm, describe };
