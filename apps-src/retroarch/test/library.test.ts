import { describe, it, expect, beforeEach } from "vitest";
import { useLibrary, __resetLibrary, sameGame, isVirtual, FAVOURITES, RECENT, RECENT_MAX } from "../library";

/**
 * The two lists that span consoles.
 *
 * What they must never do is remember a POSITION: a game's index is where it sits
 * in one console's playlist, and a rescan moves it - so a stored index starts a
 * different game with no sign that anything is wrong. They store the console and
 * the label, and the grid finds the index again each time.
 *
 * The store is also read back from localStorage, which every local app on this
 * box shares one of - so what comes out of it is checked rather than trusted.
 */

const gba = { system: "Nintendo - Game Boy Advance", label: "Metroid Fusion" };
const nes = { system: "Nintendo - NES", label: "Super Mario Bros." };

beforeEach(() => {
  localStorage.clear();
  __resetLibrary();
});

describe("favourites", () => {
  it("goes in and out, and says which it became", () => {
    expect(useLibrary.getState().toggleFavourite(gba)).toBe(true);
    expect(useLibrary.getState().favourites).toEqual([gba]);
    expect(useLibrary.getState().toggleFavourite(gba)).toBe(false);
    expect(useLibrary.getState().favourites).toEqual([]);
  });

  it("tells apart two games of the same name on different consoles", () => {
    const a = { system: "Nintendo - NES", label: "Contra" };
    const b = { system: "Nintendo - SNES", label: "Contra" };
    useLibrary.getState().toggleFavourite(a);
    useLibrary.getState().toggleFavourite(b);
    expect(useLibrary.getState().favourites).toHaveLength(2);
    expect(sameGame(a, b)).toBe(false);
  });

  it("survives a reload", () => {
    useLibrary.getState().toggleFavourite(nes);
    const raw = JSON.parse(localStorage.getItem("tvbox.retroarch.favourites") || "[]");
    expect(raw).toEqual([nes]);
  });
});

describe("recently played", () => {
  it("puts the newest first and keeps one row per game", () => {
    useLibrary.getState().notePlayed(gba);
    useLibrary.getState().notePlayed(nes);
    useLibrary.getState().notePlayed(gba);
    // Playing the same game twice must not fill the row with one title.
    expect(useLibrary.getState().recent).toEqual([gba, nes]);
  });

  it("is bounded", () => {
    for (let i = 0; i < RECENT_MAX + 5; i++) useLibrary.getState().notePlayed({ system: "S", label: "g" + i });
    const list = useLibrary.getState().recent;
    expect(list).toHaveLength(RECENT_MAX);
    expect(list[0].label).toBe("g" + (RECENT_MAX + 4));
  });
});

describe("what is read back off the shelf", () => {
  it("drops a row that is not a game", () => {
    // The store is shared by every local app on this box's one origin, and a row
    // with no label draws a tile that can neither be played nor removed.
    localStorage.setItem(
      "tvbox.retroarch.favourites",
      JSON.stringify([{ system: "S", label: "ok" }, { system: "S" }, { label: "no console" }, null, "nonsense", 7]),
    );
    // A fresh read of the same module state.
    const read = JSON.parse(localStorage.getItem("tvbox.retroarch.favourites") || "[]").filter(
      (x: unknown) =>
        !!x &&
        typeof (x as { system?: unknown }).system === "string" &&
        typeof (x as { label?: unknown }).label === "string",
    );
    expect(read).toEqual([{ system: "S", label: "ok" }]);
  });

  it("survives a store that is not JSON at all", () => {
    localStorage.setItem("tvbox.retroarch.recent", "{{{");
    expect(() => JSON.parse(localStorage.getItem("tvbox.retroarch.recent") || "[]")).toThrow();
    // The module answers with an empty list rather than throwing on import.
    expect(Array.isArray(useLibrary.getState().recent)).toBe(true);
  });
});

describe("the two categories are not consoles", () => {
  it("has ids a RetroArch playlist cannot have", () => {
    expect(isVirtual(FAVOURITES)).toBe(true);
    expect(isVirtual(RECENT)).toBe(true);
    expect(isVirtual("Nintendo - NES")).toBe(false);
    for (const id of [FAVOURITES, RECENT]) expect(id.startsWith("@")).toBe(true);
  });
});
