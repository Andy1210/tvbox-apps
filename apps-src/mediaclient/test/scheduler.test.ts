import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlaybackScheduler } from "../playback/scheduler";
import type { MediaBackend, PlaybackState } from "../backends/types";

// One scheduler owns every clock that runs during playback. These tests pin the
// three properties the rest of the app depends on: reports are throttled rather
// than fired per position event, a flush reports everything at once, and the end
// of an item always leaves the server and the house in a settled state.

function fakeBackend(): MediaBackend & {
  reportProgress: ReturnType<typeof vi.fn>;
  keepAlive: ReturnType<typeof vi.fn>;
  endSession: ReturnType<typeof vi.fn>;
} {
  return {
    reportProgress: vi.fn(async () => {}),
    keepAlive: vi.fn(async () => {}),
    endSession: vi.fn(async () => {}),
  } as unknown as MediaBackend & {
    reportProgress: ReturnType<typeof vi.fn>;
    keepAlive: ReturnType<typeof vi.fn>;
    endSession: ReturnType<typeof vi.fn>;
  };
}

describe("playback scheduler", () => {
  let position = 0;
  let state: PlaybackState = "playing";
  let posted: { state: string }[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    position = 0;
    state = "playing";
    posted = [];
  });
  afterEach(() => vi.useRealTimers());

  const make = (backend: MediaBackend): PlaybackScheduler =>
    new PlaybackScheduler({
      backend,
      position: () => position,
      state: () => state,
      nowPlaying: () => ({ state: state === "paused" ? "paused" : "playing" }),
      postNowPlaying: (r) => posted.push(r),
    });

  it("throttles progress instead of reporting every tick", async () => {
    const backend = fakeBackend();
    const s = make(backend);

    s.start({ itemId: "1", durationMs: 600_000 });
    await vi.advanceTimersByTimeAsync(0);
    const atStart = backend.reportProgress.mock.calls.length;

    // Twelve seconds of ticks. The tick is twice a second, so without throttling
    // this would be two dozen writes to the server for one film.
    await vi.advanceTimersByTimeAsync(12_000);
    s.stopTimer();

    const during = backend.reportProgress.mock.calls.length - atStart;
    expect(during).toBeGreaterThan(0);
    expect(during).toBeLessThanOrEqual(3);
  });

  it("keeps a transcode session alive, and does not when there is none", async () => {
    const withSession = fakeBackend();
    const s1 = make(withSession);
    s1.start({ itemId: "1", durationMs: 600_000, session: "abc" });
    await vi.advanceTimersByTimeAsync(25_000);
    s1.stopTimer();
    expect(withSession.keepAlive).toHaveBeenCalled();
    expect(withSession.keepAlive.mock.calls[0][0]).toBe("abc");

    const direct = fakeBackend();
    const s2 = make(direct);
    // Direct play has no session to keep alive; pinging anyway would be a
    // request per ten seconds for nothing.
    s2.start({ itemId: "1", durationMs: 600_000 });
    await vi.advanceTimersByTimeAsync(25_000);
    s2.stopTimer();
    expect(direct.keepAlive).not.toHaveBeenCalled();
  });

  it("reports the current position on a flush", async () => {
    const backend = fakeBackend();
    const s = make(backend);
    s.start({ itemId: "42", durationMs: 600_000 });
    await vi.advanceTimersByTimeAsync(0);

    position = 123_456;
    state = "paused";
    await s.flush("pause");
    s.stopTimer();

    const last = backend.reportProgress.mock.calls.at(-1);
    expect(last?.[0]).toBe("42");
    expect(last?.[1]).toBe(123_456);
    expect(last?.[3]).toBe("paused");
  });

  it("does not let two flushes overlap", async () => {
    const backend = fakeBackend();
    let open: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    let started = 0;
    backend.reportProgress.mockImplementation(async () => {
      started += 1;
      await gate;
    });

    const s = make(backend);
    s.start({ itemId: "1", durationMs: 1000 });
    s.stopTimer();

    const a = s.flush("pause");
    const b = s.flush("seek");
    open?.();
    await Promise.all([a, b]);

    // A pause and a seek arriving together must not produce two reports racing
    // to be the server's last word about where playback is.
    expect(started).toBe(1);
  });

  it("ends with a stopped report, an idle now-playing and the session released", async () => {
    const backend = fakeBackend();
    const s = make(backend);
    s.start({ itemId: "7", durationMs: 600_000, session: "sess" });
    await vi.advanceTimersByTimeAsync(0);
    position = 599_000;

    await s.end();

    const last = backend.reportProgress.mock.calls.at(-1);
    expect(last?.[3]).toBe("stopped");
    // A retained "playing" outlives the app: the house keeps seeing it, and the
    // box's own idle gate stays open behind it.
    expect(posted.at(-1)?.state).toBe("idle");
    expect(backend.endSession).toHaveBeenCalledWith("sess");
    expect(s.active).toBe(false);
  });

  it("says nothing more about what is playing once it has ended", async () => {
    // `idle` has to be the LAST word. The payload is retained by the box and read
    // by the house, so a now-playing that lands after it goes on announcing a
    // film that has stopped - until something else plays. Two ways in, and this
    // covers both: a flush whose report was still in flight when the item ended,
    // and a flush that arrives afterwards.
    //
    // Reachable in one gesture now that Back leaves the film on the first press:
    // `stop()` awaits the final report and the session release with the key
    // handler still mounted, so Back and then an arrow is enough.
    const backend = fakeBackend();
    let open: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    backend.reportProgress.mockImplementationOnce(async () => {
      await gate;
    });

    const s = make(backend);
    s.start({ itemId: "7", durationMs: 600_000, session: "sess" });
    await vi.advanceTimersByTimeAsync(0);
    posted.length = 0;

    const inFlight = s.flush("seek");
    await s.end();
    open?.();
    await inFlight;
    // And one that starts after the end, which is the same mistake a moment later.
    await s.flush("pause");

    expect(posted.at(-1)?.state).toBe("idle");
    expect(posted.filter((r) => r.state !== "idle")).toEqual([]);
  });

  it("goes silent on release, so the caller's idle is the last word", async () => {
    // The exit that cannot await anything: the shell hides an app's window and
    // sends no teardown signal, so this runs on a visibility event and the page
    // may be frozen immediately after. `flush` was the wrong shape for it - its
    // now-playing lands when the report comes back, i.e. AFTER the idle the
    // caller posts, and re-announces a film nobody is watching. Retained, and
    // read by the house, until something else plays.
    const backend = fakeBackend();
    let open: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    backend.reportProgress.mockImplementation(async () => {
      await gate;
    });

    const s = make(backend);
    s.start({ itemId: "7", durationMs: 600_000, session: "sess" });
    await vi.advanceTimersByTimeAsync(0);
    posted.length = 0;
    position = 120_000;

    // What `onRelease` does, in its order: fire the last report, then say idle.
    s.release();
    posted.push({ state: "idle" });

    // The report went out - the position is not lost - and it went out for THIS
    // item, with the state it was really in.
    const last = backend.reportProgress.mock.calls.at(-1);
    expect(last?.[0]).toBe("7");
    expect(last?.[1]).toBe(120_000);
    // "stopped", not the live state: the shell has already killed the player by
    // the time this runs, and the caller releases the session next. A last word
    // of "playing" leaves the server holding a session nobody is watching.
    expect(last?.[3]).toBe("stopped");

    // Now let it come back, and let the ticker run on.
    open?.();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(posted.at(-1)?.state).toBe("idle");
    expect(posted.filter((r) => r.state !== "idle")).toEqual([]);
    // And nothing goes on reporting a film the box has already killed.
    const after = backend.reportProgress.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(backend.reportProgress.mock.calls.length).toBe(after);
    expect(s.active).toBe(false);
  });

  it("still ends cleanly when the final report is refused", async () => {
    const backend = fakeBackend();
    backend.reportProgress.mockRejectedValue(new Error("server said no"));
    const s = make(backend);
    s.start({ itemId: "7", durationMs: 1000, session: "sess" });
    await vi.advanceTimersByTimeAsync(0);

    await expect(s.end()).resolves.toBeUndefined();
    // The transcode session is the expensive thing to leak, so it must be
    // released even when the progress report before it failed.
    expect(backend.endSession).toHaveBeenCalledWith("sess");
    expect(posted.at(-1)?.state).toBe("idle");
  });
});
