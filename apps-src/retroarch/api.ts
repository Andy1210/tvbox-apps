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
