import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

describe("a screen's focus guard", () => {
  it("names every key the screen owns", () => {
    // The guard snaps focus back to the grid whenever the focused key is not
    // one it recognises - which is what makes a screen survive a modal closing
    // under it. The cost is that it must be told about every NEW focusable: the
    // sort-and-filter button was reachable and then instantly lost, so OK
    // arrived at the grid and opened the first film.
    //
    // Read out of the source rather than asserted against a copy, because a
    // copy would keep passing after the predicate changed.
    const src = readFileSync(resolve(process.cwd(), "apps-src/mediaclient/Library.tsx"), "utf8");
    // The predicate itself, by name. It used to be matched as an inline argument
    // to `useFocusFallback`; lifting it out to be shared with the guard that
    // runs when the failure screen goes away broke that match, and the
    // assertion below it failed loudly, which is what a test is for. Two guards
    // read it now, so the one definition is the right thing to hold.
    const guard = /function ownsKey\(key: string\): boolean \{([\s\S]*?)\n\}/.exec(src) ?? [];
    const body = (guard[1] ?? "") as string;
    expect(body, "Library.tsx no longer defines ownsKey").toBeTruthy();

    // Every focusKey prefix that can hold the cursor while this screen is up.
    // The strip and the failure screen are the guard's blind spots: they are
    // rendered inside the library's own focus context but declared in their own
    // files, so scanning only Library.tsx compared two prefixes of four - and
    // losing `letter-` is a dead A-Z strip, every press on a letter yanked back
    // to the header.
    const also = ["LetterStrip", "Message"].map((f) =>
      readFileSync(resolve(process.cwd(), `apps-src/mediaclient/${f}.tsx`), "utf8"),
    );
    const prefixes = new Set(
      [...[src, ...also].join("\n").matchAll(/(?:focusKey=\{?|key: )["`]([a-z]+)-/g)].map((m) => m[1]),
    );
    expect(prefixes).toContain("cell");
    expect(prefixes).toContain("letter");
    expect(prefixes).toContain("msg");
    expect(prefixes).toContain("lib");
    for (const p of prefixes) {
      expect(body, `focus guard does not accept "${p}-" keys`).toContain(`"${p}-"`);
    }
  });
});

describe("home row preferences", () => {
  it("reconciles an order stored by another build", async () => {
    // The stored order is a cast, and it outlives the code that wrote it: an
    // older build's list is missing any row added since, and a newer build's
    // may name one this code has never heard of. Rebuilding rather than
    // trusting is what stops a new row being invisible to everyone who had ever
    // opened this screen - and what stops a stranger's id reaching the renderer.
    const { sane, DEFAULTS } = await import("../prefs");

    // Playlists last by default: an account often has none, and where there is
    // one it is something you go looking for.
    expect(DEFAULTS.homeRows[DEFAULTS.homeRows.length - 1]).toBe("playlists");

    // An older build knew only two rows. The third is appended, not lost.
    expect(sane({ homeRows: ["recent", "ondeck"] }).homeRows).toEqual(["recent", "ondeck", "playlists"]);

    // A newer build's row, and outright rubbish, are dropped.
    expect(sane({ homeRows: ["playlists", "somethingelse", "ondeck"] } as never).homeRows).toEqual([
      "playlists",
      "ondeck",
      "recent",
    ]);

    // Nothing stored at all still gives every row, in the default order.
    expect(sane({}).homeRows).toEqual(DEFAULTS.homeRows);

    // Hidden rows are held to the same list, so an unknown id cannot hide a row
    // that does not exist and quietly desynchronise the two.
    expect(sane({ hiddenRows: ["playlists", "nope"] } as never).hiddenRows).toEqual(["playlists"]);
  });
});

describe("a tile that reports its focus", () => {
  it("reports once, not on every render", async () => {
    // A caller that sets state from this - a season loading the highlighted
    // episode's details - rendered again, was called again, and locked the app
    // up. The effect must not depend on the callback's identity, because a
    // parent passing an inline arrow gives it a new one every render.
    const { Tile } = await import("../Tile");
    let calls = 0;
    const { rerender } = render(
      <Tile
        item={item(1)}
        focusKey="loop"
        heightVh={TILE_VH}
        onEnter={() => {}}
        onFocusedEl={() => {
          calls += 1;
        }}
      />,
    );
    await act(async () => setFocus("loop"));

    const afterFocus = calls;
    // Ten renders, each handing in a brand-new callback, as a parent that
    // re-renders on any state change does.
    for (let i = 0; i < 10; i += 1) {
      rerender(
        <Tile
          item={item(1)}
          focusKey="loop"
          heightVh={TILE_VH}
          onEnter={() => {}}
          onFocusedEl={() => {
            calls += 1;
          }}
        />,
      );
    }

    expect(afterFocus).toBeLessThanOrEqual(1);
    expect(calls).toBe(afterFocus);
  });
});

describe("a row inside a scrolling column", () => {
  it("is not allowed to shrink", async () => {
    // A row is a flex item in a column that scrolls. Flexbox shrinks items
    // before it lets the box scroll, so several rows taller than the box get
    // squashed - and what survives is the middle, which is the posters: the
    // heading above them and the captions below them both disappear. Two
    // versions shipped like that, and the second "fix" chased scroll padding
    // instead, because the symptom looks like clipping.
    const src = readFileSync(resolve(process.cwd(), "apps-src/mediaclient/Row.tsx"), "utf8");
    const section = /<section[\s\S]*?className="([^"]*)"/.exec(src)?.[1] ?? "";
    expect(section, "the row's own section").toContain("shrink-0");

    // The same trap, same shape, on the two other rows a screen stacks.
    for (const f of ["CastRow.tsx", "Reviews.tsx"]) {
      const other = readFileSync(resolve(process.cwd(), `apps-src/mediaclient/${f}`), "utf8");
      const cls = /<section[\s\S]*?className="([^"]*)"/.exec(other)?.[1] ?? "";
      expect(cls, f).toContain("shrink-0");
    }
  });
});

describe("how the grid moves", () => {
  it("moves itself with a transform instead of being scrolled", () => {
    // Measured on the box: animating a native scroll cost the GPU process
    // 111-118 ms a row against 18-23 ms for the same distance jumped, because a
    // scrolling container whose contents are rebuilt underneath it re-rasters
    // what a transform simply moves. Plex's own client on the same box does not
    // scroll at all - no scrollIntoView and no scroll-behavior anywhere in its
    // bundle - and reads as smooth.
    const src = readFileSync(resolve(process.cwd(), "apps-src/mediaclient/Library.tsx"), "utf8");

    // The window clips; it does not scroll.
    const classes = src.match(/className="no-scrollbar relative flex-1[^"]*"/g) ?? [];
    expect(classes.length, "the grid window is still identifiable").toBe(1);
    expect(classes[0]).toContain("overflow-hidden");
    expect(classes[0]).not.toContain("overflow-y-auto");
    expect(classes[0]).not.toContain("scroll-smooth");

    // Nothing may scroll it, and the tiles must not scroll themselves into view
    // either - a container moving with a transform and a browser scrolling it
    // fight, and the transform then animates against a moving origin.
    expect(src).not.toContain("scrollTo(");
    expect(src).toContain("selfScroll={false}");
    expect(src, "the numbers stay next to the decision").toContain("111-118 ms");
  });

  it("re-renders only when the window changes", () => {
    // The virtualiser is computed from an offset in React state. Updating it on
    // every move would re-render every tile to move a layer the compositor is
    // already moving.
    const src = readFileSync(resolve(process.cwd(), "apps-src/mediaclient/Library.tsx"), "utf8");
    expect(src).toContain("sameWindow(prev, to, rowHeight, viewport) ? prev : to");
    // Both edges, or the last row lags by up to a row when the viewport is not
    // a whole number of rows.
    expect(src).toMatch(/Math\.ceil\(\(a \+ viewport\)/);
  });

  it("renders a window a television actually needs", () => {
    const src = readFileSync(resolve(process.cwd(), "apps-src/mediaclient/Library.tsx"), "utf8");
    const over = Number(/const OVERSCAN = (\d+);/.exec(src)?.[1]);
    expect(over, "one row of margin is the floor - below it a fast hold has no lead at all").toBe(1);
  });
});
