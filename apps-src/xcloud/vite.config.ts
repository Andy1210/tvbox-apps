import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Standalone build for the Xbox Cloud Gaming package. Served by the shell at
// /xcloud/, same origin as /tvbox/api - which is what lets the page reach its own
// plugin with no capability and no credentials, and why assets are relative.
//
// Run from the tvbox-apps root: `npm run build:xcloud`.
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@sdk": path.resolve(__dirname, "../../../app-sdk/src") },
    dedupe: ["react", "react-dom", "zustand", "@noriginmedia/norigin-spatial-navigation"],
  },
  build: {
    outDir: path.resolve(__dirname, "../../apps/xcloud/web"),
    emptyOutDir: true,
  },
});
