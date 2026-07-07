/// <reference types="vite/client" />

// The Live TV views drive the shell's shared mpv player and receive its events
// through `window.tvbox`, injected by the shell preload (shell/preload.js) and
// gated by the app's runtime.capabilities (this app has "player","nav","config").
// The launcher declares the same global in its own src/lib/shell.ts; mirrored
// here for the standalone build (the @tvbox/app-sdk `tvbox()` helper reads the
// same object but does not declare the global type).
interface TvboxPlayerEvent {
  type: "playing" | "buffering" | "finished" | "error" | "position" | "duration";
  on?: boolean;
  ms?: number;
}

interface TvboxBridgeGlobal {
  launch(appId: string): void;
  home(): void;
  play?(url: string): void;
  stop?(): void;
  pip?(on: boolean, rect?: { x: number; y: number; w: number; h: number }): void;
  onPlayer?(cb: (ev: TvboxPlayerEvent) => void): () => void;
  onNotify?(cb: (n: unknown) => void): () => void;
  onCommand?(cb: (cmd: { action: string; app?: string }) => void): () => void;
}

interface Window {
  tvbox?: TvboxBridgeGlobal;
}
