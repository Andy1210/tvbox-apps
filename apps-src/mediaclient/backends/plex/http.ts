// HTTP against plex.tv and against a server, from the app window directly.
//
// Not through the shell's fetch broker: that returns bodies as utf8 strings with
// a 5 MB cap (no posters, no trickplay index), allows only GET/POST/HEAD, and
// takes its allowed hosts from a static manifest list - which cannot name a
// server the household configures at runtime. A media server answers
// cross-origin requests with the origin reflected and no header allowlist, so
// the plain path is both simpler and more capable.

import { log } from "../../redact";
import { CLIENT_PLATFORM, CLIENT_PRODUCT, CLIENT_VERSION } from "../../identity";

export const PLEX_TV = "https://plex.tv";

export interface PlexIdentityHeaders {
  clientId: string;
  deviceName: string;
}

/**
 * The X-Plex-* set every request carries.
 *
 * `X-Plex-Provides` is deliberately NOT sent. It is what marks a client as
 * remotely controllable, and this app answers no such protocol - claiming
 * otherwise would put it in the account's player list where a phone (or the
 * house assistant) could cast to it and get silence.
 */
/**
 * The interface language, as a bare two-letter code.
 *
 * Read at call time rather than captured, because the backend outlives a
 * language change and a stale header would leave one screen translated and the
 * next not.
 */
function language(): string {
  const l = typeof document !== "undefined" ? document.documentElement.lang : "";
  return (l || "en").slice(0, 2);
}

export function plexHeaders(id: PlexIdentityHeaders, extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: "application/json",
    "X-Plex-Client-Identifier": id.clientId,
    "X-Plex-Product": CLIENT_PRODUCT,
    "X-Plex-Version": CLIENT_VERSION,
    "X-Plex-Platform": CLIENT_PLATFORM,
    "X-Plex-Device": CLIENT_PRODUCT,
    "X-Plex-Device-Name": id.deviceName,
    // The server translates what IT names - sort orders, filter titles, genres -
    // and without this it answers in English. That is the largest text surface
    // in the app that no locale file can reach: "Rendezés" heading a column of
    // "Date Added" and "Audience Rating".
    "X-Plex-Language": language(),
    "Accept-Language": language(),
    ...(extra || {}),
  };
}

export class PlexHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message?: string,
  ) {
    super(message || `plex http ${status}`);
    this.name = "PlexHttpError";
  }
}

export interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  token?: string;
  signal?: AbortSignal;
  /** Return the raw response instead of parsed JSON (binary, ranges). */
  raw?: boolean;
}

export function buildUrl(base: string, path: string, query?: RequestOpts["query"]): string {
  const u = new URL(path, base.endsWith("/") ? base : base + "/");
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * One request. The token goes in a header rather than the query string wherever
 * a header is possible, so it stays out of URLs that get logged or reported.
 */
export async function request<T>(
  base: string,
  path: string,
  id: PlexIdentityHeaders,
  opts: RequestOpts = {},
): Promise<T> {
  const url = buildUrl(base, path, opts.query);
  const headers = plexHeaders(id, {
    ...(opts.token ? { "X-Plex-Token": opts.token } : {}),
    ...(opts.headers || {}),
  });

  let res: Response;
  try {
    res = await fetch(url, { method: opts.method || "GET", headers, signal: opts.signal });
  } catch (e) {
    // A network failure and a refusal look the same to the caller, but only one
    // of them is worth retrying, so keep the distinction in the message.
    log.warn("request failed", url, e);
    throw new PlexHttpError(0, url, "network unreachable");
  }

  if (!res.ok) {
    log.warn("request rejected", res.status, url);
    throw new PlexHttpError(res.status, url);
  }

  if (opts.raw) return res as unknown as T;

  const text = await res.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PlexHttpError(res.status, url, "response was not JSON");
  }
}

/** Plex wraps every answer in a MediaContainer; this unwraps it. */
export function container<T = Record<string, unknown>>(body: unknown): T {
  const b = body as { MediaContainer?: T } | undefined;
  return (b?.MediaContainer ?? {}) as T;
}
