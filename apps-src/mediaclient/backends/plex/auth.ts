// Signing in from a TV: the account shows a short code, the person types it on a
// device that has a keyboard, and the box picks up the token when they do.
//
// Two flows exist and they are not interchangeable. The "strong" code belongs to
// a browser redirect, which a 10-foot client cannot run. The plain one is the
// four-character code typed at plex.tv/link, which is this flow. Asking for a
// strong code here yields something the link page will not accept.

import { PLEX_TV, request, type PlexIdentityHeaders } from "./http";
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

/** Addresses that are private but belong to a container bridge on the server's
 *  own host, not to the network this box is on. */
const CONTAINER_RANGES = [/^172\.(1[6-9]|2\d|3[01])\./, /^10\.88\./, /^10\.89\./];

/**
 * Rank a server's addresses by how likely they are to work from here.
 *
 * "local" in a server's own listing means "this address is on a private
 * network", not "you can reach it". A host running containers advertises its
 * bridge addresses that way too, and those answer only on that host - measured,
 * this household's server offers four of them before the address that actually
 * works. Taking the first local one stores an unreachable address at sign-in and
 * every later request fails as a network error.
 *
 * A local address is still preferred over a remote one, and not for
 * convenience: reached from outside, a server classifies the session as remote
 * and applies its remote bitrate cap, so the same film is throttled even though
 * both ends are in the same room.
 */
export function rankConnections(r: Resource): { uri: string; location: "lan" | "wan" }[] {
  const usable = (r.connections || []).filter((c) => !c.relay && c.uri);
  const score = (c: ResourceConnection): number => {
    if (!c.local) return 3;
    return CONTAINER_RANGES.some((re) => re.test(c.address || "")) ? 2 : 1;
  };
  return [...usable]
    .sort((a, b) => score(a) - score(b))
    .map((c) => ({ uri: c.uri, location: c.local ? ("lan" as const) : ("wan" as const) }));
}

/** Kept for callers that only want the best guess without probing. */
export function pickConnection(r: Resource): { uri: string; location: "lan" | "wan" } | null {
  return rankConnections(r)[0] ?? null;
}

/**
 * The first ranked address that actually answers.
 *
 * `/identity` is the right probe: it is cheap, needs no token, and a server that
 * answers it will answer everything else.
 */
export async function reachableConnection(
  r: Resource,
  id: PlexIdentityHeaders,
  timeoutMs = 2500,
): Promise<{ uri: string; location: "lan" | "wan" } | null> {
  for (const candidate of rankConnections(r)) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      await request(candidate.uri, "identity", id, { signal: abort.signal });
      return candidate;
    } catch {
      // An address that does not answer is not a failure of the sign-in; the
      // next one along usually does.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
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

      let p: PinResponse;
      try {
        p = await request<PinResponse>(PLEX_TV, `api/v2/pins/${pin.id}`, id, { signal });
      } catch (e) {
        // A single dropped packet must not end a fifteen-minute wait. Over a
        // television's wifi that happens, and starting over with a new code for
        // it is the worst possible answer. A refusal is different: the code is
        // gone and no amount of asking brings it back.
        const status = (e as { status?: number }).status;
        if (status === 401 || status === 403 || status === 404) return null;
        continue;
      }
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
    // Probed rather than guessed: a server advertises every private address its
    // host has, including container bridges that answer only on that host.
    const conn = await reachableConnection(s, id);
    if (!conn) continue;
    return {
      profileId: "owner",
      profileName: "",
      token: s.accessToken || accountToken,
      accountToken,
      serverId: s.clientIdentifier,
      serverName: s.name,
      baseUrl: conn.uri,
      location: conn.location,
    };
  }
  return null;
}

/**
 * Household members on the account. Switching to one may need its own PIN.
 *
 * The v2 endpoint, because the v1 one answers XML whatever the Accept header
 * says - which this client cannot read, so the list would always come back
 * empty. The v2 shape is also flat: `users` sits at the top level rather than
 * inside the usual container.
 *
 * The id carried forward is the uuid, since that is what the switch endpoint
 * takes.
 */
export async function listHomeUsers(
  id: PlexIdentityHeaders,
  accountToken: string,
): Promise<{ id: string; name: string; thumb?: string; pinRequired: boolean }[]> {
  const body = await request<{
    users?: { id?: number | string; uuid?: string; title?: string; username?: string; thumb?: string; protected?: boolean }[];
  }>(PLEX_TV, "api/v2/home/users", id, { token: accountToken });

  return (body.users ?? [])
    .filter((u) => u.uuid)
    .map((u) => ({
      id: String(u.uuid),
      name: u.title || u.username || String(u.id ?? ""),
      thumb: u.thumb,
      pinRequired: Boolean(u.protected),
    }));
}

/** Switch to a household member, verifying their PIN when they have one. */
export async function switchHomeUser(
  id: PlexIdentityHeaders,
  accountToken: string,
  userUuid: string,
  pin?: string,
): Promise<string> {
  const body = await request<{ authToken?: string; user?: { authToken?: string } }>(
    PLEX_TV,
    `api/v2/home/users/${encodeURIComponent(userUuid)}/switch`,
    id,
    { method: "POST", token: accountToken, query: pin ? { pin } : undefined },
  );
  const token = body.authToken || body.user?.authToken;
  if (!token) throw new Error("switch returned no token");
  return token;
}
