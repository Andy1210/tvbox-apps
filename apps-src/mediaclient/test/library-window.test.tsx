import { describe, it, expect, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Library } from "../Library";
import { useApp } from "../state";
import { clearLibraryViews } from "../libraryView";
import { setupRemote, setFocus, remote } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaBackend, MediaItem } from "../backends/types";

// How much of the grid can be seen, and where it may stop.
//
// The grid moves itself with a transform, so nothing else clamps it: a browser
// re-clamps a scroller when its content or its box changes and there is no
// scroller here. Two numbers therefore have to be right on their own.
//
// The window is NOT the grid. The grid is the flex child below the header, and
// measuring it as `window.innerHeight` moved every row that far too little -
// the row under the cursor sat with its caption cut off by the screen edge, and
// the end clamp left the last rows unreachable however long you pressed down.
//
// The letter jump is the one move that does not go through `nearest`, so it was
// the one move with no end clamp at all: a letter inside the last screenful
// translated the grid past its end and left most of the screen black.
//
// Both are checked through the real screen rather than against the helpers,
// because both bugs were in the CALLER of a helper that was correct.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const WINDOW_H = 1080;
/** What the header leaves for the grid on the box, measured there. */
const GRID_H = 983;
/**
 * The clip's own vertical padding, pt-[1.2vh] and pb-[2vh] at this height.
 *
 * Placed explicitly because happy-dom resolves a class to no padding at all:
 * without it the subtraction under test is multiplied by zero and the numbers
 * below would agree with a version that never did it.
 */
const PAD_TOP = 13;
const PAD_BOTTOM = 22;
/** What is actually visible: `overflow` clips at the padding box. */
const VIEWPORT = GRID_H - PAD_TOP - PAD_BOTTOM;
/** Must match Library.tsx. */
const TILE_VH = 26;
const ROW_GAP_VH = 8;
const COLUMNS = 7;
const ITEMS = 259;

const rowHeight = Math.round(WINDOW_H * ((TILE_VH + ROW_GAP_VH) / 100));
const rows = Math.ceil(ITEMS / COLUMNS);

function item(n: number): MediaItem {
  return { id: `i${n}`, kind: "movie", title: `Film ${n}`, thumb: `/t/${n}` };
}

/** The last letter's first item sits inside the final screenful. */
const LAST_LETTER_OFFSET = ITEMS - 3;

function stubBackend(): MediaBackend {
  return {
    kind: "plex",
    libraryPage: async (_id: string, q: { offset: number; limit: number }) => ({
      total: ITEMS,
      items: Array.from({ length: Math.max(0, Math.min(q.limit, ITEMS - q.offset)) }, (_, i) => item(q.offset + i)),
    }),
    collections: async () => ({ total: 0, items: [] }),
    letters: async () => [
      { key: "A", title: "A", size: ITEMS - 3 },
      { key: "Z", title: "Z", size: 3 },
    ],
    letterOffset: async (_id: string, key: string) => (key === "Z" ? LAST_LETTER_OFFSET : 0),
    sorts: async () => [],
    filterOptions: async () => [],
    posterUrl: () => undefined,
    imageHeaders: () => ({}),
  } as unknown as MediaBackend;
}

/**
 * The clip, and how tall it is.
 *
 * happy-dom has no layout engine, so the height the component measures has to be
 * placed here. It is defined on the element rather than on the prototype so the
 * window keeps its own value: the whole point is that the two differ.
 */
function sizeGrid(container: HTMLElement, height: number): HTMLElement {
  const layer = container.querySelector<HTMLElement>("[style*='will-change']");
  const clip = layer?.parentElement;
  if (!clip) throw new Error("the grid's clip is not in the tree");
  Object.defineProperty(clip, "clientHeight", { value: height, configurable: true });
  clip.style.paddingTop = `${PAD_TOP}px`;
  clip.style.paddingBottom = `${PAD_BOTTOM}px`;
  return clip;
}

/** What the moving layer has been translated to, in px. */
function offsetOf(container: HTMLElement): number {
  const layer = container.querySelector<HTMLElement>("[style*='will-change']");
  const m = /translateY\((-?[\d.]+)px\)/.exec(layer?.style.transform ?? "");
  return m ? -Number(m[1]) : 0;
}

beforeEach(async () => {
  // A library remembers how it was left; these mount the same one.
  clearLibraryViews();
  useApp.setState({ backend: stubBackend(), screen: { name: "home" }, history: [], failure: null });
  window.innerHeight = WINDOW_H;
  await act(async () => setFocus(""));
});

describe("the library's window", () => {
  it("measures the grid, not the window", async () => {
    const { container } = render(<Library libraryId="1" title="Movies" />);
    await waitFor(() => expect(container.querySelector("[style*='will-change']")).toBeTruthy());
    const clip = sizeGrid(container, GRID_H);
    // A resize is what the component listens to; the grid's own size changed.
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });

    // Jump to the end, which is clamped to `max - viewport` - so the number it
    // stops at IS the viewport it believes in.
    await pressLetterZ(container);
    await waitFor(() => expect(offsetOf(container)).toBeGreaterThan(0));

    expect(offsetOf(container)).toBe(rows * rowHeight - VIEWPORT);
    // Not the window's height: that is the old bug, and it is 97 px away.
    expect(offsetOf(container)).not.toBe(rows * rowHeight - WINDOW_H);
    expect(clip.clientHeight).toBe(GRID_H);
  });

  it("does not translate the grid past its last row on a letter jump", async () => {
    const { container } = render(<Library libraryId="1" title="Movies" />);
    await waitFor(() => expect(container.querySelector("[style*='will-change']")).toBeTruthy());
    sizeGrid(container, GRID_H);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });

    await pressLetterZ(container);
    await waitFor(() => expect(offsetOf(container)).toBeGreaterThan(0));

    // Where the letter's own row starts - what the unclamped jump used, and
    // what leaves the screen mostly black because there is nothing below it.
    const unclamped = Math.floor(LAST_LETTER_OFFSET / COLUMNS) * rowHeight;
    expect(offsetOf(container)).toBeLessThan(unclamped);
    expect(offsetOf(container)).toBe(rows * rowHeight - VIEWPORT);
  });

  it("marks the letter that was pressed, even when the grid cannot move", async () => {
    // In a library that fits on screen the grid does not move at all, so the
    // mark is the whole of the feedback - and it stayed on the first letter
    // while the press appeared to do nothing.
    const { container } = render(<Library libraryId="1" title="Movies" />);
    await waitFor(() => expect(container.querySelector("[style*='will-change']")).toBeTruthy());
    sizeGrid(container, GRID_H);
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });

    await pressLetterZ(container);
    await waitFor(() => expect(offsetOf(container)).toBeGreaterThan(0));

    // `font-bold` is the mark and `text-fg-dim` is every other letter. The
    // first version of this assertion accepted either, because `text-fg\b`
    // matches `text-fg-dim` too - so it passed against the bug.
    const letters = Array.from(container.querySelectorAll<HTMLElement>("div")).filter(
      (d) => d.children.length === 0 && /^[A-Z#]$/.test(d.textContent?.trim() ?? ""),
    );
    const marked = letters.filter((d) => /font-bold/.test(d.className));
    expect(marked.map((d) => d.textContent?.trim())).toEqual(["Z"]);
  });
});

/** A letter in the strip, once the strip has arrived. */
function letterEl(container: HTMLElement, key: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>("div")).find(
    (d) => d.children.length === 0 && d.textContent?.trim() === key,
  );
}

/**
 * Press Z in the A-Z strip.
 *
 * Through the remote rather than by clicking: the strip is built from
 * FocusButton, which answers Enter from spatial navigation and has no click
 * handler at all - a clicked test would pass without the screen doing anything.
 */
async function pressLetterZ(container: HTMLElement): Promise<void> {
  // The strip is fetched separately from the first page, so it can arrive after
  // the grid does. Pressing before it exists focuses nothing, and the test then
  // measures a screen that was never asked to move.
  await waitFor(() => expect(letterEl(container, "Z")).toBeTruthy());
  await setFocus("letter-Z");
  await act(async () => {
    await remote.ok();
  });
}
