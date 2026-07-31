/// <reference types="vite/client" />

// The RetroArch app only ever asks the shell to go HOME (its own Back at the top
// level) - the games themselves are started through the plugin's /play route,
// because only the shell may spawn the emulator. Declared for the standalone build
// the same way Live TV declares its (larger) surface.
interface TvboxBridgeGlobal {
  launch(appId: string): void;
  home(): void;
}

interface Window {
  tvbox?: TvboxBridgeGlobal;
}
