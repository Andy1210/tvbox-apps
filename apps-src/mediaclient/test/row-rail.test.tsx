import { describe, it, expect } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Row } from "../Row";
import { setupRemote, setFocus, flushFocus, placeRow } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaItem } from "../backends/types";

/**
 * A rail that gets a new list starts where the list does.
 *
 * The offset is only recomputed when a tile takes focus, and nothing else
 * re-clamps it - a native scroller got that from the browser and this is not
 * one. So searching again while the first rail was scrolled opened it on empty
 * space: the heading with nothing under it, correcting itself only when
 * something in it was focused, which hides the cause behind the fix.
 *
 * The three Rows on the search screen keep their identity across queries, which
 * is what makes this reachable there.
 */

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const TILE_W = 200;
const VIEWPORT = 1000;

function list(prefix: string, n: number): MediaItem[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, kind: "movie", title: `${prefix} ${i}` }));
}

function tiles(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll("div.flex.shrink-0.flex-col"));
}

/** What the rail has been translated to, in px. */
function offsetOf(container: HTMLElement): number {
  const layer = container.querySelector<HTMLElement>("div.relative.flex");
  const m = /translateX\((-?[\d.]+)px\)/.exec(layer?.style.transform ?? "");
  // `|| 0` so a negative zero compares as zero: the transform for "at the
  // start" is written translateX(-0px).
  return m ? -Number(m[1]) || 0 : 0;
}

/**
 * Give the rail a real width, and the layer real content.
 *
 * happy-dom has no layout: without this the clip measures 0 and every offset
 * computed from it is 0, so the test would agree with any implementation.
 */
function size(container: HTMLElement, count: number): void {
  const clip = container.querySelector<HTMLElement>("div.no-scrollbar");
  const layer = container.querySelector<HTMLElement>("div.relative.flex");
  if (!clip || !layer) throw new Error("the rail is not in the tree");
  Object.defineProperty(clip, "clientWidth", { value: VIEWPORT, configurable: true });
  // A getter, not a value: the component re-clamps in an effect that runs
  // BEFORE this helper is called again, so a fixed number would hand it the
  // previous list's width and the test would agree with a broken clamp.
  Object.defineProperty(layer, "scrollWidth", {
    get: () => tiles(container).length * TILE_W,
    configurable: true,
  });
  void count;
  const els = tiles(container);
  placeRow(els, { cellW: TILE_W, cellH: 300, gapX: 0 });
  els.forEach((el, i) => {
    Object.defineProperty(el, "offsetLeft", { value: i * TILE_W, configurable: true });
    Object.defineProperty(el, "offsetWidth", { value: TILE_W, configurable: true });
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
  }
}

describe("a rail whose list is replaced", () => {
  it("goes back to the beginning for a different list", async () => {
    const { container, rerender } = render(
      <Row id="search-movies" title="Films" items={list("a", 12)} posterUrl={() => undefined} onSelect={() => {}} />,
    );
    size(container, 12);
    await settle();
    await setFocus("search-movies-a11");
    await settle();
    expect(offsetOf(container)).toBeGreaterThan(0);

    // The same rail, a different search.
    rerender(
      <Row id="search-movies" title="Films" items={list("b", 4)} posterUrl={() => undefined} onSelect={() => {}} />,
    );
    size(container, 4);
    await settle();

    // Not "somewhere sensible" - at the start. Four tiles fit the viewport, so
    // any offset at all puts the first result off the left edge.
    expect(offsetOf(container)).toBe(0);
  });

  it("goes back for a new list that kept the same top hit", async () => {
    // Refining a search - "star" to "star wars" - routinely keeps the first
    // result and replaces everything behind it. Deciding on the first id alone
    // read that as the same list, so the rail opened part-way into results
    // nobody had looked at.
    const { container, rerender } = render(
      <Row id="search-films" title="Films" items={list("a", 12)} posterUrl={() => undefined} onSelect={() => {}} />,
    );
    size(container, 12);
    await settle();
    await setFocus("search-films-a11");
    await settle();
    expect(offsetOf(container)).toBeGreaterThan(0);

    const refined = [list("a", 1)[0], ...list("z", 11)];
    rerender(
      <Row id="search-films" title="Films" items={refined} posterUrl={() => undefined} onSelect={() => {}} />,
    );
    size(container, 12);
    await settle();

    expect(offsetOf(container)).toBe(0);
  });

  it("keeps its place when the same list only grows", async () => {
    const { container, rerender } = render(
      <Row id="row-episodes" title="Episodes" items={list("e", 12)} posterUrl={() => undefined} onSelect={() => {}} />,
    );
    size(container, 12);
    await settle();
    await setFocus("row-episodes-e11");
    await settle();
    const was = offsetOf(container);
    expect(was).toBeGreaterThan(0);

    // A page of the same list arriving: the first item is unchanged, so the
    // cursor's place has to survive it.
    rerender(
      <Row id="row-episodes" title="Episodes" items={list("e", 20)} posterUrl={() => undefined} onSelect={() => {}} />,
    );
    size(container, 20);
    await settle();

    expect(offsetOf(container)).toBe(was);
  });

  it("clamps to what is left when the same list shrinks", async () => {
    const { container, rerender } = render(
      <Row id="row-deck" title="Continue" items={list("d", 12)} posterUrl={() => undefined} onSelect={() => {}} />,
    );
    size(container, 12);
    await settle();
    await setFocus("row-deck-d11");
    await settle();
    expect(offsetOf(container)).toBeGreaterThan(0);

    // Same first item, fewer behind it - a watched film leaving the deck.
    rerender(
      <Row id="row-deck" title="Continue" items={list("d", 7)} posterUrl={() => undefined} onSelect={() => {}} />,
    );
    size(container, 7);
    await settle();

    // The end of the content, not past it: 7 tiles of 200 against a 1000 window.
    expect(offsetOf(container)).toBe(7 * TILE_W - VIEWPORT);
  });
});

describe("what a rail thinks it can see", () => {
  it("is the content box, not the padded one", async () => {
    // `clientWidth` INCLUDES padding, and the clip carries a small horizontal
    // padding as room for the focus ring - a ring is drawn outside a tile's
    // box and this element clips. Counting that room as usable width made the
    // rail believe it could see more than it can, so it under-scrolled by
    // exactly that and the last tile arrived cropped on the right while the
    // left looked correct. The asymmetry is the tell: an error in the width
    // only shows at the end you scroll towards.
    const PAD = 16;
    const { container } = render(
      <Row id="row-pad" title="Episodes" items={list("p", 12)} posterUrl={() => undefined} onSelect={() => {}} />,
    );
    size(container, 12);
    const clip = container.querySelector<HTMLElement>("div.no-scrollbar");
    clip!.style.paddingLeft = `${PAD}px`;
    clip!.style.paddingRight = `${PAD}px`;
    await settle();

    await setFocus("row-pad-p11");
    await settle();

    // The end of the content against the CONTENT width. With the padding
    // counted as usable this stops 2 * PAD short, which is where the crop
    // came from.
    expect(offsetOf(container)).toBe(12 * TILE_W - (VIEWPORT - 2 * PAD));
  });
});
