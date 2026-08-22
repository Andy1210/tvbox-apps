// Favourites, and what was played recently.
//
// Both are lists of games that span consoles, so they cannot be a playlist index:
// the index a game has is a position in ONE console's playlist and it moves when
// that playlist is rescanned. A game is remembered as its console plus its label,
// which is what the scanner writes and what the grid shows, and is resolved back
// to an index against the live list every time the category is opened. A game
// that has since been removed simply is not there.
//
// localStorage, under the `tvbox.` prefix the box's own backup replays - so these
// travel with a restore, like the console the grid was last left on.

import { create } from "zustand";

export interface GameRef {
  system: string;
  label: string;
}

/** The two categories are pseudo-consoles in the rail. `@` cannot start a
 *  RetroArch playlist name, so neither can collide with a real console. */
export const FAVOURITES = "@favourites";
export const RECENT = "@recent";
export const isVirtual = (system: string): boolean => system === FAVOURITES || system === RECENT;

const FAV_KEY = "tvbox.retroarch.favourites";
const RECENT_KEY = "tvbox.retroarch.recent";
/** How much history is worth keeping - about three rows of covers. */
export const RECENT_MAX = 18;
/** A bound on the other list too: a file nobody meant to grow without end. */
const FAV_MAX = 300;
/** ...and on a single entry, for the same reason - these are read back. */
const MAX_FIELD = 200;

export const sameGame = (a: GameRef, b: GameRef): boolean => a.system === b.system && a.label === b.label;

function read(key: string, cap: number): GameRef[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(raw)) return [];
    // Held to the shape rather than trusted: this store is shared by every local
    // app on the box's one origin, and a row with no label would draw an empty
    // tile that cannot be played or removed.
    return (
      raw
        .filter((x) => x && typeof x.system === "string" && typeof x.label === "string" && x.system && x.label)
        .map((x) => ({ system: String(x.system).slice(0, MAX_FIELD), label: String(x.label).slice(0, MAX_FIELD) }))
        // Bounded on the way IN as well as on the way out, and to the SAME cap
        // each list is written with - `recent` is eighteen, and reading three
        // hundred of them would be eighteen rows on screen and a console
        // playlist read for every one of them. This store is shared by every
        // local app on the box's one origin, and replayed by a restore.
        .slice(0, cap)
    );
  } catch {
    return [];
  }
}

function write(key: string, list: GameRef[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* a full or blocked store costs the memory of the list, not the app */
  }
}

interface LibraryStore {
  favourites: GameRef[];
  recent: GameRef[];
  /** In or out of favourites; returns what it became, for the label to follow. */
  toggleFavourite(ref: GameRef): boolean;
  /** Newest first, once each: starting a game again moves it up rather than
   *  filling the row with one title. */
  notePlayed(ref: GameRef): void;
}

export const useLibrary = create<LibraryStore>((set, get) => ({
  favourites: read(FAV_KEY, FAV_MAX),
  recent: read(RECENT_KEY, RECENT_MAX),

  toggleFavourite(ref) {
    const list = get().favourites;
    const on = !list.some((x) => sameGame(x, ref));
    const next = on ? [ref, ...list].slice(0, FAV_MAX) : list.filter((x) => !sameGame(x, ref));
    write(FAV_KEY, next);
    set({ favourites: next });
    return on;
  },

  notePlayed(ref) {
    const next = [ref, ...get().recent.filter((x) => !sameGame(x, ref))].slice(0, RECENT_MAX);
    write(RECENT_KEY, next);
    set({ recent: next });
  },
}));

/** Tests: start from an empty shelf. */
export function __resetLibrary(): void {
  write(FAV_KEY, []);
  write(RECENT_KEY, []);
  useLibrary.setState({ favourites: [], recent: [] });
}
