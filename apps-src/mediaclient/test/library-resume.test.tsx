import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Library } from "../Library";
import { useApp } from "../state";
import { clearLibraryViews } from "../libraryView";
import { setupRemote, setFocus, getCurrentFocusKey, flushFocus, remote } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaBackend, MediaItem } from "../backends/types";

// Coming back to a library comes back to where you were.
//
// Opening anything from the grid unmounts the screen, so a film opened from the
// middle of a library returned to an alphabetical list at the top with the
// title just watched somewhere off the bottom - and the cursor on the first
// tile, which is not the one anybody was looking at.
//
// What is remembered is the CURSOR, not the film that was opened: stepping off
// a title with the arrows and leaving from there is a different place, and it
// is the one the person left.
//
// The numbers matter as much as the key does. Restoring the cell without the
// offset puts the row somewhere it was not - which on a television reads as the
// screen having opened in the wrong place - and the clamp at the end of the
// list is computed from the grid's own height, which is measured in the same
// commit that first renders it. So one test drives the LAST row, where a
// viewport of the window's height and a viewport of the grid's differ by 97 px.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const WINDOW_H = 1080;
/** What the header leaves for the grid on the box, measured there. */
const GRID_H = 983;
/** Must match Library.tsx. */
const TILE_VH = 26;
const ROW_GAP_VH = 8;
const COLUMNS = 7;
const ITEMS = 259;
/** More than the library has films, so the deep cell exists in this list too. */
const COLLECTIONS = 300;

const rowHeight = Math.round(WINDOW_H * ((TILE_VH + ROW_GAP_VH) / 100));
const rows = Math.ceil(ITEMS / COLUMNS);
/**
 * The grid's visible height as the component computes it.
 *
 * happy-dom resolves the clip's padding classes to nothing, so here the padding
 * box IS `clientHeight`; the subtraction itself is held by library-window.
 */
const VIEWPORT = GRID_H;
/** The last item, i.e. the last row - where the end clamp decides the offset. */
const LAST = ITEMS - 1;
/** A cell well inside the last screenful, reachable once the grid has jumped. */
const DEEP = 240;
/** The last letter's first item sits inside the final screenful. */
const LAST_LETTER_OFFSET = ITEMS - 3;

function item(n: number): MediaItem {
  return { id: `i${n}`, kind: "movie", title: `Film ${n}`, thumb: `/t/${n}` };
}

function stubBackend(total = ITEMS): MediaBackend {
  return {
    kind: "plex",
    libraryPage: async (_id: string, q: { offset: number; limit: number }) => ({
      total,
      items: Array.from({ length: Math.max(0, Math.min(q.limit, total - q.offset)) }, (_, i) => item(q.offset + i)),
    }),
    // A different list, and a LONGER one: with fewer collections than films the
    // deep cell would be out of range anyway, and the test would hold on a build
    // that never forgot anything.
    collections: async (_id: string, q: { offset: number; limit: number }) => ({
      total: COLLECTIONS,
      items: Array.from({ length: Math.max(0, Math.min(q.limit, COLLECTIONS - q.offset)) }, (_, i) =>
        item(1000 + q.offset + i),
      ),
    }),
    letters: async () => [
      { key: "A", title: "A", size: ITEMS - 3 },
      { key: "Z", title: "Z", size: 3 },
    ],
    letterOffset: async (_id: string, key: string) => (key === "Z" ? LAST_LETTER_OFFSET : 0),
    sorts: async () => [],
    sortOptions: async () => [],
    filterOptions: async () => [],
    posterUrl: () => undefined,
    imageHeaders: () => ({}),
  } as unknown as MediaBackend;
}

/** What the moving layer has been translated to, in px. */
function offsetOf(container: HTMLElement): number {
  const layer = container.querySelector<HTMLElement>("[style*='will-change']");
  const m = /translateY\((-?[\d.]+)px\)/.exec(layer?.style.transform ?? "");
  const px = m ? -Number(m[1]) : 0;
  // Negating a zero gives -0, which Object.is - and so toBe - separates from 0.
  return px === 0 ? 0 : px;
}

/**
 * How tall the grid measures, for the whole file.
 *
 * On the prototype rather than on the element, because the height has to be
 * readable in the commit that first renders the grid: that is where the resume
 * happens, and a stub applied after the render would be measuring a screen that
 * had already been put in the wrong place.
 */
let clientHeight: PropertyDescriptor | undefined;

beforeEach(async () => {
  clientHeight = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "clientHeight");
  Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => GRID_H,
  });
  // The grid moves itself with a Web Animations keyframe pair, which happy-dom
  // has none of. Only the destination matters here - the mover writes that to
  // the inline transform itself, and what it animates through is move-to's.
  (window.HTMLElement.prototype as unknown as { animate: unknown }).animate = () =>
    ({ cancel: () => {}, commitStyles: () => {} }) as unknown as Animation;
  clearLibraryViews();
  useApp.setState({ backend: stubBackend(), screen: { name: "home" }, history: [], failure: null });
  window.innerHeight = WINDOW_H;
  // Focus is library-global and survives an unmount, so a leftover from the
  // previous test would let the next one pass without the screen doing anything.
  await act(async () => setFocus(""));
});

afterEach(() => {
  if (clientHeight) Object.defineProperty(window.HTMLElement.prototype, "clientHeight", clientHeight);
  delete (window.HTMLElement.prototype as unknown as { animate?: unknown }).animate;
});

/** Mount the library and let it settle, including its deferred first focus. */
async function open(): Promise<{ container: HTMLElement; unmount: () => void }> {
  const { container, unmount } = render(<Library libraryId="1" title="Movies" />);
  await waitFor(() => expect(container.querySelector("[style*='will-change']")).toBeTruthy());
  await settle();
  return { container, unmount };
}

/** The initial focus is deferred by a timeout; the scheduler resolves after it. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await flushFocus();
}

/** A letter in the strip, once the strip has arrived. */
function letterEl(container: HTMLElement, key: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>("div")).find(
    (d) => d.children.length === 0 && d.textContent?.trim() === key,
  );
}

/**
 * Take the grid to the end of the list.
 *
 * Through the strip rather than by pressing Down 34 times: the cells this test
 * needs are only mounted once the grid is down there, and the jump is the move
 * the screen actually offers for it.
 */
async function jumpToEnd(container: HTMLElement): Promise<void> {
  await waitFor(() => expect(letterEl(container, "Z")).toBeTruthy());
  await setFocus("letter-Z");
  await remote.ok();
  await waitFor(() => expect(offsetOf(container)).toBeGreaterThan(0));
}

describe("returning to a library", () => {
  it("puts the cursor back on the tile it was left on, and the grid back under it", async () => {
    const first = await open();
    await jumpToEnd(first.container);
    await setFocus(`cell-${DEEP}`);
    await flushFocus();
    const left = offsetOf(first.container);
    expect(left).toBeGreaterThan(0);
    expect(getCurrentFocusKey()).toBe(`cell-${DEEP}`);

    first.unmount();
    // The library's own focus survives an unmount, so without this the assertion
    // below would hold on a build that restores nothing at all.
    await act(async () => setFocus(""));

    const again = await open();
    expect(getCurrentFocusKey()).toBe(`cell-${DEEP}`);
    expect(offsetOf(again.container)).toBe(left);
    // The bug: an alphabetical list at the top, with the title just opened off
    // the bottom of the screen.
    expect(offsetOf(again.container)).not.toBe(0);
  });

  it("clamps the last row against the grid's height, not the window's", async () => {
    const first = await open();
    await jumpToEnd(first.container);
    await setFocus(`cell-${LAST}`);
    await flushFocus();
    // The end of the list: the last row cannot be brought further up.
    expect(offsetOf(first.container)).toBe(rows * rowHeight - VIEWPORT);

    first.unmount();
    await act(async () => setFocus(""));

    const again = await open();
    expect(offsetOf(again.container)).toBe(rows * rowHeight - VIEWPORT);
    // What the window's own height would clamp to, 97 px short of the end. The
    // grid is the flex child below the header, and the resume runs in the commit
    // that first measures it - before the state beside it has caught up.
    expect(offsetOf(again.container)).not.toBe(rows * rowHeight - WINDOW_H);
  });

  it("opens at the top when the tile is no longer there", async () => {
    const first = await open();
    await jumpToEnd(first.container);
    await setFocus(`cell-${DEEP}`);
    await flushFocus();
    first.unmount();
    await act(async () => setFocus(""));

    // Something removed, a section refreshed: the cell never mounts, and aiming
    // the cursor at it is the dead remote the focus fallback exists for.
    useApp.setState({ backend: stubBackend(100) });
    const again = await open();
    expect(getCurrentFocusKey()).toBe("cell-0");
    expect(offsetOf(again.container)).toBe(0);
  });

  it("forgets where the cursor was when the list is no longer the same list", async () => {
    const first = await open();
    await jumpToEnd(first.container);
    await setFocus(`cell-${DEEP}`);
    await flushFocus();

    // A mode change renumbers the whole grid, so the index names a different
    // title. Same for a new order or filter, which reach the same reset.
    await setFocus("lib-mode");
    await remote.ok();
    await settle();

    first.unmount();
    await act(async () => setFocus(""));

    const again = await open();
    expect(getCurrentFocusKey()).toBe("cell-0");
    expect(offsetOf(again.container)).toBe(0);
  });

  it("forgets it on sign-out", async () => {
    const first = await open();
    await jumpToEnd(first.container);
    await setFocus(`cell-${DEEP}`);
    await flushFocus();
    first.unmount();
    await act(async () => setFocus(""));

    // A grid position is not a genre, but it is still a record of what somebody
    // was looking at, and it goes with everything else the session held.
    clearLibraryViews();
    const again = await open();
    expect(getCurrentFocusKey()).toBe("cell-0");
    expect(offsetOf(again.container)).toBe(0);
  });
});
