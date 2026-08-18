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

/** Strip secret query-parameter values out of a string, leaving the rest legible. */
function scrub(s: string): string {
  let out = s;
  for (const p of SECRET_PARAMS) {
    // Both & and ; as terminators, because this runs on strings someone else
    // already concatenated.
    out = out.replace(new RegExp(`([?&;]${p}=)[^&;\\s"']*`, "gi"), "$1<redacted>");
  }
  // And the same names where no query string put them there. A `?` or `&` in
  // front was the whole test, so `X-Plex-Token=…` at the start of a message, or
  // after a space, went through untouched - and one of these strings is handed
  // to a third party rather than merely logged. `token` alone is deliberately
  // not in this second pass: unanchored it would redact the word wherever it
  // appears in prose.
  for (const p of [
    "x-plex-token",
    "plextoken",
    "auth_token",
    "authtoken",
    "access_token",
    "accesstoken",
    "api_key",
    "apikey",
  ]) {
    out = out.replace(new RegExp(`\\b(${p}[=:]\\s*)[^&;\\s"']+`, "gi"), "$1<redacted>");
  }
  // `Authorization: Bearer <token>` is a header, not a parameter, and reaches a
  // message whenever one is quoted back.
  out = out.replace(/\b(bearer\s+)[\w.\-+/=]+/gi, "$1<redacted>");
  // Jellyfin's own header puts the credential inside a comma-separated list -
  // `MediaBrowser Client="…", Token="…"` - so nothing in front of it is a `?`
  // or an `&`, and the passes above walk straight past it. Same for the two
  // JSON fields its answers carry a credential in.
  out = out.replace(/\b(token\s*=\s*")[^"]*"/gi, '$1<redacted>"');
  out = out.replace(/("(?:AccessToken|Secret)"\s*:\s*")[^"]*"/gi, '$1<redacted>"');
  return out;
}

/**
 * Redact whatever is about to be logged.
 *
 * Non-strings are NOT flattened to a string first. Doing that turns an object
 * into "[object Object]" and an Error into its message alone - which throws away
 * the stack, and for this app's own error type also the status and URL it exists
 * to carry. The point of a log line is to be readable afterwards.
 */
export function redact(input: unknown): unknown {
  if (typeof input === "string") return scrub(input);
  if (input instanceof Error) {
    // Copy rather than mutate: the caller may still be handling this error.
    const copy = new Error(scrub(input.message));
    copy.name = input.name;
    copy.stack = input.stack ? scrub(input.stack) : undefined;
    for (const [k, v] of Object.entries(input)) {
      (copy as unknown as Record<string, unknown>)[k] = typeof v === "string" ? scrub(v) : v;
    }
    return copy;
  }
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = typeof v === "string" ? scrub(v) : v;
    }
    return out;
  }
  return input;
}

/** The string form, for the cases that really do want one. */
export function redactString(input: unknown): string {
  const r = redact(input);
  return typeof r === "string" ? r : String(r);
}

/**
 * A header bag with its credentials removed.
 *
 * Separate from `redact` because a header's secret is its whole value, not a
 * query parameter inside it - the general form cannot see it.
 */
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
