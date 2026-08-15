import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Unit tests for the app UIs under apps-src/. One config for the whole registry
// rather than one per app: each app's own vite.config.ts pins `root` to its
// source dir for the BUILD, which a shared runner must not inherit.
//
// Mirrors the launcher's test setup (happy-dom, globals, jest-dom matchers) and
// repeats the @sdk alias + dedupe every app build uses, so a component under
// test resolves the shared SDK and a single React exactly as it does in the
// bundle. The alias is one level shallower here than in the per-app configs,
// because this file sits at the registry root.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@sdk": path.resolve(__dirname, "../app-sdk/src") },
    dedupe: ["react", "react-dom", "zustand", "@noriginmedia/norigin-spatial-navigation"],
  },
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["apps-src/**/*.test.{ts,tsx}"],
    setupFiles: ["./apps-src/mediaclient/test/setup.ts"],
  },
});
