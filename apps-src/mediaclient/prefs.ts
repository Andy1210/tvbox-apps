// Playback preferences that belong to the box rather than to a film.
//
// Kept out of the player store because they outlive it: they are read before
// anything plays, written from Settings, and applied to every stream afterwards.

import { create } from "zustand";
import { readJson, writeJson } from "./storage";
import { log } from "./redact";

const KEY = "prefs";

/** The home screen's rows, as things that can be ordered and switched off. */
export type HomeRowId = "ondeck" | "recent" | "playlists";

export interface Prefs {
  /** Subtitle size as a multiple of mpv's own default. */
  subScale: number;
  /** Distance from the bottom, in mpv's units. 100 is the default position. */
  subPos: number;
  /** #rrggbb. mpv refuses anything else, and so does the shell's allowlist. */
  subColor: string;
  /**
   * Skip an intro or a credits marker without being asked.
   *
   * Off by default, deliberately: a marker is the server's guess, and one that
   * is a minute out jumps past the opening of an episode with no way to tell
   * what happened. The button is always there for anyone who wants the choice.
   */
  autoSkip: boolean;
  /**
   * Row order, top to bottom.
   *
   * Playlists last by default: an account often has none, and where it has one
   * it is a thing you go looking for rather than the first thing you want to
   * see on opening the app.
   */
  homeRows: HomeRowId[];
  /** Rows switched off entirely. */
  hiddenRows: HomeRowId[];
}

const ROW_IDS: HomeRowId[] = ["ondeck", "recent", "playlists"];

export const DEFAULTS: Prefs = {
  subScale: 1,
  subPos: 100,
  subColor: "#ffffff",
  autoSkip: false,
  homeRows: [...ROW_IDS],
  hiddenRows: [],
};

/** Ranges are the shell's own, from playeropts.js. Out of range means default. */
export function sane(v: Partial<Prefs>): Prefs {
  const num = (x: unknown, lo: number, hi: number, fallback: number): number =>
    typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi ? x : fallback;
  return {
    subScale: num(v.subScale, 0.1, 10, DEFAULTS.subScale),
    subPos: num(v.subPos, 0, 150, DEFAULTS.subPos),
    subColor: typeof v.subColor === "string" && /^#[0-9a-fA-F]{6}$/.test(v.subColor) ? v.subColor : DEFAULTS.subColor,
    // Strictly boolean: a stored "yes-please" is truthy, and auto-skip would run
    // on a value nothing here ever wrote.
    autoSkip: v.autoSkip === true,
    // Rebuilt rather than trusted: a stored order from an older build is
    // missing any row added since, and one from a newer build may name a row
    // this code has never heard of. Known ids in their stored order first, then
    // whatever is new, so a row can be added without anyone losing their order.
    homeRows: [
      ...(Array.isArray(v.homeRows) ? v.homeRows.filter((r) => ROW_IDS.includes(r)) : []),
      ...ROW_IDS.filter((r) => !(Array.isArray(v.homeRows) ? v.homeRows : []).includes(r)),
    ],
    hiddenRows: Array.isArray(v.hiddenRows) ? v.hiddenRows.filter((r) => ROW_IDS.includes(r)) : [],
  };
}

interface PrefsState extends Prefs {
  load(): Promise<void>;
  set<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void>;
}

export const usePrefs = create<PrefsState>((set, get) => ({
  ...DEFAULTS,

  async load() {
    // The stored blob is a cast, not a promise. A hand-edited or corrupted entry
    // otherwise reaches the player verbatim, where the shell refuses each value
    // in silence and subtitles quietly keep mpv's defaults - and `set` then
    // writes the whole corrupt bag back.
    const saved = await readJson<Partial<Prefs>>(KEY);
    if (saved) set(sane(saved));
  },

  async set(key, value) {
    set({ [key]: value } as Pick<Prefs, typeof key>);
    const { subScale, subPos, subColor, autoSkip, homeRows, hiddenRows } = get();
    const w = await writeJson(KEY, { subScale, subPos, subColor, autoSkip, homeRows, hiddenRows });
    if (!w.ok) log.warn("playback preference not saved");
    applySubtitleStyle();
  },
}));

/**
 * Push the subtitle style at the player.
 *
 * Every property is sent on every apply rather than only the one that changed:
 * mpv keeps them per file, so a stream that started before a change would
 * otherwise keep the old style until it was restarted. The shell validates each
 * one against its own allowlist and refuses anything out of range, so a bad
 * value here is dropped rather than passed to mpv.
 */
export function applySubtitleStyle(): void {
  const tv = typeof window !== "undefined" ? window.tvbox : undefined;
  if (!tv?.setPlayerProp) return;
  const { subScale, subPos, subColor } = usePrefs.getState();
  // The shell answers whether it accepted each one. A refusal means the value
  // never reached mpv, and the subtitles are silently at their defaults - the
  // shell's own comment says callers must not read that as success.
  const send = (name: string, value: number | string): void => {
    void Promise.resolve(tv.setPlayerProp?.(name, value)).then((r) => {
      if (r && typeof r === "object" && "ok" in r && !r.ok) log.warn(`player refused ${name}`);
    });
  };
  send("sub-scale", subScale);
  send("sub-pos", subPos);
  send("sub-color", subColor);
}
