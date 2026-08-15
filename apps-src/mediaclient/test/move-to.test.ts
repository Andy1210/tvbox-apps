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
