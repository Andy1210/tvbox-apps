// App state: who is signed in, which backend answers, and which screen is up.
//
// Deliberately small. The screens hold their own data (a library page, a person's
// credits); what lives here is only what more than one screen needs, plus the
// session, which everything needs.

import { create } from "zustand";
import type { MediaBackend, Session } from "./backends/types";
import { PlexBackend } from "./backends/plex/backend";
import { getIdentity, deviceName, type Identity } from "./identity";
import { readJson, writeJson, removeRaw } from "./storage";
import { clearImages } from "./posters";
import { log } from "./redact";

const SESSION_KEY = "session";
const AUTOLOGIN_KEY = "autologin";

export type Screen =
  | { name: "boot" }
  | { name: "login" }
  | { name: "profiles" }
  | { name: "home" }
  | { name: "library"; libraryId: string; title: string }
  | { name: "item"; itemId: string }
  | { name: "person"; personId: string; personName: string }
  | { name: "search" }
  | { name: "settings" };

/** What went wrong, in terms a person on a sofa can act on. */
export type Failure = { kind: "unreachable" | "signed-out" | "no-server" | "unknown"; detail?: string };

interface State {
  identity: Identity | null;
  session: Session | null;
  backend: MediaBackend | null;
  screen: Screen;
  /** Sign back in as the last profile without asking. Off means the picker. */
  autologin: boolean;
  /** Screens visited, so Back returns rather than exiting the app. */
  history: Screen[];
  failure: Failure | null;

  boot(): Promise<void>;
  chooseProfile(id: string, pin?: string): Promise<void>;
  setAutologin(on: boolean): Promise<void>;
  signIn(session: Session): Promise<void>;
  signOut(): Promise<void>;
  go(screen: Screen): void;
  back(): boolean;
  fail(f: Failure | null): void;
}

export const useApp = create<State>((set, get) => ({
  identity: null,
  session: null,
  backend: null,
  screen: { name: "boot" },
  autologin: true,
  history: [],
  failure: null,

  /**
   * Restore a saved session and go straight to the library. The common case is
   * that nobody has to do anything: a TV that asks its owner to sign in every
   * evening is a TV nobody uses.
   */
  async boot() {
    const identity = await getIdentity();
    set({ identity });

    // A fresh identity means the store came from somewhere else (a backup
    // restored onto different hardware). Anything under the old identity belongs
    // to the other box, tokens included.
    //
    // The removal is checked rather than fired and forgotten: if it fails the
    // credential is still on disk, and on the next boot the identity is no
    // longer fresh - so an unchecked failure here means the box quietly starts
    // using someone else's account token.
    if (identity.fresh) {
      const dropped = await removeRaw(SESSION_KEY);
      if (!dropped.ok) log.warn("could not drop the session carried in from another box");
      set({ screen: { name: "login" } });
      return;
    }

    const saved = await readJson<Session>(SESSION_KEY);
    if (!saved) {
      set({ screen: { name: "login" } });
      return;
    }

    const backend = new PlexBackend(saved, { clientId: identity.clientId, deviceName: deviceName(identity.host) });
    // On by default: a television that asks who is watching every single evening
    // is a television nobody uses. Off is for a household that shares one box
    // and does not want last night's viewer to inherit tonight's watch state.
    const autologin = (await readJson<boolean>(AUTOLOGIN_KEY)) ?? true;
    set({ session: saved, backend, autologin, screen: { name: autologin ? "home" : "profiles" } });

    // Anything this client left running on the server outlives the window that
    // started it, and leaving the app produces no event to clean up on. So the
    // first thing a new run does is tidy after the last one.
    backend.reapOwnSessions().catch(() => {});
  },

  /**
   * Become one of the household's people.
   *
   * The session is written back so the next launch starts as whoever was last
   * chosen - which is what autologin means here, rather than "the account
   * owner".
   */
  async chooseProfile(id, pin) {
    const { backend, identity } = get();
    if (!backend) return;
    const session = await backend.switchProfile(id, pin);
    const profiles = await backend.listProfiles().catch(() => []);
    const named = { ...session, profileName: profiles.find((p) => p.id === id)?.name ?? session.profileName };

    const w = await writeJson(SESSION_KEY, named);
    if (!w.ok) log.warn("profile not persisted; the next launch will ask again");
    // Artwork and everything cached under it belonged to the previous person.
    clearImages();
    set({
      session: named,
      backend: new PlexBackend(named, { clientId: identity!.clientId, deviceName: deviceName(identity!.host) }),
      screen: { name: "home" },
      history: [],
      failure: null,
    });
  },

  async setAutologin(on) {
    const w = await writeJson(AUTOLOGIN_KEY, on);
    if (!w.ok) log.warn("autologin preference not saved");
    set({ autologin: on });
  },

  async signIn(session) {
    const identity = get().identity ?? (await getIdentity());
    const backend = new PlexBackend(session, { clientId: identity.clientId, deviceName: deviceName(identity.host) });
    const w = await writeJson(SESSION_KEY, session);
    if (!w.ok) log.warn("session not persisted; this sign-in will not survive a restart");
    set({ identity, session, backend, screen: { name: "home" }, history: [], failure: null });
  },

  async signOut() {
    const dropped = await removeRaw(SESSION_KEY);
    // The screen returns to sign-in either way - leaving someone looking at a
    // library they asked to leave would be worse - but a credential that
    // survived is worth a line in the log, because the next boot will use it.
    if (!dropped.ok) log.warn("sign-out did not remove the stored session");
    // Artwork is held as blobs; without this the next person to sign in sees the
    // previous account's posters until the cache turns over.
    clearImages();
    set({ session: null, backend: null, screen: { name: "login" }, history: [], failure: null });
  },

  go(screen) {
    set((s) => ({ screen, history: [...s.history, s.screen], failure: null }));
  },

  /** Returns false when there is nowhere to go back to, i.e. Back should exit. */
  back() {
    const { history } = get();
    if (history.length === 0) return false;
    set({ screen: history[history.length - 1], history: history.slice(0, -1), failure: null });
    return true;
  },

  fail(failure) {
    set({ failure });
  },
}));

/** Turn a thrown error into something the screen can show. */
export function classify(e: unknown): Failure {
  const status = (e as { status?: number })?.status;
  if (status === 401 || status === 403) return { kind: "signed-out" };
  if (status === 0) return { kind: "unreachable" };
  return { kind: "unknown", detail: e instanceof Error ? e.message : String(e) };
}
