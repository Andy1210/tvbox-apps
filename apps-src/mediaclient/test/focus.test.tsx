import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Home } from "../Home";
import { Message } from "../Message";
import { useApp } from "../state";
import { setupRemote, place, remote, setFocus, getCurrentFocusKey, flushFocus } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaBackend, MediaItem } from "../backends/types";

// Does the remote actually do anything.
//
// Spatial navigation only registers focusables; it never focuses one. With
// nothing focused its key handler has no origin to navigate from and discards
// every press, so a screen full of posters simply does not respond - while a
// mouse still works, which is why this passes at a desk and fails on a sofa.
//
// Nothing here checks layout or wording. It checks that a press moves something.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

function item(n: number): MediaItem {
  return { id: `i${n}`, kind: "movie", title: `Film ${n}`, thumb: `/t/${n}` };
}

function stubBackend(over: Partial<MediaBackend> = {}): MediaBackend {
  return {
    kind: "plex",
    libraries: async () => [{ id: "1", title: "Movies", kind: "movie" }],
    onDeck: async () => [item(1), item(2), item(3)],
    recentlyAdded: async () => [],
    posterUrl: () => undefined,
    imageHeaders: () => ({}),
    ...over,
  } as unknown as MediaBackend;
}

beforeEach(async () => {
  useApp.setState({ backend: stubBackend(), screen: { name: "home" }, history: [], failure: null });
  // Focus is library-global and survives an unmount, so a leftover from the
  // previous test would make the next one pass for the wrong reason.
  await act(async () => setFocus(""));
});

/**
 * Let the initial focus land.
 *
 * It is deferred by a macrotask on purpose: focusables register during their own
 * effect, so a setFocus in the same commit runs before the target exists.
 * Draining microtasks alone is therefore not enough here.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await flushFocus();
}

describe("the remote", () => {
  it("has something focused once the home screen has loaded", async () => {
    render(<Home />);
    await waitFor(() => expect(screen.getByText("Movies")).toBeInTheDocument());
    await settle();

    // Without this, every arrow press is discarded and the app is a picture.
    // The top rail, so the first press is already among the things that lead
    // somewhere.
    expect(getCurrentFocusKey()).toBe("lib-1");
  });

  it("moves along a row when Right is pressed", async () => {
    render(<Home />);
    await waitFor(() => expect(screen.getByText("Film 1")).toBeInTheDocument());
    await settle();

    // happy-dom has no layout engine, so the harness supplies the geometry the
    // library resolves directions against.
    ["Film 1", "Film 2", "Film 3"].forEach((label, i) => {
      const tile = screen.getByText(label).closest("div")!.parentElement!;
      place(tile, i * 120, 400, 100, 200);
    });
    await setFocus("ondeck-i1");

    await remote.right();
    expect(getCurrentFocusKey()).toBe("ondeck-i2");
  });

  it("keeps search and settings one press away from the libraries", async () => {
    // They used to sit far right in a header while the first tile sat far left,
    // and Up is resolved by geometry - so reaching them meant finding the one
    // column that happened to line up.
    render(<Home />);
    await waitFor(() => expect(screen.getByText("Movies")).toBeInTheDocument());
    await settle();

    place(screen.getByText("Movies"), 0, 0, 120, 60);
    place(screen.getByText(en.home.search), 140, 0, 120, 60);
    place(screen.getByText(en.home.settings), 280, 0, 120, 60);

    await remote.right();
    expect(getCurrentFocusKey()).toBe("nav-search");
    await remote.right();
    expect(getCurrentFocusKey()).toBe("nav-settings");
  });

  it("still focuses the top rail when there is nothing to carry on with", async () => {
    useApp.setState({ backend: stubBackend({ onDeck: async () => [] }) });
    render(<Home />);
    await waitFor(() => expect(screen.getByText("Movies")).toBeInTheDocument());
    await settle();

    expect(getCurrentFocusKey()).toBe("lib-1");
  });
});

describe("failure screens", () => {
  it("offer a way out rather than a sentence and nothing else", async () => {
    // The worst case: the server rejects the token, the screen says "sign in
    // again", and there is no control that signs in. Back returns to a screen
    // that fails the same way, so the remote has nowhere to go at all.
    render(<Message failure={{ kind: "signed-out" }} />);
    await settle();

    expect(screen.getByText(en.error.signInAgain)).toBeInTheDocument();
    expect(getCurrentFocusKey()).toBe("msg-signin");
  });

  it("retry is pressable on a reachable failure", async () => {
    const onRetry = vi.fn();
    render(<Message failure={{ kind: "unreachable" }} onRetry={onRetry} />);
    place(screen.getByText(en.error.retry), 0, 0);
    await settle();

    expect(getCurrentFocusKey()).toBe("msg-retry");
    await remote.ok();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("a plain loading screen focuses nothing, and that is fine", async () => {
    render(<Message loading />);
    await settle();
    // Nothing to press, but Back still leaves - which the app handles above this.
    expect(screen.getByText(en.common.loading)).toBeInTheDocument();
  });
});
