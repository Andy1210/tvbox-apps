/// <reference types="vite/client" />

// The Xbox Cloud Gaming app talks to its own plugin over same-origin HTTP
// (/tvbox/api/xcloud/*) and renders the stream itself with WebRTC, so it does NOT
// use the shell's mpv player. From the bridge it needs only navigation: home() to
// leave, which on this screen is also the way out of a running stream.
interface TvboxBridgeGlobal {
  launch(appId: string): void;
  home(): void;
  onNotify?(cb: (n: unknown) => void): () => void;
  onCommand?(cb: (cmd: { action: string; app?: string }) => void): () => void;
}

interface Window {
  tvbox?: TvboxBridgeGlobal;
}
