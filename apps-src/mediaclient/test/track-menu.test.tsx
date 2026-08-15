import { describe, it, expect, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { doesFocusableExist } from "@noriginmedia/norigin-spatial-navigation";
import { TrackMenu } from "../TrackMenu";
import { setupRemote, setFocus, getCurrentFocusKey, flushFocus, remote } from "./remote";
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
    await act(async () => setFocus("sub-search"));
    await flushFocus();

    view.rerender(menu({ searchOpen: true }));
    await settle();

    const at = String(getCurrentFocusKey());
    expect(doesFocusableExist(at), `the cursor was left on ${at}`).toBe(true);
    expect(at.startsWith("lang-"), `the cursor was left on ${at}`).toBe(true);
  });

  it("puts the cursor back on the row it came from", async () => {
    const view = render(menu({ searchOpen: true }));
    await settle();
    await act(async () => setFocus("lang-hu"));
    await flushFocus();

    view.rerender(menu());
    await settle();

    expect(getCurrentFocusKey()).toBe("sub-search");
  });

  it("marks the chosen language with a tick rather than a fill", async () => {
    // A filled chip is exactly what focus looks like in this app - a focused row
    // turns solid white - so the chosen language read as the focused one. Two
    // things claiming the same signal, and neither saying which was which.
    render(menu({ searchOpen: true, searchLanguage: "en" }));
    await settle();

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
