import { describe, it, expect } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { doesFocusableExist } from "@noriginmedia/norigin-spatial-navigation";
import { Home } from "../Home";
import { useApp } from "../state";
import { setupRemote, setFocus, getCurrentFocusKey, flushFocus, remote, focusLands, focusEnters } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaBackend } from "../backends/types";

// The screen a household lands on when the server is down.
//
// The error draws correctly and its button is highlighted, so this looks right
// in a screenshot. What was wrong is what happens on the NEXT press: the
// fallback aimed at the rail, which the failure screen does not render, so the
// cursor left for a key that does not exist and OK stopped working. Nothing
// errors, and Back still works, which is how it survived being looked at.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

describe("the home screen when the server cannot be reached", () => {
  it("answers the remote after the first press, not only before it", async () => {
    useApp.setState({
      backend: {
        kind: "plex",
        libraries: async () => {
          throw new Error("connection refused");
        },
        posterUrl: () => undefined,
        artUrl: () => undefined,
        backdropUrl: () => undefined,
        themeUrl: () => undefined,
        imageHeaders: () => ({}),
      } as unknown as MediaBackend,
      screen: { name: "home" },
      history: [],
      failure: null,
    });
    await act(async () => setFocus(""));
    render(<Home />);
    await focusLands();

    const arrived = String(getCurrentFocusKey());
    expect(arrived.startsWith("msg-"), `arrived on ${arrived}`).toBe(true);

    for (const press of [remote.down, remote.right, remote.up, remote.left]) {
      await press();
      await flushFocus();
      const at = String(getCurrentFocusKey());
      expect(doesFocusableExist(at), `focus went to ${at}, which is not on screen`).toBe(true);
      expect(at.startsWith("msg-"), `focus went to ${at}`).toBe(true);
    }
  });
});

describe("the search screen when the server cannot be reached", () => {
  it("answers the remote after the first press, not only before it", async () => {
    // Detail, Library and Person were each given `focusable: !failure` on the
    // container that stays registered above their `if (failure) return` - and
    // Search has the identical shape and was missed. It is the screen a
    // household reaches by typing while the server is down.
    const { Search } = await import("../Search");
    useApp.setState({
      backend: {
        kind: "plex",
        search: async () => {
          throw new Error("connection refused");
        },
        posterUrl: () => undefined,
        artUrl: () => undefined,
        backdropUrl: () => undefined,
        themeUrl: () => undefined,
        imageHeaders: () => ({}),
      } as unknown as MediaBackend,
      screen: { name: "search" },
      history: [],
      failure: { kind: "unreachable" },
    });
    await act(async () => setFocus(""));
    render(<Search />);
    await focusLands();

    // The keyboard opens first and owns the screen, so Back closes it - and what
    // is behind it, with the server down, is the error.
    await remote.back();
    // The error taking the cursor, not merely something holding it: the
    // keyboard is still focused when Back arrives, so "anything is lit" is
    // already true and would wait for nothing.
    await focusEnters("msg-");
    await act(async () => setFocus("msg-retry"));
    await flushFocus();
    expect(String(getCurrentFocusKey()), "the error's own button is what is on screen").toBe("msg-retry");

    for (const press of [remote.down, remote.right, remote.up, remote.left]) {
      await press();
      await flushFocus();
      const at = String(getCurrentFocusKey());
      expect(doesFocusableExist(at), `focus went to ${at}, which is not on screen`).toBe(true);
      expect(at.startsWith("msg-"), `focus went to ${at}`).toBe(true);
    }
  });
});
