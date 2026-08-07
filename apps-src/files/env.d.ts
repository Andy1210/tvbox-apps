/// <reference types="vite/client" />

// This app drives the shell's shared mpv through `window.tvbox`, injected by the
// shell preload (shell/preload.js) and gated by the manifest's
// runtime.capabilities ("player", "storage", "nav"). The launcher declares the
// same global in its own src/lib/shell.ts; mirrored here for the standalone build
// (the @tvbox/app-sdk `tvbox()` helper reads the same object but does not declare
// the global type).
interface TvboxPlayerEvent {
  type: "playing" | "buffering" | "finished" | "error" | "position" | "duration";
  on?: boolean;
  ms?: number;
  // Why playback ended, when it did not simply run out ("stopped",
  // "tv-standby"). A file that ran out earns the next one; a stop does not.
  reason?: string;
}

// One audio/subtitle track of the playing file, as reported by mpv's track-list
// through the shell. `tracks()` resolves to [] when nothing is playing, and is
// missing entirely on shells older than the API.
interface TvboxTrack {
  type: "audio" | "sub";
  id: number;
  lang: string;
  title: string;
  selected: boolean;
}

interface TvboxBridgeGlobal {
  launch(appId: string): void;
  home(): void;
  // `startPos` (seconds) reaches mpv as its own --start, i.e. before the first
  // frame - which is what a resumed film needs. Shells older than the API ignore
  // the argument and start from the beginning.
  play?(url: string, streams?: { audio?: number; sub?: number; subFile?: string }, startPos?: number): void;
  stop?(): void;
  pause?(): void;
  resume?(): void;
  seek?(posSec: number): void;
  tracks?(): Promise<TvboxTrack[]>;
  setTrack?(type: "audio" | "sub", id: number | "no" | "auto"): void;
  onPlayer?(cb: (ev: TvboxPlayerEvent) => void): () => void;
  storage?: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<unknown>;
    remove(key: string): Promise<unknown>;
  };
}

interface Window {
  tvbox?: TvboxBridgeGlobal;
}
