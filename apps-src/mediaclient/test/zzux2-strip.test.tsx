import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Library } from "../Library";
import { Settings } from "../Settings";
import { useApp } from "../state";
import { setupRemote, place, remote, setFocus, getCurrentFocusKey, flushFocus } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaBackend, MediaItem } from "../backends/types";

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const LETTERS = ["#", ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)), "Ő", "Ű"];
const TOTAL = 1700;

function item(n: number): MediaItem {
  return { id: `i${n}`, kind: "movie", title: `Film ${n}`, thumb: `/t/${n}` };
}

let offsetCalls = 0;

function stubBackend(over: Partial<MediaBackend> = {}): MediaBackend {
  return {
    kind: "plex",
    libraryPage: async (_id: string, q: { offset: number; limit: number }) => ({
      items: Array.from({ length: Math.min(q.limit, TOTAL - q.offset) }, (_, i) => item(q.offset + i)),
      total: TOTAL,
    }),
    letters: async () => LETTERS.map((l) => ({ key: l, title: l, size: 50 })),
    letterOffset: async () => {
      offsetCalls += 1;
      return 700;
    },
    posterUrl: () => undefined,
    imageHeaders: () => ({}),
    ...over,
  } as unknown as MediaBackend;
}

beforeEach(async () => {
  offsetCalls = 0;
  useApp.setState({ backend: stubBackend(), screen: { name: "home" }, history: [], failure: null });
  await act(async () => setFocus(""));
});

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
  }
}

/**
 * Lay out the library the way it draws at 1080p: seven columns across the
 * scroller, the A-Z strip in the gutter to its right, and the "Sort and filter"
 * button in the header above.
 */
function layOut(container: HTMLElement): { cells: HTMLElement[]; letters: HTMLElement[] } {
  const all = [...container.querySelectorAll<HTMLElement>("div.transition-transform")];
  // The arrange button is the only FocusButton outside the strip; tiles are
  // plain divs carrying the focus ref, so they are found by their caption.
  const arrange = all.find((el) => (el.textContent ?? "").includes("Sort and filter"));
  const letterEls = all.filter((el) => LETTERS.includes((el.textContent ?? "").trim()));
  if (arrange) place(arrange, 300, 20, 260, 48);

  // 29 letters over the 989px below the header, at 1.9vh / leading 1.35.
  const lineH = Math.round(1080 * 0.019 * 1.35);
  const gap = Math.round(1080 * 0.002);
  const stripH = letterEls.length * lineH + (letterEls.length - 1) * gap;
  const stripTop = 91 + (989 - stripH) / 2;
  letterEls.forEach((el, i) => place(el, 1790, stripTop + i * (lineH + gap), 40, lineH));
  // The strip's own container: spatial navigation resolves a move OUT of the
  // grid against the container box, not against the letters inside it.
  const strip = letterEls[0]?.parentElement;
  if (strip) place(strip, 1782, 91, 60, 989);
  // The grid container, likewise. Its ref is attached to the scroller.
  const scroller = container.querySelector<HTMLElement>(".no-scrollbar.relative");
  if (scroller) place(scroller, 0, 91, 1728, 989);

  const cells: HTMLElement[] = [];
  const tiles = [...container.querySelectorAll<HTMLElement>("div.flex.shrink-0.flex-col")];
  tiles.forEach((el) => {
    const cell = el.parentElement as HTMLElement | null;
    if (!cell) return;
    const style = cell.getAttribute("style") ?? "";
    const top = Number(/top:\s*([\d.]+)px/.exec(style)?.[1] ?? "0");
    const leftPct = Number(/left:\s*([\d.]+)%/.exec(style)?.[1] ?? "0");
    // The scroller is 1728px wide (everything but the strip's gutter) with
    // px-[3vw] of padding; a tile is 26vh*2/3 = 187px.
    const x = 58 + (leftPct / 100) * 1612;
    // The page starts at the top: content coordinates are viewport coordinates.
    place(el, x, 91 + top, 187, 348);
    cells.push(el);
  });
  return { cells, letters: letterEls };
}

describe("the A-Z strip", () => {
  it("can be entered from the grid and left again", async () => {
    const { container } = render(<Library libraryId="1" title="Movies" />);
    await waitFor(() => expect(container.textContent).toContain("Film 0"));
    await settle();
    expect(getCurrentFocusKey()).toBe("cell-0");

    layOut(container);

    // Right along the top row to the last column, then once more into the strip.
    for (let i = 0; i < 6; i += 1) await remote.right();
    expect(getCurrentFocusKey()).toBe("cell-6");
    await remote.right();
    const entered = getCurrentFocusKey();
    // eslint-disable-next-line no-console
    console.log("PROBE Right from the last column:", entered);

    await remote.left();
    // eslint-disable-next-line no-console
    console.log("PROBE Left back out of the strip:", getCurrentFocusKey());

    // And from a cell lower down the page.
    await act(async () => setFocus("cell-13"));
    await remote.right();
    // eslint-disable-next-line no-console
    console.log("PROBE Right from the last column of row 2:", getCurrentFocusKey());
  });

  it("walks up and down inside the strip, and can leave the top", async () => {
    const { container } = render(<Library libraryId="1" title="Movies" />);
    await waitFor(() => expect(container.textContent).toContain("Film 0"));
    await settle();
    layOut(container);

    await act(async () => setFocus("letter-M"));
    await remote.down();
    // eslint-disable-next-line no-console
    console.log("PROBE Down inside the strip:", getCurrentFocusKey());
    await remote.up();
    await remote.up();
    // eslint-disable-next-line no-console
    console.log("PROBE two Ups inside the strip:", getCurrentFocusKey());

    await act(async () => setFocus("letter-#"));
    await remote.up();
    // eslint-disable-next-line no-console
    console.log("PROBE Up from the top letter:", getCurrentFocusKey());

    await act(async () => setFocus("letter-Ű"));
    await remote.down();
    // eslint-disable-next-line no-console
    console.log("PROBE Down from the bottom letter:", getCurrentFocusKey());
  });

  it("says what a letter press does and how long it takes", async () => {
    const scrolls: number[] = [];
    const { container } = render(<Library libraryId="1" title="Movies" />);
    await waitFor(() => expect(container.textContent).toContain("Film 0"));
    await settle();
    layOut(container);

    const scroller = container.querySelector<HTMLElement>(".no-scrollbar.relative");
    if (scroller) scroller.scrollTo = ((o: ScrollToOptions) => scrolls.push(o.top ?? -1)) as typeof scroller.scrollTo;

    await act(async () => setFocus("letter-S"));
    await remote.ok();
    await settle();
    // eslint-disable-next-line no-console
    console.log("PROBE after pressing a letter:", {
      focus: getCurrentFocusKey(),
      letterOffsetCalls: offsetCalls,
      scrolledTo: scrolls,
    });
  });

  it("shows no mark for where the grid currently is", async () => {
    const { container } = render(<Library libraryId="1" title="Movies" />);
    await waitFor(() => expect(container.textContent).toContain("Film 0"));
    await settle();
    const { letters } = layOut(container);
    // Every letter carries exactly the same classes: nothing distinguishes the
    // bucket the grid is showing from the other 28.
    const classes = new Set(letters.map((el) => el.className));
    // eslint-disable-next-line no-console
    console.log("PROBE distinct letter styles:", classes.size, [...classes]);
    expect(classes.size).toBe(1);
  });
});

describe("the settings screen", () => {
  beforeEach(() => {
    useApp.setState({
      backend: stubBackend(),
      screen: { name: "settings" },
      session: { serverName: "Plex", location: "lan", profileName: "Andy" },
      autologin: true,
      setAutologin: vi.fn(),
    } as never);
  });

  it("reaches every playback row", async () => {
    const { container } = render(<Settings />);
    await settle();
    const all = [...container.querySelectorAll<HTMLElement>("div.transition-transform")];
    const byText = (s: string): HTMLElement | undefined => all.find((el) => (el.textContent ?? "").includes(s));

    const autologin = byText("Start as");
    const size = byText("Subtitle size");
    const pos = byText("Subtitle position");
    const colour = byText("Subtitle colour");
    const skip = byText("Skip intro");
    const switchUser = byText("Switch user");
    const signOut = byText("Sign out");
    // eslint-disable-next-line no-console
    console.log(
      "PROBE settings buttons:",
      all.map((el) => (el.textContent ?? "").trim().slice(0, 40)),
    );

    if (autologin) place(autologin, 115, 300, 300, 50);
    // The playback row is flex-wrap; at 1080p these four are wide enough to wrap.
    if (size) place(size, 115, 430, 300, 50);
    if (pos) place(pos, 430, 430, 320, 50);
    if (colour) place(colour, 765, 430, 300, 50);
    if (skip) place(skip, 1080, 430, 420, 50);
    if (switchUser) place(switchUser, 115, 540, 260, 52);
    if (signOut) place(signOut, 390, 540, 220, 52);

    await act(async () => setFocus("settings-autologin"));
    await remote.down();
    // eslint-disable-next-line no-console
    console.log("PROBE Down from autologin:", getCurrentFocusKey());
    await remote.right();
    // eslint-disable-next-line no-console
    console.log("PROBE Right:", getCurrentFocusKey());
    await remote.right();
    // eslint-disable-next-line no-console
    console.log("PROBE Right:", getCurrentFocusKey());
    await remote.right();
    // eslint-disable-next-line no-console
    console.log("PROBE Right:", getCurrentFocusKey());
    await remote.down();
    // eslint-disable-next-line no-console
    console.log("PROBE Down from the last playback row:", getCurrentFocusKey());
  });

  it("says what the colour swatch looks like when the row is focused", async () => {
    const { container } = render(<Settings />);
    await settle();
    const all = [...container.querySelectorAll<HTMLElement>("div.transition-transform")];
    const colour = all.find((el) => (el.textContent ?? "").includes("Subtitle colour"));
    await act(async () => setFocus("settings-subcolor"));
    await flushFocus();
    const swatch = colour?.querySelector("span");
    // eslint-disable-next-line no-console
    console.log("PROBE focused colour row:", {
      rowClasses: colour?.className,
      swatchStyle: swatch?.getAttribute("style"),
      swatchClasses: swatch?.className,
    });
  });
});
