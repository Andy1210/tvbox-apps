/// <reference types="vite/client" />

// This app drives the shell's shared mpv through `window.tvbox`, injected by the
// shell preload and gated by the manifest's runtime.capabilities ("nav",
// "player", "storage"). Declared here rather than imported from @tvbox/app-sdk
// because the SDK's TvboxBridge type is missing members the preload really
// exposes (selectStreams, setPlayerProp) - and `declare module "@sdk"` would
// SHADOW the aliased source module instead of merging into it.
interface TvboxPlayerEvent {
  type: "playing" | "buffering" | "finished" | "error" | "position" | "duration";
  on?: boolean;
  ms?: number;
  // Why playback ended, when it did not simply run out ("stopped",
  // "tv-standby"). Absent on a natural end - and ALSO absent when mpv fails
  // mid-stream, so `finished` without a reason does not by itself mean the file
  // ran out. See lifecycle.ts for what disambiguates it.
  reason?: string;
}

// One audio/subtitle track of the playing file, as mpv reports it through the
// shell. `id` is an mpv track id (1-based), NOT the 0-based per-type ordinal that
// play()/selectStreams() speak - the two number spaces are not interchangeable.
interface TvboxTrack {
  type: "audio" | "sub";
  id: number;
  lang: string;
  title: string;
  selected: boolean;
}

// Stream choice in 0-based ordinals WITHIN each type. `sub: -1` means "no
// subtitles"; `audio: -1` means "no opinion", not silence. Omitting a field
// entirely is a third state: mpv then honours the container's default flag,
// which is not the same as switching the track off.
interface TvboxStreams {
  audio?: number;
  sub?: number;
  // Must be an http(s) URL - the shell rejects a local path or a blob.
  subFile?: string;
}

interface TvboxBridgeGlobal {
  launch(appId: string): void;
  home(): void;
  // `startPos` (seconds) reaches mpv as its own --start, i.e. before the first
  // frame - which is what a resumed film needs.
  play?(url: string, streams?: TvboxStreams, startPos?: number): void;
  stop?(): void;
  pause?(): void;
  resume?(): void;
  seek?(posSec: number): void;
  tracks?(): Promise<TvboxTrack[]>;
  // Takes an mpv track id from tracks(), or "no"/"auto".
  setTrack?(type: "audio" | "sub", id: number | "no" | "auto"): void;
  // The mid-playback counterpart of play()'s `streams`, in the SAME 0-based
  // ordinal terms. Present on the preload but absent from the SDK's own type.
  selectStreams?(streams: TvboxStreams): Promise<{ ok: boolean }>;
  setPlayerProp?(name: string, value: unknown): Promise<{ ok: boolean }>;
  onPlayer?(cb: (ev: TvboxPlayerEvent) => void): () => void;
  // Media transport forwarded from MQTT (voice, Home Assistant). Note the shell
  // handles `seek` entirely on its own and never forwards it.
  onCommand?(cb: (c: { action: string; app?: string }) => void): () => void;
  storage?: {
    get(key: string): Promise<string | null>;
    // Resolves to { ok: false, error } when over quota (256 KB / 200 keys) - it
    // does not throw, so an unchecked write is a silent drop.
    set(key: string, value: string): Promise<unknown>;
    remove(key: string): Promise<unknown>;
  };
  // Published by this app's own bridge.js: the connected panel's native size, or
  // null when the shell could not determine it. Not part of the SDK surface.
  panel?: { width: number; height: number } | null;
}

interface Window {
  tvbox?: TvboxBridgeGlobal;
}
