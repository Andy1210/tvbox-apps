import { describe, it, expect, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Summary } from "../Summary";
import { setupRemote, setFocus, flushFocus, remote } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";

// The synopsis is the only part of a detail screen whose height depends on the
// SERVER's text, and on a season screen it is rewritten every time the cursor
// moves to another episode. So a two-line blurb followed by a six-line one moved
// everything under it, artwork included, and the page jumped on every press.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

/**
 * happy-dom does no layout, so overflow has to be stated.
 *
 * On BOTH prototypes, and that is not belt and braces: happy-dom defines
 * scrollHeight on Element and clientHeight on HTMLElement, so stubbing one
 * prototype left the other reading its real zero - which said "overflowing"
 * for every text and made this file pass against a broken component.
 */
function withOverflow(overflowing: boolean): () => void {
  const saved: [object, string, PropertyDescriptor | undefined][] = [];
  const set = (proto: object, prop: string, value: number): void => {
    saved.push([proto, prop, Object.getOwnPropertyDescriptor(proto, prop)]);
    Object.defineProperty(proto, prop, { configurable: true, get: () => value });
  };
  for (const proto of [Element.prototype, HTMLElement.prototype]) {
    set(proto, "scrollHeight", overflowing ? 400 : 50);
    set(proto, "clientHeight", 100);
  }
  return () => {
    for (const [proto, prop, d] of saved.reverse()) {
      if (d) Object.defineProperty(proto, prop, d);
      else delete (proto as Record<string, unknown>)[prop];
    }
  };
}

afterEach(() => setFocus(""));

describe("the synopsis box", () => {
  it("is the same height whatever the server wrote", () => {
    const restore = withOverflow(false);
    const short = render(<Summary text="Rövid." />);
    const a = short.container.querySelector("p")!.style.height;
    short.unmount();

    const long = render(<Summary text={"Hosszú. ".repeat(120)} />);
    const b = long.container.querySelector("p")!.style.height;
    long.unmount();
    restore();

    expect(a).toBeTruthy();
    expect(b, "a longer synopsis must not make a taller box").toBe(a);
  });

  it("opens on OK when something is hidden", async () => {
    const restore = withOverflow(true);
    const view = render(<Summary text={"Hosszú. ".repeat(120)} />);
    const { container } = view;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => setFocus("detail-summary"));
    await flushFocus();

    expect(container.querySelector("p")!.style.height, "collapsed to a fixed height first").toBeTruthy();
    await remote.ok();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    const p = container.querySelector("p")!;
    expect(p.style.height, "opened, so the fixed height is released").toBe("");
    expect(p.style.maxHeight).toBe("34vh");
    view.unmount();
    restore();
  });

  it("is not a stop on the way to the buttons when it all fits", async () => {
    // A focusable that answers OK with nothing is worse than no focusable: it
    // costs a press on the way down and gives nothing back. norigin refuses
    // onEnterPress on a component that is not focusable, which is what this
    // asserts through the real key path.
    const restore = withOverflow(false);
    const view = render(<Summary text="Rövid." />);
    const { container } = view;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => setFocus("detail-summary"));
    await flushFocus();

    await remote.ok();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.querySelector("p")!.style.height, "nothing was hidden, so OK must not open it").toBeTruthy();
    view.unmount();
    restore();
  });
});
