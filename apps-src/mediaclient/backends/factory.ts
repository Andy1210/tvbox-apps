// Which server a session belongs to, and the one place that decides it.
//
// Three call sites used to name `PlexBackend` directly - boot, sign-in and the
// profile switch - which is three places to forget when a second backend
// exists. They all come through here now, so a session can only ever be opened
// with the backend it was created by.

import { PlexBackend } from "./plex/backend";
import { JellyfinBackend } from "./jellyfin/backend";
import type { MediaBackend, Session } from "./types";
import type { Identity } from "../identity";
import { deviceName } from "../identity";

/**
 * The backend a stored session names.
 *
 * `kind` is optional on the stored shape because sessions written before there
 * was a second backend do not carry it - and those are all Plex, which is why
 * an absent value reads as Plex rather than as an error. Deleting the field on
 * purpose would sign the household out; treating it as unknown would too.
 */
export function backendFor(session: Session, identity: Identity): MediaBackend {
  if (session.kind === "jellyfin") {
    return new JellyfinBackend(session, {
      // The box's own client id serves as the device id: Jellyfin ties a
      // session and its remembered state to it, so it has to be the same value
      // across restarts - which is exactly what this identity guarantees.
      deviceId: identity.clientId,
      deviceName: deviceName(identity.host),
    });
  }
  return new PlexBackend(session, { clientId: identity.clientId, deviceName: deviceName(identity.host) });
}
