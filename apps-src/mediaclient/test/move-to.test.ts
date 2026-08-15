import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { createMover, nearest } from "../moveTo";

/**
 * Moving a long list without repainting it.
 *
 * The technique is Plex's, read out of its own bundle: it does not scroll -
 * there is no `scrollIntoView` and no `scroll-behavior` anywhere in it -
 * positions are translations and movement is a Web Animations keyframe pair on
 * `transform`, which the compositor runs without layout, paint or raster.
 */

function element(): HTMLElement & { animations: { keyframes: unknown; opts: unknown; cancelled: boolean }[] } {
  const el = document.createElement("div") as never as HTMLElement & {
    animations: { keyframes: unknown; opts: unknown; cancelled: boolean }[];
  };
  el.animations = [];
  (el as unknown as { animate: unknown }).animate = (keyframes: unknown, opts: unknown) => {
    const rec = { keyframes, opts, cancelled: false };
    el.animations.push(rec);
    return { cancel: () => (rec.cancelled = true) } as unknown as Animation;
  };
  return el;
}

let el: ReturnType<typeof element>;
beforeEach(() => {
  el = element();
});

describe("the mover", () => {
  it("animates a step and jumps a destination", () => {
    const m = createMover("y");
    m.attach(el);

    m.to(400, true);
    expect(el.animations.length, "a step is animated").toBe(1);
    expect(m.at).toBe(400);

    m.to(9000, false);
    expect(el.animations.length, "a jump adds no animation").toBe(1);
    expect(el.style.transform).toBe("translateY(-9000px)");
  });

  it("leaves the element where the animation ends, not where it began", () => {
    // `fill: "forwards"` holds it only while the animation exists; the style is
    // set as well, so cancelling the next one cannot snap the list back.
    const m = createMover("y");
    m.attach(el);
    m.to(400, true);

    expect(el.style.transform).toBe("translateY(-400px)");
    expect((el.animations[0].opts as { fill: string }).fill).toBe("forwards");
  });

  it("cancels the previous animation rather than composing with it", () => {
    // Two transform animations on one element COMPOSE. A held arrow would
    // otherwise send the list somewhere neither press asked for.
    const m = createMover("y");
    m.attach(el);
    m.to(400, true);
    m.to(800, true);

    expect(el.animations[0].cancelled, "the first is cancelled").toBe(true);
    expect(el.animations.length).toBe(2);
    expect(m.at).toBe(800);
  });

  it("keeps its position across the element being replaced", () => {
    // The filter panel replaces the grid rather than covering it, so the moved
    // layer unmounts and a fresh one arrives. Losing the offset there is what
    // used to leave the window computed for one position and the DOM at another.
    const m = createMover("y");
    m.attach(el);
    m.to(1200, false);

    const fresh = element();
    m.attach(fresh);
    expect(fresh.style.transform).toBe("translateY(-1200px)");
    expect(m.at).toBe(1200);
  });

  it("never moves above the top", () => {
    const m = createMover("y");
    m.attach(el);
    m.to(-500, false);
    expect(m.at).toBe(0);
  });
});

describe("where a row has to put the window", () => {
  const win = { viewport: 1000, size: 340, max: 34000 };

  it("does not move for a row already inside it", () => {
    // Which is what stops a sideways press from nudging the grid.
    expect(nearest({ at: 0, start: 340, ...win })).toBe(0);
  });

  it("brings a row above into view, and one below", () => {
    expect(nearest({ at: 1000, start: 680, ...win })).toBe(680);
    expect(nearest({ at: 0, start: 1020, ...win })).toBe(1020 + 340 - 1000);
  });

  it("keeps a row off the very edge, where a television crops", () => {
    const padded = nearest({ at: 1000, start: 680, padStart: 40, ...win });
    expect(padded).toBe(640);
  });

  it("stops at the end of the list", () => {
    expect(nearest({ at: 0, start: 33800, ...win })).toBe(34000 - 1000);
  });
});

describe("the rails move themselves too", () => {
  it("neither the grid nor a row is scrolled by anything", () => {
    // Both were native scrollers, and both re-rastered per frame what a
    // transform moves. A row also loads data as the cursor crosses it - a
    // season's cast and description follow the highlighted episode - so it had
    // the same cost with more landing inside the animation.
    //
    // Asserted on what is unambiguous across both files. The letter strip is
    // still a small native scroller and legitimately so, which is why this does
    // not sweep the whole file for `overflow`.
    for (const file of ["Library.tsx", "Row.tsx"]) {
      const src = readFileSync(resolve(process.cwd(), "apps-src/mediaclient", file), "utf8");
      expect(src, `${file} must not scroll`).not.toContain("scrollTo(");
      expect(src, `${file} hands movement to the container`).toContain("selfScroll={false}");
      expect(src, `${file} moves a layer`).toContain("mover.attach(node)");
    }
  });
});

describe("the coordinates a mover is driven with", () => {
  it("come from the layer it moves, in a row", () => {
    // The bug this pins: a tile's `offsetLeft` is measured against the nearest
    // POSITIONED ancestor, and the row's maths moves the layer the tiles sit
    // in. With that layer unpositioned the two were different coordinate
    // spaces, so every press computed a target in the wrong frame - the rail
    // lurched back and forth and the cursor ended up off screen, while the
    // animation itself stayed perfectly smooth. It looks like a scrolling bug
    // and it is an arithmetic one.
    const src = readFileSync(resolve(process.cwd(), "apps-src/mediaclient/Row.tsx"), "utf8");

    // The moved layer is positioned, so it IS the offset parent.
    const layer = /<div\s+ref=\{\(node\) => \{[^}]*mover\.attach\(node\)[\s\S]{0,200}?className="([^"]*)"/.exec(src);
    expect(layer, "the moved layer is still identifiable").toBeTruthy();
    expect(layer![1], "the layer must be the offset parent").toContain("relative");

    // And the travel is bounded by that layer's width, not by a window that no
    // longer scrolls.
    expect(src).toContain("layer.current?.scrollWidth");
  });

  it("come from the row index in the grid, which needs no element at all", () => {
    // The grid does not have this problem because it never measures a tile: it
    // knows the row and the row height. Worth stating - it is why the same
    // change was correct there and wrong here.
    const src = readFileSync(resolve(process.cwd(), "apps-src/mediaclient/Library.tsx"), "utf8");
    expect(src).toContain("start: row * rowHeight");
    expect(src).not.toContain("offsetLeft");
  });
});

describe("where a moving rail is cut", () => {
  it("is cut at the inset, not at the screen edge", () => {
    // `overflow` clips at the PADDING box, so a rail that carries its own
    // horizontal inset stays visible inside that inset - a tile sliding out of
    // the row ran all the way to the screen edge instead of disappearing at the
    // margin. The inset therefore sits on a wrapper OUTSIDE the clipping
    // element.
    const src = readFileSync(resolve(process.cwd(), "apps-src/mediaclient/Row.tsx"), "utf8");
    const clip = /className="no-scrollbar overflow-hidden([^"]*)"/.exec(src);
    expect(clip, "the clipping element is still identifiable").toBeTruthy();
    expect(clip![1], "no horizontal inset on the element that clips").not.toMatch(/px-|pl-|pr-/);
    // The vertical padding stays inside it, and for the opposite reason: it is
    // the room a focus ring needs, and a ring drawn outside the tile's box is
    // exactly what the clip would cut.
    expect(clip![1]).toContain("py-");
  });

  it("keeps the grid's own padding inside its clip, which is not a contradiction", () => {
    // The grid only moves vertically, so nothing can slide out sideways under
    // its horizontal inset - and its vertical padding is the focus ring's room,
    // which has to be inside the clip to be of any use.
    const src = readFileSync(resolve(process.cwd(), "apps-src/mediaclient/Library.tsx"), "utf8");
    const clip = /className="no-scrollbar relative flex-1 overflow-hidden([^"]*)"/.exec(src);
    expect(clip, "the grid window is still identifiable").toBeTruthy();
    expect(clip![1]).toMatch(/p[tb]-/);
  });
});
