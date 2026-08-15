// HTTP against a Jellyfin server, from the app window directly.
//
// The same choice as the Plex side and for the same reasons: the shell's fetch
// broker returns bodies as utf8 strings with a 5 MB cap, allows only
// GET/POST/HEAD, and takes its allowed hosts from a static manifest - which
// cannot name a server the household configures at runtime. Jellyfin answers
// cross-origin with `Access-Control-Allow-Origin: *` and echoes the requested
// headers back (verified against 10.11), so the plain path works.
//
// What differs from Plex is where the credential lives. Plex takes a token in a
// header of its own; Jellyfin takes ONE header carrying the token and the whole
// client identity together, and it is picky about the shape.

import { log } from "../../redact";
import { CLIENT_PRODUCT, CLIENT_VERSION } from "../../identity";

export interface JellyfinIdentity {
  /** Stable per box. Jellyfin ties a session and its "remembered" state to it. */
  deviceId: string;
  deviceName: string;
}

/**
 * The one header Jellyfin authenticates with.
 *
 * `MediaBrowser` rather than `Bearer`, and the parameters are quoted - the
 * server parses this by hand and a bare value is not accepted everywhere. The
 * token is a parameter of the same header, so an unauthenticated call is simply
 * this header without `Token`, which is what the Quick Connect handshake needs.
 *
 * Quoting is not cosmetic either: a device NAME comes from the box's hostname
 * and can carry a space, which without quotes ends the parameter early.
 */
export function authHeader(id: JellyfinIdentity, token?: string): string {
  const q = (v: string): string => `"${v.replace(/["\\\r\n]/g, "")}"`;
  const parts = [
    `Client=${q(CLIENT_PRODUCT)}`,
    `Device=${q(id.deviceName)}`,
    `DeviceId=${q(id.deviceId)}`,
    `Version=${q(CLIENT_VERSION)}`,
  ];
  if (token) parts.push(`Token=${q(token)}`);
  return `MediaBrowser ${parts.join(", ")}`;
}

/**
 * The interface language, as a bare two-letter code.
 *
 * Read at call time rather than captured, for the reason the Plex side gives:
 * the backend outlives a language change.
 */
function language(): string {
  const l = typeof document !== "undefined" ? document.documentElement.lang : "";
  return (l || "en").slice(0, 2);
}

export function jellyfinHeaders(
  id: JellyfinIdentity,
  token?: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: authHeader(id, token),
    "Accept-Language": language(),
    ...(extra || {}),
  };
}

export class JellyfinHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message?: string,
  ) {
    super(message || `jellyfin http ${status}`);
    this.name = "JellyfinHttpError";
  }
}

/**
 * How long any one request may take.
 *
 * Nothing here is a long poll - the Plex backend has one and this protocol has
 * none - so a request that has not answered in this long is a server that has
 * gone away mid-connection, which TCP alone will sit on for minutes. A screen
 * waiting on that shows a spinner with no end.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/** The caller's signal and the clock, whichever gives up first. */
function bounded(signal?: AbortSignal): AbortSignal | undefined {
  const A = AbortSignal as unknown as {
    any?: (s: AbortSignal[]) => AbortSignal;
    timeout?: (ms: number) => AbortSignal;
  };
  if (typeof A.timeout !== "function") return signal;
  try {
    const clock = A.timeout(REQUEST_TIMEOUT_MS);
    if (!signal) return clock;
    return typeof A.any === "function" ? A.any([signal, clock]) : signal;
  } catch {
    return signal;
  }
}

export interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  token?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Return the raw response instead of parsed JSON (binary, ranges). */
  raw?: boolean;
}

export function buildUrl(base: string, path: string, query?: RequestOpts["query"]): string {
  const u = new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : base + "/");
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * One request.
 *
 * The token travels in the Authorization header rather than the `api_key` query
 * parameter Jellyfin also accepts, so it stays out of URLs that get logged or
 * put in the DOM. The exceptions are artwork and stream URLs, which are handed
 * to another process and are built deliberately in the backend.
 */
export async function request<T>(
  base: string,
  path: string,
  id: JellyfinIdentity,
  opts: RequestOpts = {},
): Promise<T> {
  const url = buildUrl(base, path, opts.query);
  const headers = jellyfinHeaders(id, opts.token, {
    ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(opts.headers || {}),
  });

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method || "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: bounded(opts.signal),
    });
  } catch (e) {
    // A network failure and a refusal look the same to the caller, but only one
    // of them is worth retrying, so keep the distinction in the message.
    log.warn("request failed", url, e);
    throw new JellyfinHttpError(0, url, "network unreachable");
  }

  if (!res.ok) {
    log.warn("request rejected", res.status, url);
    throw new JellyfinHttpError(res.status, url);
  }

  if (opts.raw) return res as unknown as T;

  // 204 is the ordinary answer to every write here - progress, tracks, watched.
  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new JellyfinHttpError(res.status, url, "response was not JSON");
  }
}
