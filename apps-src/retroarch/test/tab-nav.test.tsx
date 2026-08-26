import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, screen } from "@testing-library/react";
import { configureI18n, useConfigStore } from "@sdk";
import {
  setupRemote,
  remote,
  setFocus,
  getCurrentFocusKey,
  place,
  placeGrid,
  flushFocus,
} from "../../_shared/test/remote";
import { RetroArchApp } from "../RetroArch";
import { __resetLibrary } from "../library";
import en from "../locales/en.json";
import hu from "../locales/hu.json";

/**
 * Reaching the tab row with the remote.
 *
 * The tabs are the only way to the console, artwork, scan, folder and saves
 * screens, and geometry cannot find them from the grid below: they sit far to the
 * right of the first cover, so every edge into them is wired by hand. A hop that
 * lands nowhere still swallows the press, which on a TV is a button that does
 * nothing at all - so what this asserts is where the cursor ENDS UP, not that a
 * handler ran.
 */

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const SYSTEMS = [
  {
    system: "Nintendo - NES",
    games: 2,
    withCover: 2,
    core: "nestopia",
    coreName: "Nestopia",
    override: null,
    candidates: [],
  },
  { system: "Nintendo - GBA", games: 2, withCover: 2, core: "mgba", coreName: "mGBA", override: null, candidates: [] },
  // A console whose playlist survived its roms. The rail still lists it, and the
  // grid beside it holds one button and no covers.
  { system: "Sega - Mega Drive", games: 0, withCover: 0, core: null, coreName: null, override: null, candidates: [] },
];
const GAMES: Record<string, { i: number; label: string; cover: boolean }[]> = {
  "Nintendo - NES": [
    { i: 0, label: "Contra", cover: true },
    { i: 1, label: "Metroid", cover: true },
    { i: 2, label: "Punch-Out", cover: true },
  ],
  "Nintendo - GBA": [
    { i: 0, label: "Advance Wars", cover: true },
    { i: 1, label: "Golden Sun", cover: true },
  ],
};

// A console whose list can be held in flight, because "the request was made while
// the list was still coming" is the state two of these tests are about.
let held = "";
let release: (() => void) | null = null;
// A game that refuses to start puts an error over a list that is still THERE, which
// is a different screen from a list that failed to read.
let playFails = false;
// A console whose list cannot be read at all, which is a different screen again:
// the error stays up until the NEXT console's list lands.
let failOn = "";
const hold = (system: string): void => {
  held = system;
};
const land = async (): Promise<void> => {
  const go = release;
  release = null;
  held = "";
  if (go) go();
  await flushFocus();
};

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    fetchSystems: vi.fn(async () => ({ systems: SYSTEMS, playing: false })),
    fetchGames: vi.fn(async (system: string) => {
      if (system === held) await new Promise<void>((r) => (release = r));
      if (system === failOn) throw new Error("cannot read");
      return { system, games: GAMES[system] ?? [] };
    }),
    play: vi.fn(async () => (playFails ? { ok: false, error: "no_core" } : { ok: true })),
  };
});

const TAB_LABELS = ["Games", "Consoles", "Covers", "Scan", "Folders", "Saves"];

// The harness measures the element the FOCUSABLE's ref is on, and several of these
// labels are a span or a caption inside it - so a rect put on what `getByText`
// returns is a rect on something norigin never looks at, and the whole row measures
// as a zero-size box at the origin. `up` returns the element that actually carries
// the ref: how far up depends on the component, so each caller says.
function up(el: HTMLElement | null, levels: number): HTMLElement | null {
  let node: HTMLElement | null = el;
  for (let i = 0; i < levels && node; i += 1) node = node.parentElement;
  return node;
}

const railLabel = (system: string): string => system.slice(system.indexOf(" - ") + 3);

/** Lay the screen out the way the box draws it: tabs top right, rail left, covers beside it. */
function layout(): void {
  // A tab's ref is on the element carrying the label itself.
  const tabs = TAB_LABELS.map((label) => screen.getByText(label));
  placeGrid([tabs], { originX: 600, originY: 0, cellW: 90, cellH: 40 });
  // A rail row's name is a <span> inside the focusable row.
  const rail = SYSTEMS.map((s) => up(screen.getByText(railLabel(s.system)), 1)).filter((el): el is HTMLElement =>
    Boolean(el),
  );
  placeGrid(
    rail.map((el) => [el]),
    { originX: 0, originY: 120, cellW: 160, cellH: 60 },
  );
  // The search button's own element carries both its icon and its label.
  const search = screen.queryByText("Search");
  if (search) place(search, 600, 60, 120, 40);
  // A cover's label is a <div> under the tile, which is the focusable.
  const covers = Object.values(GAMES)
    .flat()
    .map((g) => up(screen.queryByText(g.label), 1))
    .filter((el): el is HTMLElement => Boolean(el));
  placeGrid([covers], { originX: 240, originY: 120, cellW: 120, cellH: 200 });
}

async function open(): Promise<void> {
  render(<RetroArchApp onExit={vi.fn()} />);
  await flushFocus();
  await act(async () => {
    await Promise.resolve();
  });
  await flushFocus();
  layout();
}

beforeEach(() => {
  localStorage.clear();
  __resetLibrary();
  held = "";
  release = null;
  playFails = false;
  failOn = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
  );
  // The saves screen asks the shell whether this box can share app folders at all,
  // and says so plainly when it cannot - a screen with nothing on it to press. It
  // is the ANSWERING box that has something to walk into, so that is the one to
  // put a remote on.
  (globalThis as unknown as { tvbox: unknown }).tvbox = {
    shares: { list: async () => ({ ok: true, peers: [], shares: [] }) },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  useConfigStore.setState({ config: null } as never);
});

describe("the tab row is reachable from the games view", () => {
  it("the app opens with the cursor on the first cover, not on nothing", async () => {
    // The one moment the app moves the cursor with nobody asking. Before the
    // consoles have arrived there is no list and no console, and reading that as a
    // list that settled empty spends the request before there is anything to spend
    // it on - the grid then paints with no highlight anywhere, and where the cursor
    // turns up is whichever recovery net notices first.
    await open();

    expect(getCurrentFocusKey()).toBe("g-Nintendo - NES-0");
  });

  it("an error over a list that is still there does not eat the arrow", async () => {
    // A game that will not start leaves the covers in place and puts a panel over
    // them, so the list is non-empty while nothing on it is on screen. Committing
    // to it hands the cursor a key with no element behind it, and the recovery net
    // does not re-arm for a press - measured, every arrow after it did nothing.
    playFails = true;
    await open();
    await setFocus("g-Nintendo - NES-0");
    await flushFocus();

    await remote.ok();
    await flushFocus();
    expect(screen.getByText(en.retroarch.noCoreFor.replace("{system}", "Nintendo - NES"))).toBeTruthy();

    await setFocus("sys-Nintendo - NES");
    await flushFocus();
    layout();
    await remote.right();

    expect(getCurrentFocusKey()).toBe("search");
  });

  it("an error on screen does not answer for the console still being read", async () => {
    // An error is left up for the whole of the NEXT console's read, so "there is
    // nothing to commit to" has to wait for that read to finish. Answering right
    // with the error alone is a shortcut past the very list it was asked for - and
    // OK, which does not take the shortcut, would then disagree with it.
    playFails = true;
    await open();
    await setFocus("g-Nintendo - NES-0");
    await flushFocus();
    await remote.ok(); // a game that will not start: the error panel goes up
    await flushFocus();

    hold("Nintendo - GBA");
    await setFocus("sys-Nintendo - GBA");
    await flushFocus();
    layout();
    await remote.right(); // committed while the list is still coming
    await land();
    layout();

    expect(getCurrentFocusKey()).toBe("g-Nintendo - GBA-0");
  });

  it("a console that cannot be read leaves the rail walkable", async () => {
    // The app opens on a console whose list fails. The screen has a cursor either
    // way, so the first-list request is spent - left standing, it fires on whatever
    // console the person walks onto next and takes them out of the rail.
    failOn = "Nintendo - NES";
    await open();
    await setFocus("sys-Nintendo - NES");
    await flushFocus();
    layout();

    await remote.down();
    await flushFocus();

    expect(getCurrentFocusKey()).toBe("sys-Nintendo - GBA");
  });

  it("OK on a console that cannot be read still answers", async () => {
    // The error screen draws Search and nothing else to press. Reaching it depends
    // on the read being over, which the list's own flag cannot say on the failure
    // path unless the failure records which console it belongs to.
    failOn = "Nintendo - NES";
    await open();
    await setFocus("sys-Nintendo - NES");
    await flushFocus();
    layout();

    await remote.ok();
    await flushFocus();

    expect(getCurrentFocusKey()).toBe("search");
  });

  it("up from the top of the console rail lands on the tabs", async () => {
    await open();
    await setFocus("sys-Nintendo - NES");
    layout();

    await remote.up();

    expect(getCurrentFocusKey()).toBe("tab-games");
  });

  it("walking right along the tabs reaches Saves, opens it, and goes into it", async () => {
    await open();
    await setFocus("tab-games");
    layout();

    for (let i = 0; i < TAB_LABELS.length - 1; i += 1) await remote.right();
    expect(getCurrentFocusKey()).toBe("tab-saves");

    await remote.ok();
    await flushFocus();
    // Something only this screen draws. The tab labels are on screen in every
    // view, so asserting one of those would pass even if OK did nothing at all.
    expect(screen.getByText(en.retroarch.savesIntro)).toBeTruthy();

    // And the screen has to be enterable, which is the whole reason this tab was
    // reported unreachable: a way in that leads nowhere is the same dead end.
    await remote.down();
    expect(getCurrentFocusKey()).not.toBe("tab-saves");
  });

  it("right on a console with no games reaches the button the empty grid offers", async () => {
    await open();
    await setFocus("sys-Sega - Mega Drive");
    await flushFocus();
    layout();
    place(screen.getByText("Go to Scan"), 400, 200, 200, 50);

    await remote.right();

    expect(getCurrentFocusKey()).toBe("empty-action");
  });

  it("OK on a console with no games goes there too, rather than arming a jump", async () => {
    // OK and right are the same gesture from a sofa, and OK used to leave the
    // request armed: nothing happened on screen, and then the first console with
    // games that the cursor passed over threw focus out of the rail.
    await open();
    await setFocus("sys-Sega - Mega Drive");
    await flushFocus();
    layout();
    place(screen.getByText("Go to Scan"), 400, 200, 200, 50);

    await remote.ok();
    await flushFocus();
    expect(getCurrentFocusKey()).toBe("empty-action");

    // And the rail is still walkable afterwards: back into it and one arrow up, and
    // the cursor stays in the rail rather than being pulled into the covers.
    await setFocus("sys-Sega - Mega Drive");
    await flushFocus();
    layout();
    await remote.up();
    expect(getCurrentFocusKey()).toBe("sys-Nintendo - GBA");
  });

  it("a request made on one console is not answered by the next one's list", async () => {
    // The request names the console it was made on. Carried across, it fires when
    // some other console's list lands - and the person was only walking the rail.
    hold("Nintendo - GBA");
    await open();
    await setFocus("sys-Nintendo - GBA");
    await flushFocus();
    layout();

    await remote.ok(); // asks for GBA's covers, which are still coming
    await setFocus("sys-Sega - Mega Drive"); // ...and moves on before they land
    await flushFocus();
    await land();
    layout();

    expect(getCurrentFocusKey()).toBe("sys-Sega - Mega Drive");
  });

  it("a box that opens on an empty console keeps its first arrow in the rail", async () => {
    // The first list of a session is the one case that moves the cursor with nobody
    // asking, so that it opens on the covers. An empty first list used to leave that
    // standing, and the next list to arrive - a console being walked past - was
    // treated as the one somebody had asked for.
    localStorage.setItem("tvbox.retroarch.system", "Sega - Mega Drive");
    await open();
    await setFocus("sys-Sega - Mega Drive");
    await flushFocus();
    layout();

    await remote.up();
    await flushFocus();

    expect(getCurrentFocusKey()).toBe("sys-Nintendo - GBA");
  });

  it("a search that finds nothing, and clearing it, both leave the cursor somewhere", async () => {
    // Two moments where the element under the cursor stops existing. The keyboard
    // unmounts when a search is committed, and on a screen with no matches there is
    // no grid and no empty-library button to answer with; Clear unmounts itself,
    // because clearing the search is what takes the button away.
    await open();
    await setFocus("search");
    await remote.ok();
    await flushFocus();

    await setFocus("osk-0-0");
    await remote.ok();
    await setFocus("osk-0-1");
    await remote.ok();
    await setFocus("osk-done");
    await remote.ok();
    await flushFocus();

    expect(screen.getByText(en.retroarch.noMatch)).toBeTruthy();
    expect(getCurrentFocusKey()).toBe("search");

    await setFocus("search-clear");
    await remote.ok();
    await flushFocus();

    expect(getCurrentFocusKey()).toBe("search");
  });

  it("a cover's neighbour is decided by where it is, not by the order it mounted", async () => {
    // What this really pins is the layout above. A focusable whose rect was never
    // set measures as a zero-size box at the origin, and with every candidate at
    // the origin the arrows still MOVE - in mount order - so an ordinary step along
    // a row passes just as well against a screen that was never laid out. So the
    // three covers go down in an order that is not their mount order, and only a
    // rect on the element each focusable's ref is really on gives this answer.
    await open();
    // Only the console the cursor is on has its covers mounted, so choose one.
    await setFocus("sys-Nintendo - NES");
    await flushFocus();
    layout();
    const tile = (label: string): HTMLElement => up(screen.getByText(label), 1) as HTMLElement;
    placeGrid([[tile("Contra"), tile("Punch-Out"), tile("Metroid")]], {
      originX: 240,
      originY: 120,
      cellW: 120,
      cellH: 200,
    });
    await setFocus("g-Nintendo - NES-2"); // Punch-Out, in the middle of the row

    await remote.left();

    expect(getCurrentFocusKey()).toBe("g-Nintendo - NES-0"); // Contra, to its left
  });
});
