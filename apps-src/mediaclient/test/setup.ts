import "@testing-library/jest-dom/vitest";
import { beforeEach, vi } from "vitest";

// No test reaches the network. Without this the app's own startup probe - it
// asks the shell for the box's hostname - issues a real request against the test
// environment's base URL, which then aborts during teardown and prints a stack
// that reads like a failure. A test that needs an answer stubs fetch itself.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network is not available in tests");
    }),
  );
});
