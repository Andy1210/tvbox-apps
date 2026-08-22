// The plugin's routes (apps/retroarch/plugin.js), which are served from the shell's
// own origin - so these are plain relative fetches, no capability broker involved.
// The consoles and covers routes are the very ones the phone pages call.

const BASE = "/tvbox/api/retroarch";

export interface CoreCandidate {
  core: string;
  name: string;
  hits: number;
}

export interface SystemRow {
  system: string;
  games: number;
  withCover: number;
  core: string | null;
  coreName: string | null;
  override: string | null;
  candidates: CoreCandidate[];
}

export interface GameRow {
  i: number;
  label: string;
  cover: boolean;
}

/**
 * A game with the console it belongs to.
 *
 * `i` is a position in ONE console's playlist, so a list that spans consoles -
 * favourites, recently played - has to carry the console beside it or the cover
 * comes from the wrong shelf and the wrong game starts.
 */
export interface Entry extends GameRow {
  system: string;
}

export interface CoreRow {
  core: string;
  label: string; // "Sony - PlayStation (PCSX ReARMed)" - the core's own display_name
  system: string;
  installed: boolean;
  available: boolean;
  updatable: boolean;
}

export interface ArtSystem {
  system: string;
  total: number;
  have: number;
  missing: number;
  unavailable: number | null;
  checkedAt: number | null;
}

export interface ArtProgress {
  running: boolean;
  system: string | null;
  listing: boolean;
  done: number;
  todo: number;
  saved: number;
  failed: number;
  unavailable?: number;
  offline?: boolean;
  stopped?: boolean;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path, { cache: "no-store" });
  if (!r.ok) throw new Error("http " + r.status);
  return (await r.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("http " + r.status);
  return (await r.json()) as T;
}

export const fetchSystems = () => get<{ systems: SystemRow[]; playing: boolean }>("/systems");

export const fetchGames = (system: string) =>
  get<{ system: string; games: GameRow[] }>("/games?system=" + encodeURIComponent(system));

// A cover is a URL, not a fetch: the grid puts it in an <img> and lets Chromium do
// the loading, the caching and the lazy part.
export const coverUrl = (system: string, i: number) => BASE + "/cover?system=" + encodeURIComponent(system) + "&i=" + i;

export const play = (system: string, i: number) =>
  post<{ ok: boolean; error?: string; core?: string; label?: string; rom?: string | null }>("/play", { system, i });

export const setSystemCore = (system: string, core: string | null) =>
  post<{ ok: boolean }>("/system-core", { system, core });

export interface ScanFolder {
  name: string;
  path: string;
  depth: number; // 1 = a folder inside one of the top-level ones (the share's consoles)
  parent?: string;
  folders: string[];
}

// What a folder holds, worked out from the file types in it and what the installed
// emulators claim - shown before a scan runs so it is never a surprise.
export interface ScanInspect {
  folder?: string;
  error?: string;
  games: number;
  already: number;
  ambiguous: number;
  systems: Array<{ system: string; games: number }>;
}

export interface ScanState {
  running: boolean;
  progress: { folder: string; stage: string; matched?: number } | null;
  // `stopped` is a scan that was ended on purpose (the Stop button, or a game
  // starting). It reports ok - nothing failed - but it is NOT a finished scan,
  // so the counts are partial and the second pass may never have run.
  last: {
    ok: boolean;
    stopped?: boolean;
    matched?: number;
    added?: number;
    skipped?: number;
    error?: string;
  } | null;
}

export const fetchScanFolders = () =>
  get<{ romsDir: string; folders: ScanFolder[]; consoles: string[] }>("/scan-folders");
export const inspectFolder = (folder: string) => get<ScanInspect>("/scan-inspect?folder=" + encodeURIComponent(folder));
export const fetchScan = () => get<ScanState>("/scan");
export const startScan = (folder: string, system: string | null) =>
  post<{ ok: boolean; error?: string }>("/scan-start", { folder, system });
export const stopScan = () => post<{ ok: boolean }>("/scan-stop", {});

export const fetchCores = () => get<{ offline: boolean; cores: CoreRow[] }>("/cores");
export const installCore = (core: string) => post<{ ok: boolean; error?: string }>("/core-install", { core });
export const removeCore = (core: string) => post<{ ok: boolean }>("/core-remove", { core });

export const fetchArt = () => get<{ systems: ArtSystem[]; progress: ArtProgress }>("/art");
export const startArt = () => post<{ ok: boolean; started: boolean }>("/art-start", {});
export const stopArt = () => post<{ ok: boolean }>("/art-stop", {});

// The console name a playlist carries is a libretro database name ("Nintendo -
// Game Boy Advance"). The vendor is what every entry of a console shares, so the
// rail shows the part that differs and keeps the whole name for the header.
export function shortSystem(system: string): string {
  const i = system.indexOf(" - ");
  return i < 0 ? system : system.slice(i + 3);
}

// ---- games that live elsewhere on the box ----
// Two APIs meet here. The SHELL knows what the box has mounted (its own folders,
// every plugged-in stick, every network share) and lists a directory inside one
// of those roots; the PLUGIN links a chosen folder into the library. Neither
// copies anything.
export interface LinkedFolder {
  name: string; // the folder's name in the library, and a path segment in every playlist
  path: string;
  present: boolean; // the target is there right now (a stick can be out)
  linked: boolean;
}
export interface BrowseSource {
  id: string;
  kind: "folder" | "removable" | "network";
  name: string;
  path: string | null;
  mounted: boolean;
}
export interface BrowseEntry {
  name: string;
  path: string;
  dir: boolean;
}

export const fetchFolders = () => get<{ folders: LinkedFolder[]; max: number }>("/folders");
export const addFolder = (name: string, path: string) =>
  post<{ ok: boolean; error?: string }>("/folder-add", { name, path });
export const removeFolder = (name: string) => post<{ ok: boolean; error?: string }>("/folder-remove", { name });

// The shell's own browse API. A shell too old to have it answers 404, which is
// reported as `unsupported` rather than as an empty box with no explanation.
export async function fetchSources(): Promise<{ sources: BrowseSource[]; unsupported?: boolean }> {
  try {
    const res = await fetch("/tvbox/api/browse/sources", { cache: "no-store" });
    if (!res.ok) return { sources: [], unsupported: true };
    const d = await res.json();
    return { sources: d.sources || [] };
  } catch {
    return { sources: [], unsupported: true };
  }
}
export async function listFolder(
  path: string,
): Promise<{ ok: boolean; path: string; name: string; parent: string | null; entries: BrowseEntry[] }> {
  const empty = { ok: false, path, name: "", parent: null, entries: [] };
  try {
    const res = await fetch("/tvbox/api/browse/list?path=" + encodeURIComponent(path), { cache: "no-store" });
    if (!res.ok) return empty;
    return await res.json();
  } catch {
    return empty;
  }
}
