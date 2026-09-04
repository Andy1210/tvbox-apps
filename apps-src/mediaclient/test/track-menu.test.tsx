import { describe, it, expect, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { doesFocusableExist } from "@noriginmedia/norigin-spatial-navigation";
import { TrackMenu } from "../TrackMenu";
import {
  setupRemote,
  setFocus,
  getCurrentFocusKey,
  flushFocus,
  remote,
  place,
  focusLands,
  focusEnters,
} from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaVersion } from "../backends/types";

// The menu that is up while a film plays.
//
// Its job is to say which audio and which subtitle are on. Everything the
// subtitle SEARCH needs - three language chips, a button, an error line and a
// list of results - is noise against that, and noise on every film that already
// has the right subtitle, so it lives behind one row.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const versions: MediaVersion[] = [
  {
    index: 0,
    label: "1080p",
    partId: "1",
    parts: 1,
    partIndex: 0,
    audio: [{ ordinal: 0, id: "a0", kind: "audio", label: "Magyar" }],
    subtitles: [{ ordinal: 0, id: "s0", kind: "subtitle", label: "Magyar" }],
  } as unknown as MediaVersion,
];

function menu(over: Partial<React.ComponentProps<typeof TrackMenu>> = {}): React.JSX.Element {
  return (
    <TrackMenu
      versions={versions}
      current={{ version: 0 }}
      onChoose={() => {}}
      onClose={() => {}}
      onOpenSearch={() => {}}
      onCloseSearch={() => {}}
      onSearchSubtitles={() => {}}
      onSearchLanguage={() => {}}
      searchLanguage="hu"
      searchState="idle"
      found={[]}
      {...over}
    />
  );
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

describe("the subtitle search", () => {
  it("is one row on the track menu, not a column of its own", async () => {
    render(menu());
    await settle();
    await focusLands();

    expect(doesFocusableExist("sub-search"), "the way in is there").toBe(true);
    // None of what the search needs is on the menu itself.
    expect(doesFocusableExist("lang-hu"), "the language chips belong to the search").toBe(false);
    expect(document.body.textContent).not.toContain(en.tracks.searchResults);
  });

  it("takes the cursor with it when it opens", async () => {
    // The component does not remount, so the one-shot initial focus has already
    // fired - and every key on screen is replaced. Left behind, the cursor sits
    // on `sub-search`, which this view does not render, and the remote is dead
    // on the screen it has just opened.
    const view = render(menu());
    await settle();
    await focusLands();
    await act(async () => setFocus("sub-search"));
    await flushFocus();

    view.rerender(menu({ searchOpen: true }));
    await settle();
    // The view's own landing, not any landing: the cursor is already on a real
    // key here, so a wait for "something is lit" is over before this screen has
    // done anything at all.
    await focusEnters("lang-");

    const at = String(getCurrentFocusKey());
    expect(doesFocusableExist(at), `the cursor was left on ${at}`).toBe(true);
  });

  it("puts the cursor back on the row it came from", async () => {
    const view = render(menu({ searchOpen: true }));
    await settle();
    await focusLands();
    await act(async () => setFocus("lang-hu"));
    await flushFocus();

    view.rerender(menu());
    await settle();
    // Waited to the subtitle rows, then read: landing on a subtitle TRACK and
    // correcting is a different screen from landing on the row that was left,
    // and a wait for the answer itself would not tell them apart.
    await focusEnters("sub-");

    expect(getCurrentFocusKey()).toBe("sub-search");
  });

  it("marks the chosen language with a tick rather than a fill", async () => {
    // A filled chip is exactly what focus looks like in this app - a focused row
    // turns solid white - so the chosen language read as the focused one. Two
    // things claiming the same signal, and neither saying which was which.
    render(menu({ searchOpen: true, searchLanguage: "en" }));
    await settle();
    await focusLands();

    const chosen = rowFor("EN");
    const other = rowFor("HU");
    expect(chosen, "the chosen language is on screen").toBeTruthy();
    expect(chosen!.textContent).toContain("\u2713");
    expect(other!.textContent).not.toContain("\u2713");

    // The two rows are styled identically: the selection is expressed by the
    // mark and by nothing else. A chosen chip that also changed colour is what
    // made it look focused, and asserting "no fill" would pass on any fill this
    // app does not happen to use today.
    expect(chosen!.className).toBe(other!.className);
  });

  it("answers the remote in the search view", async () => {
    render(menu({ searchOpen: true }));
    await settle();
    await focusLands();

    await remote.down();
    await settle();
    const at = String(getCurrentFocusKey());
    expect(doesFocusableExist(at), `focus went to ${at}`).toBe(true);
  });
});

/**
 * The row for a language code.
 *
 * The label sits in its own span and the tick in a sibling, so this finds the
 * label and walks up to the row that holds both. By text rather than by a test
 * id, because the id would be the only reason the markup had one.
 */
function rowFor(code: string): Element | null {
  const label = Array.from(document.querySelectorAll("span")).find((e) => (e.textContent ?? "").trim() === code);
  return label?.closest("[class*='rounded-']") ?? null;
}

describe("the subtitle offset row", () => {
  /**
   * The boxes are the ones measured off a compositor screenshot on a box, at
   * the renderer's real 1920x1080: a subtitle row is 490 x 58, each offset
   * button 56 x 32.
   *
   * That ratio is the whole bug. norigin counts a candidate as an "adjacent
   * slice" only when it overlaps the focused element across the axis of travel
   * by a fifth of that element's width, and divides an adjacent candidate's
   * cost by five while leaving a diagonal one's alone. 56 of 490 is 11%, so the
   * buttons were permanently diagonal and the full-width row BEYOND them won by
   * roughly two to one - the highlight jumped clean over them in both
   * directions.
   */
  async function laid(): Promise<void> {
    const subs = [
      { ordinal: 0, id: "s0", kind: "subtitle" as const, label: "magyar", language: "magyar" },
      { ordinal: 1, id: "s1", kind: "subtitle" as const, label: "angol", language: "English" },
    ];
    render(
      menu({
        versions: [{ ...versions[0], subtitles: subs } as unknown as MediaVersion],
        onNudgeSubDelay: () => {},
        subDelaySec: 0,
        initial: "subtitles",
      }),
    );
    await settle();
    // The menu lands its own cursor on a timer; a landing that arrives after
    // this takes back whatever a test sets in between.
    await focusLands();
    const at = (key: string, x: number, y: number, w: number, h: number): void => {
      const node = document.querySelector(`[data-sfocus="${key}"]`);
      if (node) place(node, x, y, w, h);
    };
    // The subtitle column, top to bottom.
    at("sub-off", 715, 567, 490, 58);
    at("sub-0", 715, 625, 490, 58);
    at("sub-1", 715, 683, 490, 58);
    // The container is the fix: its box is the row's full width, so it wins
    // the way any other row does and the cursor then descends into it.
    at("sub-offset", 715, 789, 490, 50);
    at("sub-offset-down", 739, 798, 56, 32);
    at("sub-offset-up", 1125, 798, 56, 32);
    at("sub-search", 715, 849, 490, 58);
    // The columns either side, so the losers are actually in the race.
    at("aud-0", 180, 625, 490, 58);
    at("q-0", 1250, 625, 400, 58);
    at("tracks-close", 1500, 120, 195, 58);
  }

  it("is registered, which is not the same as reachable", async () => {
    // The wrong diagnosis somebody will reach for first. The buttons were
    // always there and always worked once focused; nothing could navigate to
    // them.
    await laid();
    expect(doesFocusableExist("sub-offset-down")).toBe(true);
    expect(doesFocusableExist("sub-offset-up")).toBe(true);
  });

  it("is where Down from the last subtitle lands", async () => {
    await laid();
    await setFocus("sub-1");
    await remote.down();
    expect(getCurrentFocusKey()).toBe("sub-offset-down");
  });

  it("is where Up from the search row lands", async () => {
    await laid();
    await setFocus("sub-search");
    await remote.up();
    expect(getCurrentFocusKey()).toBe("sub-offset-down");
  });

  it("hands Right from minus to plus, inside itself", async () => {
    await laid();
    await setFocus("sub-offset-down");
    await remote.right();
    expect(getCurrentFocusKey()).toBe("sub-offset-up");
  });

  it("lets Down out again, rather than trapping the cursor", async () => {
    await laid();
    await setFocus("sub-offset-up");
    await remote.down();
    expect(getCurrentFocusKey()).toBe("sub-search");
  });

  describe("crossing the menu past the offset row", () => {
    it("lets Left out of minus reach the audio column", async () => {
      // The direction this row's own history records breaking: an earlier design
      // swallowed Left and Right to nudge the value, and "crossing the menu
      // sideways was impossible". A container that kept the cursor would bring
      // that back by another route.
      await laid();
      await setFocus("sub-offset-down");
      await remote.left();
      expect(getCurrentFocusKey()).toBe("aud-0");
    });

    it("lets Right out of plus reach the quality column", async () => {
      await laid();
      await setFocus("sub-offset-up");
      await remote.right();
      expect(getCurrentFocusKey()).toBe("q-0");
    });

    it("lets Up out of the row reach the subtitle above it", async () => {
      await laid();
      await setFocus("sub-offset-down");
      await remote.up();
      expect(getCurrentFocusKey()).toBe("sub-1");
    });

    it("enters at the same end every time", async () => {
      // Measured on a box before this: the row remembered which button was used
      // last, so the same press from the same row landed at the left end one time
      // and the right end the next. Nudging never leaves the button, so there was
      // nothing to remember for.
      await laid();
      await setFocus("sub-1");
      await remote.down();
      expect(getCurrentFocusKey()).toBe("sub-offset-down");
      await remote.right();
      expect(getCurrentFocusKey()).toBe("sub-offset-up");
      await remote.down();
      await remote.up();
      expect(getCurrentFocusKey(), "back in at the same end as the first time").toBe("sub-offset-down");
    });
  });

  describe("the offset row while the cursor is in it", () => {
    /** The row's own container, which is the only element with this key. */
    const row = (): HTMLElement | null => document.querySelector('[data-sfocus="sub-offset"]');

    it("lifts, and settles again when the cursor leaves", async () => {
      // Assert the CLASS, not a focus key. Every test this row shipped with
      // asserted keys, and the lift was dead code for a whole round: norigin
      // only updates `hasFocusedChild` for a parent that asked to track, and
      // the default is not to. 671 green tests saw nothing.
      await laid();
      await setFocus("sub-1");
      expect(row()?.className, "unlifted while the cursor is above it").toContain("bg-white/5");

      await remote.down();
      expect(getCurrentFocusKey()).toBe("sub-offset-down");
      expect(row()?.className, "lifted with the cursor inside").toContain("bg-white/15");

      await remote.down();
      expect(getCurrentFocusKey()).toBe("sub-search");
      expect(row()?.className, "and settled again").toContain("bg-white/5");
    });
  });
});
