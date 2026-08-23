// The plugin's routes. Same origin as this page (the shell serves /xcloud/ and
// /tvbox/api from one server), so no capability and no credentials: every Xbox
// call and every token lives on the other side of these.
const BASE = "/tvbox/api/xcloud";

export interface Title {
  titleId: string;
  productId: string;
  name: string;
  publisher: string;
  tile: string;
  poster: string;
  owned: boolean;
  inputs: string[];
  maxPlaySeconds: number;
  categories: string[];
  hydrated: boolean;
}

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  /** Wall clock, from the plugin - the code outlives this page. */
  expiresAt?: number;
}

export interface Status {
  ok: boolean;
  signedIn: boolean;
  signingIn?: boolean;
  usable?: boolean;
  gamertag?: string;
  market?: string;
  offering?: string;
  region?: string;
  // A sign-in already running in the plugin, so reopening this screen picks the
  // code back up instead of asking Microsoft for a second one.
  pending?: DeviceCode | null;
  // Always an error code, never anything else.
  code?: string;
  error?: string;
}

export interface SessionState {
  ok: boolean;
  active: boolean;
  // Applied by the page to its own SDP offer, so it travels with the session
  // rather than being fetched at the moment it matters.
  quality?: { maxVideoKbps: number; stereo: boolean };
  id?: string;
  state?: string;
  queueSeconds?: number | null;
  queuedFor?: number;
  /** Set when the server ended the session - a quit from the Xbox guide, or a timeout. */
  ended?: string | null;
  code?: string;
  error?: string;
  config?: {
    serverDetails: unknown;
    overrides: Record<string, unknown>;
    keepAliveMs: number;
    noConnectionTimeoutMs: number;
  } | null;
}

// A failed route is a fact the screen has to state, so the code travels with it -
// the plugin's codes are stable and this app picks the Hungarian.
export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!res.ok) throw new ApiError("http_" + res.status, "HTTP " + res.status);
  const body = (await res.json()) as T & { ok?: boolean; code?: string; error?: string };
  if (body && body.ok === false) throw new ApiError(body.code || "error", body.error || "request failed");
  return body;
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const getStatus = () => call<Status>("/status");
export const startSignIn = () => post<DeviceCode>("/signin/start");
export const signInState = () => call<{ state: string; userCode?: string; verificationUri?: string; code?: string; error?: string }>("/signin/state");
export const cancelSignIn = () => post("/signin/cancel");
export const signOut = () => post("/signout");

export interface SettingsValues {
  maxVideoKbps: number;
  stereo: boolean;
  gameLocale: string;
  maxHeight: number;
}

export const getSettings = () =>
  call<{ settings: SettingsValues; allowed: Record<string, unknown> }>("/settings");
export const putSettings = (patch: Partial<SettingsValues>) =>
  post<{ settings: SettingsValues }>("/settings", patch);
export const refreshLibrary = () => post("/library/refresh");

// The language goes with every read: the catalogue's categories are localised by
// the server, and the plugin cannot see what language this UI is in.
export const getLibrary = (lang: string) =>
  // `filling` means the first screen is here and the rest is still arriving, so
  // the grid draws now and re-reads - rather than treating fifty titles as the
  // whole library.
  call<{ titles: Title[]; cached: boolean; stale?: boolean; partial: boolean; filling?: boolean }>(
    "/library?lang=" + encodeURIComponent(lang),
  );
export const getRecent = () => call<{ titles: Title[] }>("/recent");
// Game Pass's own curated lists (what was just added, what is about to leave), as
// titles rather than product ids.
export const getCollections = (lang: string) =>
  call<{ collections: Record<string, Title[]> }>("/collections?lang=" + encodeURIComponent(lang));
export const search = (q: string) => call<{ results: Title[] }>("/search?q=" + encodeURIComponent(q));

// The locale travels from the PAGE, because that is the only side that knows it:
// the box's own `config.locale` is unset (measured), and the language the whole
// UI is in lives in a localStorage key the launcher and every local app share -
// which a host-side plugin cannot read. Without it the session, the game and the
// server's own dialogs all came back in English on a Hungarian box.
export const startSession = (titleId: string, width: number, height: number, locale: string) =>
  post<{ id: string; type: string }>("/session/start", { titleId, width, height, locale });
export const sessionState = () => call<SessionState>("/session/state");
export const stopSession = () => post("/session/stop");

// The offer and the candidates pass THROUGH the plugin: the streaming token that
// authenticates them is not something this page ever holds.
export const exchangeSdp = (sdp: string, chat = false) =>
  post<{ answer: { sdp?: string } }>("/session/sdp", { sdp, chat });
export const exchangeIce = (candidate: unknown) =>
  post<{ candidates: Array<{ candidate: string; sdpMid?: string; sdpMLineIndex?: number }> }>("/session/ice", { candidate });
