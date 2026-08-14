import { describe, it, expect, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Tile } from "../Tile";
import { setupRemote, place, remote, setFocus, getCurrentFocusKey } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaItem } from "../backends/types";

// Down must move exactly one row.
//
// The library grid used to move two, and the last row could not be reached at
// all. Nothing errored and the app looked right: spatial navigation filters
// "below me" candidates with `sibling.top >= current.bottom`, measured with
// getBoundingClientRect - which reports the box AFTER transforms. A focused tile
// that grew 6% put its own bottom past the next row's top and deleted that row
// from the candidate set.
//
// So the invariant this file defends is arithmetic, not appearance: a focused
// tile, at whatever size it ends up, must still fit inside the row pitch. It is
// checked by driving the real library over modelled rectangles, because
// happy-dom has no layout engine and the bug lives entirely in the numbers.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const VIEWPORT = 1080;
/** Must match Library.tsx. */
const TILE_VH = 26;
const ROW_GAP_VH = 8;
const COLUMNS = 7;

const rowHeight = Math.round(VIEWPORT * ((TILE_VH + ROW_GAP_VH) / 100));

/**
 * What a tile actually occupies: the poster, the gap under it, and TWO lines of
 * caption at 1.8vh and line-height 1.5.
 *
 * The caption is two lines because one truncated "Official Trailer 2" and
 * "Behind the Scenes" to the same words. That change alone would have brought
 * the row-skipping back - it added 2.7vh to a tile with 1.5vh of clearance -
 * which is why the pitch is derived here rather than assumed.
 */
const tileHeight = (VIEWPORT * (TILE_VH + 0.8 + 2 * 1.8 * 1.5)) / 100;

function item(n: number): MediaItem {
  return { id: `i${n}`, kind: "movie", title: `Film ${n}`, thumb: `/t/${n}` };
}

function Grid({ rows }: { rows: number }): React.JSX.Element {
  return (
    <div>
      {Array.from({ length: rows * COLUMNS }, (_, i) => (
        <Tile key={i} item={item(i)} focusKey={`cell-${i}`} heightVh={TILE_VH} onEnter={() => {}} />
      ))}
    </div>
  );
}

beforeEach(async () => {
  await act(async () => setFocus(""));
});

/** Lay the cells out on the grid the library draws. */
function layOut(container: HTMLElement, rows: number, scale: number): void {
  const cells = container.querySelectorAll<HTMLElement>("[data-focus-key], div");
  void cells;
  for (let i = 0; i < rows * COLUMNS; i += 1) {
    const el = document.querySelector<HTMLElement>(`[data-cell="${i}"]`);
    if (!el) continue;
    const r = Math.floor(i / COLUMNS);
    const c = i % COLUMNS;
    const grown = tileHeight * scale;
    // Growth is centred, so half of it hangs below the row's own top.
    const top = r * rowHeight - (grown - tileHeight) / 2;
    place(el, c * 260, top, 200 * scale, grown);
  }
}

describe("the library grid", () => {
  it("moves one row per press, and reaches the last one", async () => {
    const { container } = render(<Grid rows={4} />);
    // The tiles are the focusables themselves; mark them so the geometry can be
    // applied by index.
    container.querySelectorAll<HTMLElement>("div").forEach((el) => {
      const label = el.textContent ?? "";
      const m = /^Film (\d+)$/.exec(label.trim());
      if (m && el.parentElement) el.parentElement.setAttribute("data-cell", m[1]);
    });
    layOut(container, 4, 1);

    await act(async () => setFocus("cell-0"));
    expect(getCurrentFocusKey()).toBe("cell-0");

    await remote.down();
    expect(getCurrentFocusKey()).toBe(`cell-${COLUMNS}`);

    await remote.down();
    expect(getCurrentFocusKey()).toBe(`cell-${COLUMNS * 2}`);

    // The row that used to be unreachable: from the second-to-last, Down found
    // no candidate at all, because the last row's top sat inside the focused
    // tile's grown box.
    await remote.down();
    expect(getCurrentFocusKey()).toBe(`cell-${COLUMNS * 3}`);
  });

  it("keeps a focused tile inside the row pitch", () => {
    // The guard the bug slipped through: 26vh of poster, a 0.8vh gap and two
    // 1.8vh caption lines at line-height 1.5 come to 32.2vh against a 34vh
    // pitch. A third caption line, a larger font or a scale on focus eats that
    // margin, and spatial navigation loses the row below with no error at all.
    expect(tileHeight).toBeLessThan(rowHeight);
    const clearancePx = rowHeight - tileHeight;
    expect(clearancePx).toBeGreaterThan(10);
  });

  it("applies no transform to a focused tile", () => {
    // A 6% growth is 9.6px on this tile, against a clearance of 16px - so it
    // would survive today and break on a smaller panel or a longer caption.
    // Cheaper to forbid outright: the ring already says what is chosen.
    const { container } = render(<Tile item={item(1)} focusKey="solo" heightVh={TILE_VH} onEnter={() => {}} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).not.toMatch(/\bscale-/);
    expect(el.getAttribute("style") ?? "").not.toMatch(/transform/);
  });
});
