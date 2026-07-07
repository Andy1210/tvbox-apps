/// <reference types="vite/client" />

// The Spotify app talks to the shell over same-origin HTTP (/tvbox/api/spotify/*
// + the SSE cast stream) and drives its own transport (librespot), so it does NOT
// use the shell's mpv player. It only needs the universal navigation bridge
// (window.tvbox, injected by the shell preload) — home() to exit and onCommand()
// to route MQTT media keys to Spotify transport (both are ungated "nav"). The
// launcher declares the same global in its own src/lib/shell.ts; mirrored here for
// the standalone build (the @tvbox/app-sdk `tvbox()` helper reads the same object
// but does not declare the global type).
interface TvboxBridgeGlobal {
  launch(appId: string): void;
  home(): void;
  onNotify?(cb: (n: unknown) => void): () => void;
  onCommand?(cb: (cmd: { action: string; app?: string }) => void): () => void;
}

interface Window {
  tvbox?: TvboxBridgeGlobal;
}
