/// <reference types="vite/client" />

// The RetroArch app asks the shell to go HOME (its own Back at the top level) and,
// with the `shares` capability its manifest declares, to bring its own save folders
// from a paired box. The games themselves are started through the plugin's /play
// route, because only the shell may spawn the emulator. Declared for the standalone
// build the same way Live TV declares its (larger) surface.
interface TvboxSharesBridge {
  list(): Promise<{
    ok: boolean;
    peers?: { id: string; name: string }[];
    shares?: { id: string; name: string; present: boolean; on: boolean }[];
  }>;
  pull(peerId: string, shareId: string): Promise<{ ok: boolean; error?: string }>;
}

interface TvboxBridgeGlobal {
  launch(appId: string): void;
  home(): void;
  // Absent on a box whose software predates the capability, or if this app was
  // installed without it - the screen checks rather than assumes.
  shares?: TvboxSharesBridge;
}

interface Window {
  tvbox?: TvboxBridgeGlobal;
}
