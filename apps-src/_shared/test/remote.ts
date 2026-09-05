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
  doesFocusableExist,
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
 * `expected null to be 'profile-u1'`. It reproduces deterministically by
 * pushing the landings out - and COUNT them before you do, because a sweep that
 * patches some of them reports a clean tree and proves nothing. That mistake
 * has been made three times here: once patching a single site in the media
 * client, which has twelve of them, and missing five tests in
 * `chapter-focus.test.tsx` and `player-focus.test.tsx`; once missing the
 * block-body form, which a regex for the one-liner does not match; and once
 * missing the three that never spell `setFocus` at all, landing through
 * `focusFirstOf`, `jump` and `back`. `apps-src` currently has 41 of the first
 * kind and those 3 of the second - so the media client owns thirteen in all. `app-sdk`'s `Osk.tsx` and `PinPad.tsx` carry
 * the shape and are watched but not yet raced - stubbing them fails three tests,
 * so a delay there measures something; two of the three helper landings are the
 * opposite, observed by nothing at all, and green at any delay for that reason
 * rather than for a good one.
 *
 * Three things about reading the result. WHERE a landing lands decides how the
 * delay behaves, so do not expect one band: the initial-focus sites used to
 * bite between about 5 and 8 ms and go green again by 15, once the delay was
 * long enough to land after a test's presses rather than between them, while
 * the restore in `Detail.tsx` is monotone from 8 ms to at least 80 - and those
 * assertions are all waits now, so that first band is history rather than
 * something to go looking for.
 *
 * A single run can mislead in either direction, so say which you measured.
 * Running one file alone was the more sensitive of the two for the restore
 * (6 failures in 6, against a full suite that still failed every run but with
 * two of the three tests rather than three); for the earlier sites it was the
 * other way round, 2 full runs in 8 and none in 8 alone.
 *
 * And the instrument has a ceiling: above about 40 ms it outruns the declared
 * budget in `season-strip`'s promptness test, which then fails on any tree and
 * is the instrument talking, not the suite.
 *
 * So an assertion about where the cursor ARRIVES belongs here rather than
 * straight after a counted settle.
 *
 * Not every focus assertion, though. Three shapes belong elsewhere.
 *
 * A test that asserts the cursor did NOT move - that a press was refused, that
 * a panel held it, that a container did not swallow it - must read the key
 * rather than wait for it, because waiting would sit there until the thing it
 * is guarding against happened.
 *
 * A test asking WHICH of several keys the cursor landed on must not wait for
 * the answer it wants: a screen that lands on the wrong one and corrects itself
 * a moment later satisfies the wait, and that correction is exactly the defect
 * (a confirmation panel that opens on Yes and moves to No is a doubled press
 * away from marking a season). Wait for the cursor to enter the REGION with
 * `focusEnters`, then read the identity.
 *
 * And a wait after a REMOUNT must come off the screen, not off this key: the
 * key is spatial navigation's own bookkeeping and survives an unmount, so the
 * cursor the previous screen left behind satisfies `focusBecomes` before the
 * new one has done anything. `setFocus("")` does not help - norigin returns
 * early on a falsy key without touching it.
 */
export async function focusBecomes(key: string): Promise<void> {
  await waitFor(() => expect(getCurrentFocusKey()).toBe(key));
}

/**
 * The same wait, where a test only cares that the screen answers at all.
 *
 * A key on its own is not an answer: norigin holds a key aimed at a focusable
 * that never mounted, and a cursor parked on one of those is the dead remote
 * this suite exists to catch. So the key has to name something on screen.
 *
 * `expected` is for the FAILURE MESSAGE and nothing else - it asserts nothing.
 * Where a test goes on to read which key it is, naming it here is what puts
 * both halves in the report when the cursor never becomes valid at all; the
 * read on the next line is still what checks it.
 */
export async function focusLands(expected?: string): Promise<void> {
  await waitFor(() => {
    const at = getCurrentFocusKey();
    expect(
      Boolean(at) && doesFocusableExist(String(at)),
      `the cursor is on nothing that exists (key: ${String(at)})` + (expected ? `; expected ${expected}` : ""),
    ).toBe(true);
  });
}

/**
 * Wait for the cursor to reach a group of keys, so which one can be asserted.
 *
 * The pairing is the point: the wait is satisfied by the FIRST key of the group
 * the cursor touches, and the assertion after it reads that key. A screen that
 * lands on the wrong member still fails, which a wait for the right member
 * would not.
 *
 * Its reach is one poll of `waitFor`, and that is worth knowing before relying
 * on it: a screen that lands wrong and corrects itself on the very next timer
 * turn is not seen by this either, because both landings happen before the
 * first poll. Measured - a correction 20 ms out is caught, one on the next
 * `setTimeout(..., 0)` is not. It buys the slow correction, not every one.
 *
 * Deliberately NOT `doesFocusableExist`, unlike `focusLands`. A key in the
 * group that names nothing on screen is a finding for the assertion after this
 * to report, not something to wait past: measured on a screen that parks the
 * cursor on a strip it never mounts and recovers 300 ms later - one swallowed
 * press - requiring existence here waits out the park and passes, while
 * stopping at it fails with `expected 'detail-seasons' to be 'detail-play'`.
 * A test that wants both asserts the existence itself.
 */
export async function focusEnters(prefix: string): Promise<void> {
  await waitFor(() => {
    const at = getCurrentFocusKey();
    expect(String(at).startsWith(prefix), `the cursor is on ${String(at)}`).toBe(true);
  });
}

export async function setFocus(focusKey: string): Promise<void> {
  await act(async () => {
    noriginSetFocus(focusKey);
    await drainScheduler();
  });
}

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

/**
 * Put the cursor back to nothing, mid-test.
 *
 * `setFocus("")` does not do it - norigin returns early on a falsy key - and
 * neither does unmounting the screen that held it. The key outlives its screen,
 * and norigin re-lights it by itself once a focusable registers under that name
 * again, with no application code involved. So a test that mounts a screen
 * after leaving the previous one on the same key cannot otherwise tell a build
 * that restores the cursor from one that restores nothing at all.
 *
 * Rebuilding the service is the only clear there is - it is what `afterEach`
 * does between tests. It drops every registered focusable with it, so this
 * belongs between an unmount and the next render, never while a screen is up.
 *
 * The `setFocus("")` first is not the clear, and it is not decoration either:
 * it cannot touch the key, but it DOES cancel the auto-restore norigin arms
 * when a focused child is removed while its parent survives - a 300 ms
 * debounce that `destroy()` leaves running, to fire against the rebuilt service
 * and move the cursor on its own a third of a second later. Unmounting a whole
 * screen arms nothing, so no caller here needs it; a caller that drops one row
 * would.
 */
export async function clearFocus(): Promise<void> {
  await act(async () => {
    noriginSetFocus("");
    await drainScheduler();
  });
  destroy();
  init(config);
}

// Register the harness layoutAdapter + norigin init/teardown for a suite. Call
// once at the top of a test file (before describe). Focusables from an unmounted
// render are dropped by Testing Library's cleanup between tests. The partial
// layoutAdapter object is Object.assign-ed over the library's default web
// adapter, so key handling and DOM focus stay stock - only geometry is ours.
export function setupRemote(): void {
  beforeAll(() => init(config));
  // Unmounting a render does not put the CURSOR back: norigin keeps its current
  // focus key, and the next test's fresh render re-registers a focusable under that
  // name - which fires its onFocus and drives the app before a single key is
  // pressed. A test asserting where a screen opens then depends on the test above
  // it, and `--sequence.shuffle.tests` says so. `setFocus("")` does not clear it, so
  // the service itself is rebuilt between tests.
  afterEach(async () => {
    cleanup();
    await clearFocus();
  });
  afterAll(() => destroy());
}

export { getCurrentFocusKey };
