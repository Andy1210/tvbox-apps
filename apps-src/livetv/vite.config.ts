import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Standalone build for the Live TV app package. The app is served by the shell
// at /livetv/ (same origin as /tvbox/api), so assets are referenced relatively
// (base: "./"). The build output goes straight into the host-side package at
// apps/livetv/web/ so the registry ships the app's UI alongside its plugin.
//
// Run from the tvbox-apps root: `npm run build:livetv`.
export default defineConfig({
  // The config is loaded with an explicit -c path, so root must be pinned to the
  // app source dir (otherwise it defaults to the invoking cwd, tvbox-apps).
  root: __dirname,
  base: "./",
  plugins: [react(), tailwindcss()],
  // @sdk = the shared @tvbox/app-sdk, consumed as source (no build step). dedupe
  // is REQUIRED so app-sdk's bare react/zustand/etc. imports resolve to this
  // project's single copy — otherwise React sees two instances ("invalid hook
  // call"), since app-sdk has no node_modules of its own.
  resolve: {
    alias: { "@sdk": path.resolve(__dirname, "../../../app-sdk/src") },
    dedupe: ["react", "react-dom", "zustand", "@noriginmedia/norigin-spatial-navigation"],
  },
  build: {
    outDir: path.resolve(__dirname, "../../apps/livetv/web"),
    emptyOutDir: true,
  },
});
