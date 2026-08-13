// Loading artwork without putting the account token in the page.
//
// A media server wants the token on every request, and an <img src> cannot carry
// a header - so the obvious poster URL has the credential in it. That URL then
// lives in the DOM, in the accessibility tree, in any dump of the page, and in
// whatever the app later reports as "now playing", which on this box is a
// retained MQTT topic other things read. The window also runs without context
// isolation, so anything that can read the DOM can already do a great deal.
//
// The server accepts the token as a header on a cross-origin request, so the
// image is fetched rather than linked and handed to <img> as a blob. The token
// never reaches markup.
//
// The cache is small and bounded because these are decoded frames, not bytes: a
// full-size poster costs a large decode and tens of megabytes resident, which is
// exactly what a grid of them does to a small box.

import { log } from "./redact";

const MAX_ENTRIES = 240;

interface Entry {
  objectUrl: string;
  /** Bumped on every use so eviction can drop the coldest. */
  used: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<string | null>>();
let clock = 0;

function evictIfNeeded(): void {
  if (cache.size <= MAX_ENTRIES) return;
  const victims = [...cache.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, cache.size - MAX_ENTRIES);
  for (const [key, entry] of victims) {
    URL.revokeObjectURL(entry.objectUrl);
    cache.delete(key);
  }
}

/**
 * Fetch an image with auth and return a blob URL for it, or null when it cannot
 * be had. A missing poster is never an error - the tile falls back to a title.
 */
export async function loadImage(url: string, headers: Record<string, string>): Promise<string | null> {
  const hit = cache.get(url);
  if (hit) {
    hit.used = ++clock;
    return hit.objectUrl;
  }

  const running = inflight.get(url);
  if (running) return running;

  const task = (async () => {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      const blob = await res.blob();
      // Two requests for the same poster can finish together; keep the first.
      const existing = cache.get(url);
      if (existing) return existing.objectUrl;
      const objectUrl = URL.createObjectURL(blob);
      cache.set(url, { objectUrl, used: ++clock });
      evictIfNeeded();
      return objectUrl;
    } catch (e) {
      log.warn("poster failed", url, e);
      return null;
    } finally {
      inflight.delete(url);
    }
  })();

  inflight.set(url, task);
  return task;
}

/** Drop everything. Called when the session changes, so one account's artwork
 *  is not shown to the next. */
export function clearImages(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.objectUrl);
  cache.clear();
  inflight.clear();
}

/** Test seam. */
export function __imageCacheSize(): number {
  return cache.size;
}
