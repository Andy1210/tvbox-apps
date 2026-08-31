import { StrictMode } from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Library, arrivalCells } from "../Library";
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
/**
 * Sized so the interesting geometry is reachable, not for realism.
 *
 * `DEEP` has to be inside the last screenful, because that is where the letter
 * jump can put the cursor - and its arrival window has to STRADDLE a page
 * boundary, or a prefetch that asks only for the cursor's own page passes every
 * assertion here. With 320 items the jump mounts rows 42-45.
 */
const ITEMS = 320;
/** More than the library has films, so the deep cell exists in this list too. */
const COLLECTIONS = 400;

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
/**
 * A cell well inside the last screenful, reachable once the grid has jumped.
 *
 * Row 44, chosen so its arrival window straddles a page boundary AT THE TOP:
 * rows 41-47 hold cells 287-335, i.e. pages 2 and 3, and it is the rows ABOVE
 * the cursor's own that carry the boundary. A window anchored at the cursor's
 * row instead covers only page 3 - which is what the top of the screen arriving
 * blank looks like from here.
 */
const DEEP = 308;
/** The pages its arrival window needs, which is the point of the number above. */
const DEEP_PAGES = [200, 300];
/**
 * A cell one row above `DEEP`, for the A-Z mark.
 *
 * The mark only differs from the old reading at the up-park rest, which is where
 * `nearest` puts a row it has to bring DOWN to - so the test has to move the
 * cursor up a row rather than sideways.
 */
const MARK_CELL = 301;
/** The last letter's first item sits inside the final screenful. */
const LAST_LETTER_OFFSET = ITEMS - 3;

/**
 * Where the alphabet turns over: the start of the row the mark test parks on.
 *
 * The resume rests a pad above that row, so the row before it has a sliver of a
 * caption showing and nothing else. Putting the turnover here is what makes the
 * two readings differ; a boundary one row either side reads the same both ways
 * and the assertion cannot fail.
 */
const Z_FROM = MARK_CELL;

function item(n: number): MediaItem {
  const title = n < Z_FROM ? `Alfa ${n}` : `Zeta ${n}`;
  return { id: `i${n}`, kind: "movie", title, thumb: `/t/${n}` };
}

/** Every page the screen asked for, newest last. Reset per test. */
let asked: number[] = [];

function stubBackend(total = ITEMS): MediaBackend {
  return {
    kind: "plex",
    libraryPage: async (_id: string, q: { offset: number; limit: number }) => {
      asked.push(q.offset);
      return {
        total,
        items: Array.from({ length: Math.max(0, Math.min(q.limit, total - q.offset)) }, (_, i) => item(q.offset + i)),
      };
    },
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
    // One order beside the default, so the arrange panel has a chip to press:
    // that is the one gesture that changes the list without also changing the
    // mode, and the two clauses of the reset would otherwise cover for one
    // another.
    sortOptions: async () => [{ key: "addedAt", title: "Recently added" }],
    filterOptions: async () => [],
    switchProfile: async () => ({ kind: "plex", token: "t2", profileId: "p2", profileName: "Other" }),
    listProfiles: async () => [{ id: "p2", name: "Other" }],
    revokeSession: async () => {},
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
/** Mutable, so a test can change the grid's height and make it re-measure. */
let gridH = GRID_H;

beforeEach(async () => {
  gridH = GRID_H;
  asked = [];
  clientHeight = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "clientHeight");
  Object.defineProperty(window.HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => gridH,
  });
  // The grid moves itself with a Web Animations keyframe pair, which happy-dom
  // has none of. Only the destination matters here - the mover writes that to
  // the inline transform itself, and what it animates through is move-to's.
  (window.HTMLElement.prototype as unknown as { animate: unknown }).animate = () =>
    ({ cancel: () => {}, commitStyles: () => {} }) as unknown as Animation;
  clearLibraryViews();
  // A session and an identity, because two of these go through the store's own
  // sign-out and profile-switch rather than through the module they clear.
  useApp.setState({
    backend: stubBackend(),
    screen: { name: "home" },
    history: [],
    failure: null,
    identity: { clientId: "c1", host: "box", fresh: false },
    session: { kind: "plex", token: "t1", accountToken: "t1", profileId: "p1", profileName: "One" } as never,
  });
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

/**
 * Which control is lit, read off the screen.
 *
 * `getCurrentFocusKey` is spatial navigation's own bookkeeping and survives an
 * unmount, so a leftover from an earlier test can satisfy it either way.
 */
function litKey(container: HTMLElement): string | null | undefined {
  return container.querySelector('[data-sfocus][class*="!bg-white"]')?.getAttribute("data-sfocus");
}

/** A letter in the strip, once the strip has arrived. */
function letterEl(container: HTMLElement, key: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>("div")).find(
    (d) => d.children.length === 0 && d.textContent?.trim() === key,
  );
}

/**
 * Which letters the strip is marking.
 *
 * `font-bold` is the mark and `text-fg-dim` is every other letter; matching
 * `text-fg` would accept both, which is how this assertion passes against the
 * bug it is written for.
 */
function marked(container: HTMLElement): (string | undefined)[] {
  return Array.from(container.querySelectorAll<HTMLElement>("div"))
    .filter((d) => d.children.length === 0 && /^[A-Z#]$/.test(d.textContent?.trim() ?? ""))
    .filter((d) => /font-bold/.test(d.className))
    .map((d) => d.textContent?.trim());
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

describe("the band a resumed grid arrives with", () => {
  // The screen tests can only drive the cursor to cells the letter jump makes
  // reachable, so they pin one position each. The band has to be right at every
  // position, and it is what decides whether the tiles somebody is looking at
  // are posters or grey rectangles.
  it("covers three rows either side of the cursor, and never more than two pages", () => {
    for (const index of [0, 6, 7, 20, 21, 100, 137, 300, 308, 699, 1400, 8281]) {
      const row = Math.floor(index / COLUMNS);
      const [first, last] = arrivalCells(index);
      // `nearest` only promises the cursor's row sits between the two pads, so
      // it can be the third row on screen or the third from the bottom: the
      // band is the union, and either end short of it leaves a row of the
      // arriving screen blank for a round trip.
      expect(first).toBe(Math.max(0, (row - 3) * COLUMNS));
      expect(last).toBe((row + 4) * COLUMNS - 1);
      // Which is what keeps the cost at one request or two.
      expect(last - first).toBeLessThan(100);
      expect(Math.floor(last / 100) - Math.floor(first / 100)).toBeLessThanOrEqual(1);
    }
  });
});

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
    // And the cell is really THERE. `getCurrentFocusKey` is spatial navigation's
    // own bookkeeping and `offsetOf` reads the transform, so both hold on a build
    // that moves the layer and leaves the rendered window at the top - a grid
    // translated 12,000 px with only its first rows mounted, i.e. a black screen.
    // Measured: without `setScrollTop` the ring count here is 0.
    expect(again.container.querySelectorAll(".ring-white").length).toBe(1);
  });

  it("asks for the resumed page without waiting for the first one to answer", async () => {
    const first = await open();
    await jumpToEnd(first.container);
    await setFocus(`cell-${DEEP}`);
    await flushFocus();
    first.unmount();
    await act(async () => setFocus(""));

    // Page 0 held open, so "asked in the same commit" and "asked a round trip
    // later" are two different observations rather than the same end state.
    // Both orders end with the page loaded, which is why the timing has to be
    // what is measured.
    let answer = (): void => {};
    const held = new Promise<void>((r) => (answer = r));
    const base = stubBackend();
    asked = [];
    useApp.setState({
      backend: {
        ...base,
        libraryPage: async (id: string, q: { offset: number; limit: number }) => {
          if (q.offset === 0) await held;
          return base.libraryPage(id, q);
        },
      } as unknown as MediaBackend,
    });

    const again = render(<Library libraryId="1" title="Movies" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // The resumed cell is on another page. Waiting for the grid to move before
    // asking for that one costs a whole extra round trip, and for it the tile
    // under the cursor is a blank placeholder whose OK does nothing: the
    // Back-then-OK everybody does after leaving a film would be swallowed.
    //
    // The exact set, not just "the right one is in it": asking for every page up
    // to the cursor's is a plausible wrong fix that fetches 83 of them on this
    // library, and it would pass a `toContain`. The band is 49 cells, fewer than
    // a page, so it is one page or two.
    expect(asked).toEqual(DEEP_PAGES);

    // And with page 0 still held, the screen is already right: the total came
    // from the resumed page, the grid rendered from it, and the tile under the
    // cursor carries a title rather than being a blank placeholder.
    expect(again.container.textContent).toContain(`Zeta ${DEEP}`);

    answer();
    await settle();
    const ring = again.container.querySelector(".ring-white")?.parentElement;
    expect(ring?.textContent).toContain(`${DEEP}`);
  });

  it("marks the letter the top of the screen is showing, not the row above it", async () => {
    const first = await open();
    await jumpToEnd(first.container);
    await setFocus(`cell-${MARK_CELL}`);
    await flushFocus();
    first.unmount();
    await act(async () => setFocus(""));

    const again = await open();
    // The strip reads a row of the grid. One row of overscan sits above the top
    // visible one, and reading THAT marks the letter of items that are off the
    // screen: the boundary here is flush with a row start, so the two answers
    // differ. It only ever showed while somebody scrolled by hand, where the
    // letter they pressed masks it; a library that opens where it was left has
    // nothing to mask it, and the mark is on screen from the first frame.
    expect(marked(again.container)).toEqual(["Z"]);
  });

  it("does not forget the cursor when the reset is set up twice", async () => {
    const first = await open();
    await jumpToEnd(first.container);
    await setFocus(`cell-${DEEP}`);
    await flushFocus();
    const left = offsetOf(first.container);
    first.unmount();
    await act(async () => setFocus(""));

    // The reset that forgets the cursor keys on "is this the same list", not on
    // "has this run before": Strict Mode sets an effect up twice on mount, and a
    // run counter reads the second setup as a new order or filter - which drops
    // the resume and deletes the stored cursor with it, so the NEXT entry opens
    // at the top too.
    //
    // The offset is what this pins, not the cursor. `useInitialFocus` has a
    // Strict Mode gap of its own that predates this and is not addressed here:
    // its cleanup cancels the focus timeout that its second setup then declines
    // to reschedule. The app renders without Strict Mode (`main.tsx`).
    const again = render(
      <StrictMode>
        <Library libraryId="1" title="Movies" />
      </StrictMode>,
    );
    await waitFor(() => expect(again.container.querySelector("[style*='will-change']")).toBeTruthy());
    await settle();
    expect(offsetOf(again.container)).toBe(left);
  });

  it("does not put the grid back a second time when the screen is re-measured", async () => {
    const first = await open();
    await jumpToEnd(first.container);
    await setFocus(`cell-${DEEP}`);
    await flushFocus();
    first.unmount();
    await act(async () => setFocus(""));

    const again = await open();
    // Step off the resumed cell, the way anybody would.
    await setFocus(`cell-${DEEP - 7}`);
    await flushFocus();
    const moved = offsetOf(again.container);
    expect(moved).not.toBe(0);

    // A television that changes output mode re-measures the grid, and the
    // resume effect watches those numbers. It has to be spent, or the grid
    // jumps back to where the person came in - with the cursor left behind.
    gridH = GRID_H - 120;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    await flushFocus();
    expect(getCurrentFocusKey()).toBe(`cell-${DEEP - 7}`);
    expect(offsetOf(again.container)).toBe(moved);
  });

  it("puts the last row back against the end of the list", async () => {
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
    // Not what the window's own height would clamp to, which is 97 px short of
    // the end. Honest about what this pins: the resting place is the same
    // either way, because the cell taking the cursor re-runs `nearest` with the
    // height that has by then reached the state. What the measured read buys is
    // the FIRST frame, which is the whole reason the resume is a layout effect,
    // and no assertion here can see a frame.
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

  it("forgets where the cursor was when the order changes", async () => {
    const first = await open();
    await jumpToEnd(first.container);
    await setFocus(`cell-${DEEP}`);
    await flushFocus();

    // Through the arrange panel, which is the one gesture that renumbers the
    // list without also changing the mode: the mode toggle happens to call
    // `setView` too, so a test that only presses that would hold even if the
    // reset stopped looking at the order at all.
    await setFocus("lib-arrange");
    await remote.ok();
    await settle();
    await setFocus("lf-sort-0");
    await remote.ok();
    await settle();

    first.unmount();
    await act(async () => setFocus(""));

    const again = await open();
    expect(getCurrentFocusKey()).toBe("cell-0");
    expect(offsetOf(again.container)).toBe(0);
  });

  it("forgets it when somebody else takes over the box", async () => {
    const first = await open();
    await jumpToEnd(first.container);
    await setFocus(`cell-${DEEP}`);
    await flushFocus();
    first.unmount();
    await act(async () => setFocus(""));

    // The PIN pad is a boundary between two people in one household, and where
    // somebody had got to in a library is a record of what they were looking
    // at. Through the store action rather than the module it clears, so this
    // holds the WIRING rather than the primitive.
    await act(async () => {
      await useApp.getState().chooseProfile("p2", undefined, "Other");
    });
    useApp.setState({ backend: stubBackend() });
    const again = await open();
    expect(getCurrentFocusKey()).toBe("cell-0");
    expect(offsetOf(again.container)).toBe(0);
  });

  it("leaves the cursor on the failure screen when a page does not answer", async () => {
    const first = await open();
    await jumpToEnd(first.container);
    await setFocus(`cell-${DEEP}`);
    await flushFocus();
    first.unmount();
    await act(async () => setFocus(""));

    // The resumed page fails while the first one is fine. That is the server's
    // least healthy moment - it has just been streaming a film - and it is only
    // ordinary at all because the resume asks for a second page on the way in.
    //
    // A flag rather than a second backend object: swapping the backend moves
    // `loadPage`'s identity, which is a new list to the reset effect, and the
    // grid would go back to the top for a reason that has nothing to do with
    // what is being tested.
    let refuse = true;
    const base = stubBackend();
    useApp.setState({
      backend: {
        ...base,
        libraryPage: async (id: string, q: { offset: number; limit: number }) => {
          if (refuse && q.offset !== 0) throw Object.assign(new Error("no"), { status: 500 });
          return base.libraryPage(id, q);
        },
      } as unknown as MediaBackend,
    });

    const again = render(<Library libraryId="1" title="Movies" />);
    // The failure screen first, THEN the deferred focus: the two arrive on
    // different turns, and settling once before the screen is up measures a
    // screen that has not decided yet. That was flaky one run in six.
    await waitFor(() => expect(again.container.textContent).toContain("Try again"));
    await settle();
    // The failure screen replaces the grid and focuses its own button. The
    // resume settles `startCell` after that, so without a guard it fires
    // afterwards and aims at a cell that is not mounted: measured, the error
    // text on screen with its button unhighlighted, and neither OK nor an arrow
    // doing anything, because the fallback's target is not mounted there
    // either. Two of the remote's three buttons dead.
    //
    // Read off the SCREEN rather than from `getCurrentFocusKey`, which is
    // spatial navigation's own bookkeeping and survives an unmount: a leftover
    // from an earlier test can satisfy it either way. What matters is which
    // control is lit.
    expect(litKey(again.container)).toBe("msg-retry");
    expect(again.container.textContent).toContain("Try again");

    // And the button has to DO something, which is the press this test used to
    // stop one short of. `loadPage(0)` was a no-op here - page 0 answered, so it
    // sits in `answered` - and clearing the failure re-renders a grid whose
    // window effect has no changed dependency: measured on a box, 42 blank
    // tiles, zero requests, and a cursor on a placeholder that answers no OK.
    // Recovery came only on the second press, the one that moved the grid.
    refuse = false;
    asked = [];
    await setFocus("msg-retry");
    await remote.ok();
    await settle();
    // Exactly these: page 0 answered, so it is in `answered` and is not asked
    // again. Clearing that set would re-request pages whose posters are on
    // screen, and a second refusal there replaces a good screen with the error.
    expect(asked).toEqual(DEEP_PAGES);
    await waitFor(() => expect(again.container.textContent).toContain(`Zeta ${DEEP}`));
    expect(again.container.textContent).not.toContain("Try again");
    // And the press that dismissed the error must not start anything if it
    // repeats. Here the deferred focus had NEVER fired - the guard held it back
    // for the whole of the failure - so without the second half of that guard
    // it would fire now, on the resumed poster, a millisecond after the OK.
    // This is the failure the arrival requests made ordinary.
    await remote.ok();
    await settle();
    expect(useApp.getState().screen.name).not.toBe("item");
  });

  it("does not start a film when the press that dismissed an error repeats", async () => {
    const first = await open();
    await jumpToEnd(first.container);
    await setFocus(`cell-${DEEP}`);
    await flushFocus();
    first.unmount();
    await act(async () => setFocus(""));

    // The grid comes up first and the cursor lands, so the deferred focus is
    // spent. THEN something fails - a page a scroll asked for, a server that
    // went away mid-browse - and the failure screen takes the cursor for its
    // own button.
    const again = await open();
    expect(again.container.querySelectorAll(".ring-white").length).toBe(1);
    await act(async () => {
      useApp.getState().fail({ kind: "unreachable" });
    });
    await settle();
    expect(again.container.textContent).toContain("Try again");

    // Try again is dismissed with OK, and a held button or anyone who taps
    // twice at an error screen sends that press again about a millisecond
    // later. It must not land on a poster: measured on a box, that started a
    // film nobody chose, which here means the shared player, a display-mode
    // switch and a second of wind-down to get out of. The cursor stays where
    // the failure screen left it and the recovery guard puts it back on the
    // next arrow, which costs one press and starts nothing.
    asked = [];
    await setFocus("msg-retry");
    await remote.ok();
    await settle();
    expect(again.container.textContent).not.toContain("Try again");
    await remote.ok();
    await settle();
    expect(useApp.getState().screen.name).not.toBe("item");
  });

  it("brings the library back when the first page is the one that failed", async () => {
    // Nothing to resume: this is a library opening for the first time against a
    // server that is down, which is the ordinary way a whole library fails.
    let refuse = true;
    const base = stubBackend();
    useApp.setState({
      backend: {
        ...base,
        libraryPage: async (id: string, q: { offset: number; limit: number }) => {
          if (refuse) throw Object.assign(new Error("no"), { status: 500 });
          return base.libraryPage(id, q);
        },
      } as unknown as MediaBackend,
    });

    const screen = render(<Library libraryId="1" title="Movies" />);
    await waitFor(() => expect(screen.container.textContent).toContain("Try again"));
    await settle();

    // With no total there are no rows, so a Try again that asks only for the
    // rows on screen asks for nothing at all: measured on a box, zero requests
    // and a spinner that never resolves, with nothing on it to press. Page 0 is
    // what carries the total, so it has to be asked for by name.
    refuse = false;
    asked = [];
    await setFocus("msg-retry");
    await remote.ok();
    await settle();
    expect(asked).toContain(0);
    await waitFor(() => expect(screen.container.textContent).toContain("Alfa 0"));
    expect(screen.container.textContent).not.toContain("Try again");
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
    //
    // Through the store action rather than by calling `clearLibraryViews`
    // directly: the claim is that signing out forgets it, and a test of the
    // primitive holds even if nothing calls it.
    await act(async () => {
      await useApp.getState().signOut();
    });
    useApp.setState({ backend: stubBackend() });
    const again = await open();
    expect(getCurrentFocusKey()).toBe("cell-0");
    expect(offsetOf(again.container)).toBe(0);
  });
});
