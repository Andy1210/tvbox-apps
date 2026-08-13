// Signing in from a TV: the account shows a short code, the person types it on a
// device that has a keyboard, and the box picks up the token when they do.
//
// Two flows exist and they are not interchangeable. The "strong" code belongs to
// a browser redirect, which a 10-foot client cannot run. The plain one is the
// four-character code typed at plex.tv/link, which is this flow. Asking for a
// strong code here yields something the link page will not accept.

import { PLEX_TV, container, request, type PlexIdentityHeaders } from "./http";
import type { DeviceLogin, Session } from "../types";
import { log } from "../../redact";

/** The link code expires server-side after this long. */
const PIN_TTL_MS = 15 * 60 * 1000;

interface PinResponse {
  id: number;
  code: string;
  authToken: string | null;
}

interface ResourceConnection {
  protocol: string;
  address: string;
  port: number;
  uri: string;
  local: boolean;
  relay: boolean;
  IPv6: boolean;
}

interface Resource {
  name: string;
  clientIdentifier: string;
  provides: string;
  accessToken?: string;
  owned: boolean;
  connections: ResourceConnection[];
}

/**
 * Pick where to reach a server.
 *
 * A local connection is preferred over the account's relay/remote address for a
 * reason that shows up as picture quality rather than as an error: reached from
 * outside, a server classifies the session as remote and applies its remote
 * bitrate limit, so the same film is capped even though both ends sit in the
 * same room.
 */
export function pickConnection(r: Resource): { uri: string; location: "lan" | "wan" } | null {
  const usable = (r.connections || []).filter((c) => !c.relay && c.uri);
  const local = usable.find((c) => c.local);
  if (local) return { uri: local.uri, location: "lan" };
  const remote = usable[0];
  return remote ? { uri: remote.uri, location: "wan" } : null;
}

export interface BeginLoginDeps {
  id: PlexIdentityHeaders;
  /** Injected so tests need no timers. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Start the link flow. The returned `poll` resolves with a session once the code
 * is entered, or null when it expires.
 */
export async function beginDeviceLogin(deps: BeginLoginDeps): Promise<DeviceLogin> {
  const { id, now = () => Date.now(), sleep = defaultSleep } = deps;

  const pin = await request<PinResponse>(PLEX_TV, "api/v2/pins", id, { method: "POST" });
  const startedAt = now();

  const poll = async (signal?: AbortSignal): Promise<Session | null> => {
    // Backing off matters: the code lives 15 minutes, and a flat 2s interval
    // would put several hundred requests through a rate-limited endpoint for one
    // sign-in.
    while (now() - startedAt < PIN_TTL_MS) {
      if (signal?.aborted) return null;
      await sleep(now() - startedAt < 60_000 ? 2_000 : 5_000);
      if (signal?.aborted) return null;

      const p = await request<PinResponse>(PLEX_TV, `api/v2/pins/${pin.id}`, id, { signal });
      if (!p.authToken) continue;

      const session = await firstServer(id, p.authToken, signal);
      if (session) return session;

      // Linked, but the account has no server we can reach. Retrying will not
      // change that, and the caller needs to say so rather than spin.
      log.warn("account linked but no reachable server");
      return null;
    }
    return null;
  };

  return { code: pin.code, url: "plex.tv/link", poll };
}

/** Resolve the account's first owned server into a session. */
export async function firstServer(
  id: PlexIdentityHeaders,
  accountToken: string,
  signal?: AbortSignal,
): Promise<Session | null> {
  const resources = await request<Resource[]>(PLEX_TV, "api/v2/resources", id, {
    token: accountToken,
    query: { includeHttps: 1, includeIPv6: 1 },
    signal,
  });

  const servers = (resources || []).filter((r) => (r.provides || "").split(",").includes("server"));
  // The household's own server first: someone else's shared library is a
  // surprising thing to land on after signing in.
  servers.sort((a, b) => Number(b.owned) - Number(a.owned));

  for (const s of servers) {
    const conn = pickConnection(s);
    if (!conn) continue;
    return {
      profileId: "owner",
      profileName: "",
      token: s.accessToken || accountToken,
      serverId: s.clientIdentifier,
      serverName: s.name,
      baseUrl: conn.uri,
      location: conn.location,
    };
  }
  return null;
}

/** Household members on the account. Switching to one may need its own PIN. */
export async function listHomeUsers(
  id: PlexIdentityHeaders,
  accountToken: string,
): Promise<{ id: string; name: string; thumb?: string; pinRequired: boolean }[]> {
  // The home endpoints are v1; there is no v2 equivalent.
  const body = await request<unknown>(PLEX_TV, "api/home/users", id, { token: accountToken });
  const users = (container<{ users?: unknown[] }>(body).users ?? []) as {
    id: number | string;
    title?: string;
    username?: string;
    thumb?: string;
    protected?: boolean;
  }[];
  return users.map((u) => ({
    id: String(u.id),
    name: u.title || u.username || String(u.id),
    thumb: u.thumb,
    pinRequired: Boolean(u.protected),
  }));
}

/** Switch to a household member, verifying their PIN when they have one. */
export async function switchHomeUser(
  id: PlexIdentityHeaders,
  accountToken: string,
  userId: string,
  pin?: string,
): Promise<string> {
  const body = await request<{ authToken?: string; user?: { authToken?: string } }>(
    PLEX_TV,
    `api/home/users/${encodeURIComponent(userId)}/switch`,
    id,
    { method: "POST", token: accountToken, query: pin ? { pin } : undefined },
  );
  const token = body.authToken || body.user?.authToken;
  if (!token) throw new Error("switch returned no token");
  return token;
}
