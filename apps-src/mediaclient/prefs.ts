// Playback preferences that belong to the box rather than to a film.
//
// Kept out of the player store because they outlive it: they are read before
// anything plays, written from Settings, and applied to every stream afterwards.

import { create } from "zustand";
import { readJson, writeJson } from "./storage";
import { log } from "./redact";

const KEY = "prefs";

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
}

export const DEFAULTS: Prefs = { subScale: 1, subPos: 100, subColor: "#ffffff", autoSkip: false };

interface PrefsState extends Prefs {
  load(): Promise<void>;
  set<K extends keyof Prefs>(key: K, value: Prefs[K]): Promise<void>;
}

export const usePrefs = create<PrefsState>((set, get) => ({
  ...DEFAULTS,

  async load() {
    const saved = await readJson<Partial<Prefs>>(KEY);
    if (saved) set({ ...DEFAULTS, ...saved });
  },

  async set(key, value) {
    set({ [key]: value } as Pick<Prefs, typeof key>);
    const { subScale, subPos, subColor, autoSkip } = get();
    const w = await writeJson(KEY, { subScale, subPos, subColor, autoSkip });
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
  tv.setPlayerProp("sub-scale", subScale);
  tv.setPlayerProp("sub-pos", subPos);
  tv.setPlayerProp("sub-color", subColor);
}
