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

/**
 * How much bigger to ask for artwork than the CSS box it goes in.
 *
 * The page is laid out at 1080p while a 4K panel is attached, so a tile that
 * measures 280 CSS pixels is drawn at 560 real ones. Asking for the CSS size
 * gives a soft poster on every tile, which is the single thing that makes a
 * media app look cheap next to the one it replaces. Clamped: past 2x the bytes
 * cost more than the sharpness is worth on this hardware.
 */
export function artworkScale(): number {
  try {
    // Device pixels per CSS pixel, which is exactly what an image request should
    // be scaled by - and it is right whichever way the box is set up, without
    // having to know which.
    //
    // It used to be `panel.height / window.innerHeight`, and on this hardware
    // that is two different things: `panel` is the television's NATIVE mode
    // (3840x2160 here) while the UI is deliberately capped at 1080p, so it
    // returned 2. The framebuffer is 1080p either way - the compositor scans
    // out 1080p and the TV upscales - so those extra pixels are decoded,
    // uploaded as texture, and then thrown away by the downscale.
    //
    // Measured on the box: a poster was fetched at 600x900 for a tile drawn at
    // 187x281, ten times the pixels that reach the screen, and the renderer
    // spent about 100 ms of main thread per row of seven while scrolling.
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
    return Math.min(2, Math.max(1, Number.isFinite(dpr) && dpr > 0 ? dpr : 1));
  } catch {
    return 1;
  }
}

interface Entry {
  objectUrl: string;
  /** Bumped on every use so eviction can drop the coldest. */
  used: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<string | null>>();
let clock = 0;
// Bumped by clearImages so a fetch started under the previous session cannot
// write its result into the cache the next one reads.
let generation = 0;

function evictIfNeeded(): void {
  if (cache.size <= MAX_ENTRIES) return;
  const victims = [...cache.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, cache.size - MAX_ENTRIES);
  for (const [key] of victims) {
    // Dropped, not revoked. The coldest entries are the ones that loaded first,
    // which on a long screen are still on display - revoking one under an <img>
    // that has not finished decoding makes it fail permanently, and a tile that
    // has latched onto a broken image never recovers without a remount. The
    // browser reclaims an unreferenced blob on its own.
    cache.delete(key);
  }
}

/**
 * Fetch an image with auth and return a blob URL for it, or null when it cannot
 * be had. A missing poster is never an error - the tile falls back to a title.
 */
/**
 * How many image fetches may be in flight.
 *
 * A page landing in the grid mounts seven columns of several rows at once, so
 * without a bound the browser opens thirty-odd connections in the same tick and
 * some of them lose - and a poster that lost used to stay lost, because the
 * tile latched onto the failure. Six is enough to keep the pipe full on a LAN
 * without a burst that the server answers by dropping.
 */
const MAX_INFLIGHT = 6;
let active = 0;
const waiting: (() => void)[] = [];

async function slot(): Promise<void> {
  if (active < MAX_INFLIGHT) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  waiting.shift()?.();
}

export async function loadImage(url: string, headers: Record<string, string>): Promise<string | null> {
  const hit = cache.get(url);
  if (hit) {
    hit.used = ++clock;
    return hit.objectUrl;
  }

  const running = inflight.get(url);
  if (running) return running;

  const mine = generation;
  const task = (async () => {
    await slot();
    try {
      // One retry, because the failure this guards against is a burst losing a
      // connection rather than a poster that does not exist - and a 404 comes
      // back as !ok, which is not retried.
      let res = await fetch(url, { headers }).catch(() => null);
      if (!res) res = await fetch(url, { headers }).catch(() => null);
      if (!res || !res.ok) return null;
      const blob = await res.blob();
      // Signed out while this was in flight: the answer belongs to the previous
      // account, and poster URLs repeat across sessions, so caching it would
      // show one household member another one's artwork.
      if (mine !== generation) return null;
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
      release();
      inflight.delete(url);
    }
  })();

  inflight.set(url, task);
  return task;
}

/** Drop everything. Called when the session changes, so one account's artwork
 *  is not shown to the next. */
export function clearImages(): void {
  generation += 1;
  for (const entry of cache.values()) URL.revokeObjectURL(entry.objectUrl);
  cache.clear();
  inflight.clear();
}

/** Test seam. */
export function __imageCacheSize(): number {
  return cache.size;
}
