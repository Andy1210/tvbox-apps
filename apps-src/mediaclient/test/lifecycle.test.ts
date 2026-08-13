import { describe, it, expect, beforeEach, vi } from "vitest";
import { onRelease, onResume, __lifecycle } from "../lifecycle";

// The shell sends no teardown signal, so everything this app owns on a server -
// a transcode session, a progress report, the retained now-playing - is released
// from the page's own visibility transitions. These tests pin the properties the
// callers depend on, because a missed release leaks state the user cannot see.
describe("lifecycle", () => {
  beforeEach(() => __lifecycle.reset());

  it("releases once even when both hide events fire", () => {
    const seen: string[] = [];
    onRelease((reason) => seen.push(reason));

    __lifecycle.release("hidden");
    __lifecycle.release("pagehide");

    // visibilitychange and pagehide can both fire for one teardown; a second
    // transcode stop would be harmless but a second scrobble would not.
    expect(seen).toEqual(["hidden"]);
  });

  it("runs every releaser even when one throws", () => {
    const after = vi.fn();
    onRelease(() => {
      throw new Error("progress flush failed");
    });
    onRelease(after);

    __lifecycle.release("hidden");

    // A failed progress report must not strand the transcode stop behind it.
    expect(after).toHaveBeenCalledOnce();
  });

  it("resumes only after a release, and re-arms for the next one", () => {
    const resumed = vi.fn();
    const released = vi.fn();
    onResume(resumed);
    onRelease(released);

    __lifecycle.resume();
    expect(resumed).not.toHaveBeenCalled();

    __lifecycle.release("hidden");
    __lifecycle.resume();
    expect(resumed).toHaveBeenCalledOnce();

    // Coming back and leaving again is the ordinary case (Home, then re-open).
    __lifecycle.release("hidden");
    expect(released).toHaveBeenCalledTimes(2);
  });

  it("stops calling a releaser once it unregisters", () => {
    const fn = vi.fn();
    const off = onRelease(fn);
    off();

    __lifecycle.release("hidden");

    expect(fn).not.toHaveBeenCalled();
  });
});
