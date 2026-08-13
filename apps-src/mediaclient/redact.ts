// Media-server URLs carry the account token as a query parameter, and this app
// builds, logs and reports those URLs. The shell already redacts the same
// parameter names on its own log paths; this is the app-side half, applied
// before anything reaches console or an error message.
//
// What this CANNOT reach: the stream URL handed to the shell's player ends up in
// mpv's argv, and therefore in /proc/<pid>/cmdline. Nothing app-side changes
// that - a direct-play part is 401 without the token, so the token must be in
// the URL. It is recorded in the design as a core-side note.

// Kept in step with the shell's own denylist, plus `pin`: a household member's
// profile PIN travels as a query parameter, and a WRONG one produces exactly the
// non-ok response that gets its URL logged.
const SECRET_PARAMS = [
  "x-plex-token",
  "plextoken",
  "token",
  "auth_token",
  "authtoken",
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "secret",
  "signature",
  "password",
  "passwd",
  "pin",
];

const SECRET_HEADERS = ["x-plex-token", "authorization", "x-emby-token"];

/**
 * Replace the value of every secret-bearing query parameter in a string, leaving
 * everything else readable. Works on bare URLs and on prose containing one.
 */
export function redact(input: unknown): string {
  let s = typeof input === "string" ? input : String(input);
  for (const p of SECRET_PARAMS) {
    // Both orderings of the separator, and both & and ; as terminators, because
    // this runs on strings that were already concatenated by someone else.
    s = s.replace(new RegExp(`([?&;]${p}=)[^&;\\s"']*`, "gi"), "$1<redacted>");
  }
  return s;
}

/** Same, for a header bag about to be logged. */
export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = SECRET_HEADERS.includes(k.toLowerCase()) ? "<redacted>" : v;
  }
  return out;
}

/** Console wrapper. Every log line in this app goes through it. */
export const log = {
  info(...parts: unknown[]): void {
    console.log("[mediaclient]", ...parts.map(redact));
  },
  warn(...parts: unknown[]): void {
    console.warn("[mediaclient]", ...parts.map(redact));
  },
  error(...parts: unknown[]): void {
    console.error("[mediaclient]", ...parts.map(redact));
  },
};
