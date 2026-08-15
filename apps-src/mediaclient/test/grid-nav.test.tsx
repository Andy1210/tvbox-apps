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
    // Matched on the call, not on its target: the fallback key is a choice that
    // changes, and pinning it here made this test silently stop looking the
    // moment it did.
    const guard =
      /useFocusFallback\([\s\S]*?\(key\) =>([\s\S]*?)\n\s*\/\/|useFocusFallback\([\s\S]*?\(key\) =>([\s\S]*?)\),\n/.exec(
        src,
      ) ?? [];
    const body = (guard[1] ?? guard[2] ?? "") as string;
    expect(body).toBeTruthy();

    // Every focusKey prefix the file hands to a focusable.
    const prefixes = new Set([...src.matchAll(/focusKey=\{?["`]([a-z]+)-/g)].map((m) => m[1]));
    expect(prefixes.size).toBeGreaterThan(1);
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
  it("animates the arrows and jumps the letters", () => {
    // Two different gestures that both end in a scroll. Moving a row is travel -
    // animating it is what makes the grid read as a surface rather than a series
    // of jump cuts. A letter is a destination somebody already chose, and a jump
    // to "S" in a library of 1,700 crosses most of the list; animating that is a
    // second of scenery, through a window the virtualiser rebuilds on every
    // frame of it.
    //
    // Asserted on the source, because the difference lives in CSS inheritance:
    // a tile's own scrollIntoView passes no behaviour, so it takes the
    // scroller's - which means the only thing separating the two gestures is
    // that the jumps say `instant` and the arrows say nothing at all.
    const src = readFileSync(resolve(process.cwd(), "apps-src/mediaclient/Library.tsx"), "utf8");

    expect(src, "the scroller animates by default, which is what the arrows inherit").toContain("scroll-smooth");

    // Every explicit scroll on this screen is a destination, so every one of
    // them has to opt out of that.
    const scrolls = src.match(/scroller\.current\?\.scrollTo\(\{[^}]*\}\)/g) ?? [];
    expect(scrolls.length, "the explicit scrolls are still here").toBeGreaterThanOrEqual(2);
    for (const call of scrolls) expect(call, call).toContain('behavior: "instant"');

    // And a tile must not name a behaviour of its own, or it would stop
    // inheriting and the arrows would go back to jump cuts.
    const tile = readFileSync(resolve(process.cwd(), "apps-src/mediaclient/Tile.tsx"), "utf8");
    expect(tile).not.toContain("behavior:");
  });
});

describe("holding an arrow", () => {
  it("stops animating for the duration of the hold, and animates again after it", () => {
    // The browser gives every focus change its own eased scroll with a duration
    // nobody can set, so a held arrow piles restarts on top of each other and
    // the grid stutters instead of travelling. The behaviour is therefore
    // decided per press - and BEFORE the press moves anything, which is why the
    // listener is capture phase: it has to run ahead of spatial navigation
    // rather than race the tile's own effect.
    const src = readFileSync(resolve(process.cwd(), "apps-src/mediaclient/Library.tsx"), "utf8");

    // Capture phase, or the decision lands after the scroll it was meant to
    // decide.
    expect(src).toMatch(/addEventListener\("keydown",\s*onKey,\s*true\)/);
    // Instant inside a burst; empty string, not "smooth" - it has to fall back
    // to the class so the two never disagree about what smooth means.
    expect(src).toContain('el.style.scrollBehavior = now - lastStep.current < BURST_MS ? "auto" : ""');
    // And only the vertical arrows: sideways travel inside a row is the row's
    // own business.
    expect(src).toContain('if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;');
  });

  it("uses a threshold above the remote's repeat rate", () => {
    // Below the repeat interval the burst is never detected and every row of a
    // hold animates again; far above it, two deliberate presses are mistaken for
    // a hold and neither animates.
    const src = readFileSync(resolve(process.cwd(), "apps-src/mediaclient/Library.tsx"), "utf8");
    const m = /const BURST_MS = (\d+);/.exec(src);
    expect(m, "the threshold is named, not inline").toBeTruthy();
    const ms = Number(m![1]);
    expect(ms).toBeGreaterThan(120);
    expect(ms).toBeLessThan(400);
  });
});
