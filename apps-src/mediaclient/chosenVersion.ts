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
  /** itemId -> index into that item's `versions`. Insertion order is age. */
  chosen: Record<string, number>;
  load(): Promise<void>;
  /** Remember a version for an item, or forget it when it is the first one. */
  remember(itemId: string, index: number): void;
}

/**
 * Only what a version index can be.
 *
 * The file is on disk and survives an app update; a hand-edited or truncated
 * entry would otherwise be handed to `versions[n]` as a default, which is
 * undefined - and playback then resolves against no part at all.
 */
function sane(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof id !== "string" || !id) continue;
    if (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 100) out[id] = v;
  }
  return out;
}

export const useChosenVersion = create<State>((set, get) => ({
  chosen: {},

  async load() {
    const saved = await readJson<unknown>(KEY);
    if (saved) set({ chosen: sane(saved) });
  },

  remember(itemId, index) {
    const chosen = { ...get().chosen };
    // Zero is not stored, it is the ABSENCE of a choice: the first version is
    // what the app would have picked anyway, so keeping it would fill the map
    // with entries that change nothing and push real choices out of it. Going
    // back to the first version therefore deletes the entry rather than
    // recording it.
    if (index <= 0) delete chosen[itemId];
    else {
      // Re-inserted rather than updated, so choosing again makes it the newest
      // and the cap drops what has genuinely not been touched.
      delete chosen[itemId];
      chosen[itemId] = index;
    }

    const ids = Object.keys(chosen);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX))) delete chosen[id];

    set({ chosen });
    void writeJson(KEY, chosen).then((w) => {
      if (!w.ok) log.warn("version choice not saved");
    });
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
  const at = useChosenVersion.getState().chosen[itemId];
  return at !== undefined && at < count ? at : 0;
}
