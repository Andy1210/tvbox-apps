// Whose account this app is on, beside the way to change it.
//
// A box can have several Spotify accounts linked, and every screen here - the
// library, the songs, the buttons - is about one of them. Which one used to be a
// question you had to open the settings to answer, and the answer decides whose
// liked songs a press plays.
//
// The label shares a flex row with the gear, so the thing that could break
// silently is the gear itself: a remote that cannot reach the settings is a dead
// end, and nothing on screen would say so.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { NowPlaying } from "../NowPlaying";
import { useSpotifyStore } from "../stores/spotify";
import { doesFocusableExist } from "@noriginmedia/norigin-spatial-navigation";
import { setupRemote, flushFocus, setFocus, getCurrentFocusKey, focusLands, clearFocus } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

vi.mock("../api", async () => {
  const real = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...real,
    // The player screen reads these on mount; neither is what these tests are about.
    playerState: vi.fn(async () => ({
      ok: true,
      connected: true,
      active: false,
      is_playing: false,
      shuffle: false,
      repeat: "off" as const,
    })),
    fetchQueue: vi.fn(async () => []),
    control: vi.fn(async () => ""),
  };
});

function playing(): void {
  useSpotifyStore.setState({
    state: {
      track_id: "t1",
      uri: "spotify:track:t1",
      title: "A Song",
      artist: "An Artist",
      album: "A Song",
      cover_url: "",
      artist_image_url: "",
      duration_ms: 200000,
      position_ms: 1000,
      is_playing: true,
      item_type: "Track",
      device_name: "tvbox",
    },
    at: Date.now(),
  });
}

let showing: (() => void) | null = null;

async function show(account?: string): Promise<HTMLElement> {
  // The one before it goes first. A test that shows two screens in a row left
  // both mounted, and the cursor it then set was answered by the older one -
  // which is also why the clear below is safe here and nowhere else.
  showing?.();
  showing = null;
  await clearFocus();

  const { container, unmount } = render(
    <NowPlaying connected account={account} onSettings={vi.fn()} onBrowse={vi.fn()} onExit={vi.fn()} />,
  );
  showing = unmount;
  // The screen's own cursor, waited for. It lands on a timer and aims at the
  // transport, so a test that puts the cursor on the gear and reads it back was
  // racing that landing: it arrived after the read on a busy runner and took
  // the cursor to the play button.
  await focusLands();
  return container as HTMLElement;
}

// By its focus key, which is what the app navigates by and what a rename of the
// accessible label cannot move.
const gearOf = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-sfocus="sp-gear"]');
const topRight = (el: HTMLElement) => gearOf(el)!.parentElement as HTMLElement;

beforeEach(async () => {
  useSpotifyStore.setState({ state: null, at: 0 });
  playing();
  // Testing Library unmounts the root between tests, so the handle below points
  // at a screen that is already gone. Calling it again is a no-op today and the
  // bookkeeping should not depend on that.
  showing = null;
  // Focus is library-global and outlives an unmount, so a leftover from the last
  // test would make the next one pass for the wrong reason - and `setFocus("")`
  // does not clear it, norigin returning early on a falsy key. The service is
  // rebuilt instead.
  await clearFocus();
});

describe("the account beside the gear", () => {
  it("names the linked account this app is on", async () => {
    const el = await show("Kata");
    expect(el.textContent).toContain("Kata");
  });

  it("says nothing rather than something wrong when the name is not known", async () => {
    // A linked account whose display name Spotify never resolved. A blank corner is
    // honest; the raw account id would be a base62 string on a television.
    const el = await show("");
    expect(gearOf(el), "the gear is still there").not.toBeNull();
    // The row holds the gear and, when there is one, the name. Nothing else.
    expect(topRight(el).textContent).toBe("");
  });

  it("does not take the gear off the remote, with a name or without one", async () => {
    // The label sits in the gear's own flex row, so the regression to guard is the
    // gear leaving the focus tree - a remote that cannot reach the settings screen
    // is a dead end with nothing on screen to say so.
    for (const account of ["Kata", ""]) {
      const el = await show(account);
      expect(gearOf(el), "the settings button exists for " + JSON.stringify(account)).not.toBeNull();
      await setFocus("sp-gear");
      await flushFocus();
      // Both, because neither is enough. A key norigin does not know is still
      // set by `setFocus`, so reading it back says nothing about whether the
      // gear is in the focus tree - which is the regression named at the top of
      // this file - and the existence check alone would not notice the cursor
      // being taken somewhere else.
      expect(doesFocusableExist("sp-gear"), "the gear is in the focus tree").toBe(true);
      expect(getCurrentFocusKey(), "the remote can reach it").toBe("sp-gear");
    }
  });

  it("is a label, not a stop on the way to the gear", async () => {
    // Nothing to press, so it must not be focusable: a press spent on it is a
    // press, and there is nothing it could do.
    const el = await show("Kata");
    const label = Array.from(el.querySelectorAll<HTMLElement>("div")).find((d) => d.textContent?.trim() === "Kata");
    expect(label, "the name is on screen").toBeTruthy();
    // Focusables in this app carry their key in the DOM (FocusButton's
    // `data-sfocus`), which is how the navigation tests find them too. The label has
    // none, so no arrow can land on it and no press is spent on the way to the gear.
    expect(label!.getAttribute("data-sfocus")).toBeNull();
    expect(label).not.toBe(gearOf(el));
    expect(topRight(el).querySelectorAll("[data-sfocus]").length, "one focusable in the row").toBe(1);
  });
});
