// Signing into a Jellyfin server from a TV.
//
// Jellyfin's Quick Connect is the same shape as Plex's link code and is used for
// the same reason: this box has no keyboard, and a password typed on an on-screen
// grid is a minute of work that a six-digit code turns into ten seconds.
//
// The two differences from the Plex flow are worth stating, because they change
// what the screen can promise:
//
//  - There is no account service. The person types the code into the Jellyfin
//    web interface of THIS server, so the address is part of the instruction.
//    An unreachable server has no cloud to fall back on.
//  - Quick Connect can be switched off by an administrator, and then this whole
//    path is unavailable rather than merely slower. `quickConnectAvailable()`
//    asks first so the screen can say so instead of showing a code the server
//    will never accept.

import { request, type JellyfinIdentity } from "./http";
import type { DeviceLogin, Profile, Session } from "../types";
import { log } from "../../redact";

/** The code expires server-side; Jellyfin's own default is five minutes. */
const CODE_TTL_MS = 5 * 60 * 1000;
/** Long enough not to hammer a server, short enough to feel immediate. */
const POLL_MS = 2000;

interface QuickConnectState {
  Authenticated: boolean;
  Secret: string;
  Code: string;
}

interface AuthResult {
  AccessToken: string;
  ServerId?: string;
  User: { Id: string; Name: string };
}

interface PublicInfo {
  ServerName?: string;
  Id?: string;
  Version?: string;
  StartupWizardCompleted?: boolean;
}

/** What the server calls itself, asked before anyone has signed in. */
export async function serverInfo(base: string, id: JellyfinIdentity, signal?: AbortSignal): Promise<PublicInfo> {
  return request<PublicInfo>(base, "System/Info/Public", id, { signal });
}

export async function quickConnectAvailable(
  base: string,
  id: JellyfinIdentity,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    // The answer is a bare JSON boolean, so it arrives as `true`, not `{...}`.
    const on = await request<unknown>(base, "QuickConnect/Enabled", id, { signal });
    return on === true;
  } catch (e) {
    log.warn("could not ask about quick connect", e);
    return false;
  }
}

/**
 * Start a Quick Connect sign-in.
 *
 * `poll` resolves with a session once somebody approves the code in the web
 * interface, and with null once the code has expired - the caller shows a fresh
 * one rather than leaving a dead number on the television.
 */
export async function beginQuickConnect(
  base: string,
  id: JellyfinIdentity,
  signal?: AbortSignal,
): Promise<DeviceLogin> {
  const started = await request<QuickConnectState>(base, "QuickConnect/Initiate", id, { method: "POST", signal });
  const startedAt = Date.now();

  const poll = async (sig?: AbortSignal): Promise<Session | null> => {
    for (;;) {
      if (Date.now() - startedAt > CODE_TTL_MS) return null;
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (sig?.aborted) return null;

      let state: QuickConnectState;
      try {
        state = await request<QuickConnectState>(base, "QuickConnect/Connect", id, {
          query: { Secret: started.Secret },
          signal: sig,
        });
      } catch (e) {
        // A 404 here is the server having forgotten the request, which is what
        // an expired code looks like from this end. Anything else is worth one
        // more turn of the loop: the box is often waiting on a server that is
        // still starting up.
        const status = (e as { status?: number }).status;
        if (status === 404 || status === 400) return null;
        log.warn("quick connect poll failed", e);
        continue;
      }
      if (!state.Authenticated) continue;

      const auth = await request<AuthResult>(base, "Users/AuthenticateWithQuickConnect", id, {
        method: "POST",
        body: { Secret: started.Secret },
        signal: sig,
      });
      const info = await serverInfo(base, id, sig).catch(() => ({}) as PublicInfo);
      return {
        profileId: auth.User.Id,
        profileName: auth.User.Name,
        token: auth.AccessToken,
        // The same token twice, and that is not an oversight: a Jellyfin user IS
        // an account, so there is no second credential that enumerates a
        // household the way Plex's account token does. See `listUsers`.
        accountToken: auth.AccessToken,
        serverId: auth.ServerId || info.Id || "",
        serverName: info.ServerName || "Jellyfin",
        baseUrl: base,
        location: "lan",
      };
    }
  };

  return {
    code: started.Code,
    // Where the code is typed: this server's own web interface, under the user
    // menu. Written out rather than left to the person to find, because the
    // screen showing it is the only instruction they get.
    url: `${base.replace(/\/$/, "")}/web/#/quickconnect`,
    poll,
  };
}

/**
 * Who else is on this server.
 *
 * Not a household under one account, which is what the profile picker was built
 * for: a Jellyfin user is a separate account with its own password, and one
 * user's token cannot enumerate the others - `/Users` is administrators only.
 * So the list is the user who signed in, plus whoever the server has chosen to
 * advertise on its own login screen (`/Users/Public`, often empty, and a
 * deliberate setting rather than a default).
 *
 * Switching to one of those means signing in as them, which this flow cannot do
 * silently. The picker therefore offers the signed-in user alone, and the
 * screen sends anybody else back to the sign-in.
 */
export function listUsers(session: Session): Profile[] {
  return [{ id: session.profileId, name: session.profileName, pinRequired: false }];
}
