// Vendored from tvbox `launcher/src/test/remote.ts` (2026-08-13).
//
// Kept as a copy rather than aliased across the repo boundary: it imports
// `vitest` and `@testing-library/react` as bare specifiers, which resolve from
// the importing file's own tree - and CI installs node_modules only in
// tvbox-apps, so an alias would work locally and fail there. Two resolutions of
// React is also exactly the hazard every vite.config.ts here fights with dedupe.
//
// Shared by every app under apps-src/, since the media client is no longer the
// only one that walks its screens with the arrows.

import { beforeAll, afterAll, afterEach, expect } from "vitest";
import { act, cleanup, waitFor } from "@testing-library/react";
import {
  init,
  destroy,
  setFocus as noriginSetFocus,
  getCurrentFocusKey,
  updateAllLayouts,
  type FocusableComponent,
  type FocusableComponentLayout,
} from "@noriginmedia/norigin-spatial-navigation";

// D-pad remote harness. On the box the CEC bridge turns TV-remote presses into
// arrow keys + Enter, which norigin-spatial-navigation maps to directional focus
// moves. norigin resolves the direction geometrically from each focusable's
// layout - but happy-dom has no layout engine, so every element measures as an
// all-zero rect and real navigation is impossible out of the box. We give each
// element a fake rect (assigned by the test via place()/placeGrid()) and hand
// norigin a custom layoutAdapter.measureLayout that reads it, so a test lays its
// focusables out on a synthetic 2D plane and the arrow keys walk them exactly as
// they would on a TV.
//
// Since norigin 3.2.1 the geometry hook is the layoutAdapter API (the old
// useGetBoundingClientRect flag is deprecated), measureLayout returns a Promise,
// and every focus mutation (key nav, setFocus, mount registration) runs through
// the library's async Scheduler - focus lands on a later microtask, not
// synchronously. That is why the key-press helpers and setFocus here are async:
// they dispatch, then drain the microtask queue inside act() so the focus (and
// the React state it flips) has settled before the test asserts. The drain is
// pure microtasks - the scheduler never touches timers - so it also works under
// vi.useFakeTimers().

type Rect = { x: number; y: number; w: number; h: number };
const rects = new WeakMap<Element, Rect>();
const ZERO: Rect = { x: 0, y: 0, w: 0, h: 0 };

// Place one focusable element at (x,y) with a size. The element is the node that
// carries the `ref` from useFocusable - for a FocusButton that is the button div
// itself, which Testing Library's getByText/getByRole hands you directly.
export function place(el: Element, x: number, y: number, w = 80, h = 40): void {
  rects.set(el, { x, y, w, h });
}

export interface GridOpts {
  cellW?: number;
  cellH?: number;
  gapX?: number;
  gapY?: number;
  originX?: number;
  originY?: number;
}

// Lay elements out row-major on a grid: rows[r][c] goes to cell (r,c). null holes
// are skipped (e.g. the PIN pad's empty bottom-right cell). Gaps keep cells from
// touching so the geometric midpoints are unambiguous.
export function placeGrid(rows: (Element | null)[][], opts: GridOpts = {}): void {
  const { cellW = 80, cellH = 40, gapX = 24, gapY = 24, originX = 0, originY = 0 } = opts;
  rows.forEach((row, r) =>
    row.forEach((el, c) => {
      if (el) place(el, originX + c * (cellW + gapX), originY + r * (cellH + gapY), cellW, cellH);
    }),
  );
}

export const placeRow = (els: (Element | null)[], opts: GridOpts = {}): void => placeGrid([els], opts);
export const placeCol = (els: (Element | null)[], opts: GridOpts = {}): void =>
  placeGrid(
    els.map((e) => [e]),
    opts,
  );

// One iteration lets every microtask queued so far run; the scheduler's promise
// chains add a bounded handful of links per turn (measureLayout per sibling,
// smartNavigate recursion up the focus tree), so 200 turns settles any chain
// these tests can produce with a wide margin.
async function drainScheduler(): Promise<void> {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
}

// Flush pending focus work outside a key press - e.g. a component's own deferred
// focusSelf()/setFocus() kicked off by a timer or a resolved fetch.
export async function flushFocus(): Promise<void> {
  await act(async () => {
    await drainScheduler();
  });
}

async function fire(key: string): Promise<void> {
  await act(async () => {
    // Focusables get measured when they register at mount - BEFORE the test's
    // place() calls assign rects - and the library skips re-measuring siblings
    // whose layout is younger than its 16ms LAYOUT_STALE_TIME, so a press right
    // after render would navigate against stale all-zero layouts. Re-measure
    // everything against the harness rects before each press.
    updateAllLayouts();
    await drainScheduler();
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
    await drainScheduler();
  });
}

// The remote as the shell delivers it. Arrows + OK(Enter) go through norigin;
// Back is a plain Backspace that the shell preload synthesizes and useBackspace
// (a capture-phase listener) handles - norigin ignores it. Await every press:
// focus resolves asynchronously (see the header comment).
export const remote = {
  up: (): Promise<void> => fire("ArrowUp"),
  down: (): Promise<void> => fire("ArrowDown"),
  left: (): Promise<void> => fire("ArrowLeft"),
  right: (): Promise<void> => fire("ArrowRight"),
  ok: (): Promise<void> => fire("Enter"),
  back: (): Promise<void> => fire("Backspace"),
};

// norigin's setFocus is scheduler-bound since 3.2.1 - this wrapper awaits the
// focus actually landing (and keeps the React updates inside act()).
/**
 * Wait for the cursor to arrive, rather than for a fixed number of turns.
 *
 * A screen's focus landing is scheduled with `setTimeout(..., 0)` - that is how
 * `useInitialFocus` and every panel's own cancel path do it - and a counted
 * settle gives it a fixed budget. Whether React's commit AND its passive effect
 * both land inside that budget is a scheduler question, so on a loaded machine
 * the effect can schedule its timer after the settle has scheduled its own: the
 * settle returns first, a microtask drain finds nothing (norigin's scheduler is
 * promise-based and has no timers), and the assertion reads null.
 *
 * That is not hypothetical. It failed a CI run that was publishing a finished
 * release, on the first focus assertion of a test, before any press:
 * `expected null to be 'profile-u1'`. Delaying a screen's initial focus by 5 ms
 * reproduces it, and fails 19 tests across 7 files in this suite.
 *
 * So an assertion about where the cursor ARRIVES belongs here rather than
 * straight after a counted settle.
 *
 * Not every focus assertion, though. A test that asserts the cursor did NOT
 * move - that a press was refused, that a panel held it, that a container did
 * not swallow it - must read the key rather than wait for it, because waiting
 * would sit there until the thing it is guarding against happened.
 */
export async function focusBecomes(key: string): Promise<void> {
  await waitFor(() => expect(getCurrentFocusKey()).toBe(key));
}

/** The same wait, where a test only cares that the screen answers at all. */
export async function focusLands(): Promise<void> {
  await waitFor(() => expect(getCurrentFocusKey()).toBeTruthy());
}

export async function setFocus(focusKey: string): Promise<void> {
  await act(async () => {
    noriginSetFocus(focusKey);
    await drainScheduler();
  });
}

// Register the harness layoutAdapter + norigin init/teardown for a suite. Call
// once at the top of a test file (before describe). Focusables from an unmounted
// render are dropped by Testing Library's cleanup between tests. The partial
// layoutAdapter object is Object.assign-ed over the library's default web
// adapter, so key handling and DOM focus stay stock - only geometry is ours.
export function setupRemote(): void {
  const config = {
    layoutAdapter: {
      measureLayout: async (component: FocusableComponent): Promise<FocusableComponentLayout> => {
        const node = component.node;
        const b = (node && rects.get(node)) ?? ZERO;
        return {
          node,
          x: b.x,
          y: b.y,
          width: b.w,
          height: b.h,
          left: b.x,
          top: b.y,
          right: b.x + b.w,
          bottom: b.y + b.h,
        };
      },
    },
  };
  beforeAll(() => init(config));
  // Unmounting a render does not put the CURSOR back: norigin keeps its current
  // focus key, and the next test's fresh render re-registers a focusable under that
  // name - which fires its onFocus and drives the app before a single key is
  // pressed. A test asserting where a screen opens then depends on the test above
  // it, and `--sequence.shuffle.tests` says so. `setFocus("")` does not clear it, so
  // the service itself is rebuilt between tests.
  afterEach(() => {
    cleanup();
    destroy();
    init(config);
  });
  afterAll(() => destroy());
}

export { getCurrentFocusKey };
