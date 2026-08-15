// Which file of a title this household actually watches.
//
// A version is not a quality ladder. The 1080p copy of Jurassic World here is a
// side-by-side 3D encode, so the SD one is the right answer for a television
// without glasses - and the app asked again every single time, because the
// choice lived in a component's state and died with the screen.
//
// Kept apart from `prefs` on purpose: preferences are a fixed handful of values
// written from a settings screen, and this is an unbounded map that changes as
// a side effect of pressing play. Sharing a blob would mean rewriting the whole
// settings file on every start of every film.

import { create } from "zustand";
import { readJson, writeJson } from "./storage";
import { log } from "./redact";

const KEY = "chosen-versions";

/**
 * How many titles to remember.
 *
 * Bounded because nothing ever removes an entry: a library of 1,693 films would
 * otherwise grow a permanent record of every one ever started, and this file is
 * read at startup before anything can be shown. The oldest go first, which is
 * the right end to lose - a title watched once, years ago, is exactly the one
 * whose version choice no longer matters.
 */
const MAX = 300;

interface State {
  /** itemId -> index into that item's `versions`. Iteration order IS age. */
  chosen: Map<string, number>;
  load(): Promise<void>;
  /** Remember a version for an item, or forget it when it is the first one. */
  remember(itemId: string, index: number): void;
  /** Forget everything. Rating keys are per-SERVER ids, so another account
   *  signing in would otherwise inherit choices made against a library whose
   *  ids mean something else. */
  clear(): void;
}

/**
 * Only what a version index can be.
 *
 * The file is on disk and survives an app update; a hand-edited or truncated
 * entry would otherwise be handed to `versions[n]` as a default, which is
 * undefined - and playback then resolves against no part at all.
 */
function sane(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0 && v < 100;
  // Pairs are the stored shape. An object is what an older build wrote; its key
  // order is whatever the engine gives, which for these ids is numeric - the
  // bug this format exists to fix - so a migrated file starts with an age
  // ordering that is arbitrary rather than wrong, and corrects itself as titles
  // are chosen again.
  const entries: [unknown, unknown][] = Array.isArray(raw)
    ? (raw as [unknown, unknown][]).filter((e) => Array.isArray(e) && e.length === 2)
    : raw && typeof raw === "object"
      ? Object.entries(raw as Record<string, unknown>)
      : [];
  for (const [id, v] of entries) if (typeof id === "string" && id && ok(v)) out.set(id, v);
  return out;
}

export const useChosenVersion = create<State>((set, get) => ({
  chosen: new Map(),

  async load() {
    const saved = await readJson<unknown>(KEY);
    if (saved) set({ chosen: sane(saved) });
  },

  remember(itemId, index) {
    // A Map, and that is the whole point rather than a preference. Every id here
    // is a Plex rating key - a decimal integer string - and those are ARRAY
    // INDEX keys on a plain object, so `Object.keys` returns them numerically
    // ascending no matter what order they were written in. Delete-and-reinsert
    // was therefore a no-op, and the cap evicted the lowest rating key: the
    // oldest title in the library, rather than the least recently chosen. A Map
    // keeps insertion order for every key shape.
    const chosen = new Map(get().chosen);
    // Zero is not stored, it is the ABSENCE of a choice: the first version is
    // what the app would have picked anyway, so keeping it would fill the map
    // with entries that change nothing and push real choices out of it. Going
    // back to the first version therefore deletes the entry rather than
    // recording it.
    chosen.delete(itemId);
    if (index > 0) chosen.set(itemId, index);

    while (chosen.size > MAX) chosen.delete(chosen.keys().next().value as string);

    set({ chosen });
    void writeJson(KEY, [...chosen]).then((w) => {
      if (!w.ok) log.warn("version choice not saved");
    });
  },

  clear() {
    set({ chosen: new Map() });
    void writeJson(KEY, []);
  },
}));

/**
 * The remembered version for an item, held to what the item actually has.
 *
 * A library can lose a file - the 1080p copy is deleted, the SD one is left -
 * and an index that no longer exists resolves to no part, which fails at the
 * point of playing rather than at the point of reading. Out of range means no
 * memory, not an error.
 */
export function rememberedVersion(itemId: string | undefined, count: number): number {
  if (!itemId) return 0;
  const at = useChosenVersion.getState().chosen.get(itemId);
  return at !== undefined && at < count ? at : 0;
}
