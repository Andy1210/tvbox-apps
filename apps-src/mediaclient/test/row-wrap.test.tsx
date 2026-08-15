import { describe, it, expect, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Row } from "../Row";
import { setupRemote, setFocus, getCurrentFocusKey, flushFocus, remote, placeRow } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaItem } from "../backends/types";

/**
 * Both ends of a rail behave the same way.
 *
 * They did not, and the reason was that neither end was handled at all: with no
 * candidate in that direction spatial navigation goes up to the container, and
 * the container restores its LAST FOCUSED child. From the first tile that looks
 * like a jump to the end of the row; from the last tile the last focused child
 * IS the last tile, so it looks like nothing happening. One behaviour, visible
 * once, and reported as two different bugs.
 */

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const items: MediaItem[] = Array.from({ length: 6 }, (_, i) => ({
  id: `e${i}`,
  kind: "episode",
  title: `Episode ${i}`,
}));

function row(): React.JSX.Element {
  return <Row id="children-s1" title="Episodes" items={items} posterUrl={() => undefined} onSelect={() => {}} />;
}

/**
 * The tiles, as the harness needs them.
 *
 * A Tile's root is the only element carrying all three of these classes, and
 * the selector matters: without real rectangles the harness places nothing and
 * every navigation result is luck rather than geometry - which is exactly how
 * the first version of this file passed against the bug it was written for.
 */
function tiles(container: HTMLElement, n: number): Element[] {
  const found = Array.from(container.querySelectorAll("div.flex.shrink-0.flex-col"));
  if (found.length < n) throw new Error(`expected ${n} tiles, found ${found.length}`);
  return found.slice(0, n);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
  }
}

beforeEach(async () => {
  await act(async () => setFocus(""));
});

describe("the ends of a rail", () => {
  it("go round in both directions", async () => {
    const { container } = render(row());
    await settle();
    // Geometry, or the result is luck rather than navigation.
    placeRow(tiles(container, items.length));
    await flushFocus();

    await act(async () => setFocus("children-s1-e0"));
    await flushFocus();
    await remote.left();
    await settle();
    expect(getCurrentFocusKey(), "left off the first goes to the last").toBe("children-s1-e5");

    await remote.right();
    await settle();
    expect(getCurrentFocusKey(), "and right off the last comes back to the first").toBe("children-s1-e0");
  });

  it("does not wrap a rail with one tile", async () => {
    // A ring of one is a press that appears to do nothing, which is the thing
    // being fixed rather than a case of it.
    const { container } = render(
      <Row id="solo" title="One" items={[items[0]]} posterUrl={() => undefined} onSelect={() => {}} />,
    );
    await settle();
    placeRow(tiles(container, 1));
    await flushFocus();

    await act(async () => setFocus("solo-e0"));
    await flushFocus();
    await remote.right();
    await settle();
    expect(getCurrentFocusKey()).toBe("solo-e0");
  });
});

describe("a rail and the page it sits on", () => {
  it("asks the page to follow the cursor down", async () => {
    // The page still scrolls vertically, and it used to get that for free: a
    // tile's own scrollIntoView moved the rail sideways and the page downwards
    // in one call. Turning the tile's scrolling off - so it would stop fighting
    // the transform that moves the rail - took the vertical half with it, and
    // the home screen stopped following the cursor past the first row.
    //
    // It has to be the SECTION and not the tile: a tile lives inside a clip
    // that is not a scroller, so asking the browser to reveal it can only be
    // answered by moving something we move ourselves.
    const calls: { el: Element; opts: unknown }[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element, opts?: unknown) {
      calls.push({ el: this, opts });
    } as typeof original;

    try {
      const { container } = render(row());
      await settle();
      placeRow(tiles(container, items.length));
      await flushFocus();

      await act(async () => setFocus("children-s1-e2"));
      await settle();

      expect(calls.length, "something asked to be revealed").toBeGreaterThan(0);
      expect(
        calls.every((c) => c.el.tagName === "SECTION"),
        "only the section, never a tile",
      ).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
