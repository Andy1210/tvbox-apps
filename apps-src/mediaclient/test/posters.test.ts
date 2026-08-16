import { describe, it, expect, vi, afterEach } from "vitest";
import { loadImage, clearImages } from "../posters";

// How many pictures the box asks for at once, and whose pictures they are.
//
// A grid landing mounts seven columns of several rows in one tick, so the bound
// is what stops the browser opening thirty connections and losing some of them.
// Two ways it failed, both invisible: the count could drift past the limit
// during exactly that burst, and a request queued behind the limit could start
// AFTER somebody signed out - sending the previous account's headers to a
// server the box has left.

const blob = (): Blob => new Blob(["x"], { type: "image/jpeg" });

afterEach(() => {
  vi.unstubAllGlobals();
  clearImages();
});

describe("the number of images in flight", () => {
  it("never goes past the limit, even for one arriving as another finishes", async () => {
    // The drift lived in ONE microtask: the count was given back first and
    // taken again later, so a caller reaching the semaphore between the two saw
    // a free slot that was already promised to a waiter.
    //
    // That window cannot be hit by queueing work from outside - it opens and
    // closes inside the loader. It is reached here through the stubbed
    // `createObjectURL`, which the loader calls immediately before it gives the
    // slot back: a microtask queued there runs after the release and before the
    // waiter resumes, which is exactly where a scrolling grid's next tile lands.
    let inFlight = 0;
    let peak = 0;
    const finish: (() => void)[] = [];
    const all: Promise<string | null>[] = [];
    let extra = 0;

    vi.stubGlobal("fetch", async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => finish.push(r));
      inFlight -= 1;
      return new Response(blob(), { status: 200 });
    });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: () => {
        if (extra < 6) {
          const n = extra++;
          queueMicrotask(() => all.push(loadImage(`http://s/late${n}`, {})));
        }
        return "blob:x";
      },
      revokeObjectURL: () => {},
    });

    // Six in flight, six waiting.
    for (let i = 0; i < 12; i += 1) all.push(loadImage(`http://s/first${i}`, {}));
    await new Promise((r) => setTimeout(r, 0));

    for (let round = 0; round < 12; round += 1) {
      finish.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    while (finish.length) {
      finish.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(all);

    expect(peak).toBeLessThanOrEqual(6);
  });
});

describe("an image queued behind the limit", () => {
  it("is not fetched at all once the box has signed out", async () => {
    const asked: string[] = [];
    const finish: (() => void)[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(String(url));
      await new Promise<void>((r) => finish.push(r));
      return new Response(blob(), { status: 200 });
    });
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => {} });

    // Six fill the slots; the seventh waits.
    const first = Array.from({ length: 6 }, (_, i) => loadImage(`http://s/a${i}`, { "X-Token": "old" }));
    const queued = loadImage("http://s/queued", { "X-Token": "old" });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toHaveLength(6);

    // Somebody signs out while it is still waiting.
    clearImages();
    finish.forEach((f) => f());
    await Promise.all([...first, queued]);

    expect(asked, "the queued one must never go out under the old credential").not.toContain("http://s/queued");
    await expect(queued).resolves.toBeNull();
  });
});

describe("a poster that falls out of the cache", () => {
  it("is given back, not left alive for the life of the window", async () => {
    // A blob URL is held by the origin's store until it is revoked - the browser
    // does not reclaim it. Measured before this: a thousand posters left a
    // thousand alive with 240 in the cache, which on this library is about
    // 155 MB stranded for as long as the window exists. And the shell HIDES the
    // window when the app is left rather than destroying it, so it accumulates.
    vi.useFakeTimers();
    const revoked: string[] = [];
    let made = 0;
    vi.stubGlobal("fetch", async () => new Response(blob(), { status: 200 }));
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: () => `blob:${++made}`,
      revokeObjectURL: (u: string) => revoked.push(u),
    });

    // Past the cache's own size, so the coldest ones are dropped.
    for (let i = 0; i < 300; i += 1) {
      await loadImage(`http://s/p${i}`, {});
    }
    expect(revoked, "not while an <img> may still be decoding it").toHaveLength(0);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(revoked.length, "the evicted ones are handed back").toBeGreaterThan(0);
    vi.useRealTimers();
  });
});

