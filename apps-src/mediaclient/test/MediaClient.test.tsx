import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { MediaClient } from "../MediaClient";
import { useApp } from "../state";
import { __resetIdentity } from "../identity";
import { setupRemote, remote } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

// No shell in a test environment, so there is no storage bridge and no system
// info: boot() finds no saved session and lands on sign-in, which is also what a
// box does the first time it is opened.
beforeEach(() => {
  __resetIdentity();
  useApp.setState({ screen: { name: "boot" }, history: [], session: null, backend: null, failure: null });
});

describe("MediaClient", () => {
  it("renders the player stage, because the shell reveals mpv through it", () => {
    render(<MediaClient onExit={vi.fn()} />);

    // The manifest names #player-stage as the node the shell makes transparent.
    // If the id drifts from the manifest, a film plays behind an opaque page and
    // nothing else fails - so it is asserted here.
    expect(document.querySelector("#player-stage")).not.toBeNull();
  });

  it("leaves the app on Back when there is nowhere to go back to", async () => {
    const onExit = vi.fn();
    render(<MediaClient onExit={onExit} />);

    await remote.back();

    expect(onExit).toHaveBeenCalledOnce();
  });

  it("walks back through screens before leaving the app", async () => {
    const onExit = vi.fn();
    render(<MediaClient onExit={onExit} />);

    act(() => {
      useApp.setState({ screen: { name: "home" }, history: [] });
      useApp.getState().go({ name: "item", itemId: "42" });
    });

    await remote.back();
    expect(onExit).not.toHaveBeenCalled();
    expect(useApp.getState().screen).toEqual({ name: "home" });

    // Only now, from the top, does Back mean "leave" - which is what the remote's
    // Back does everywhere else on this box.
    await remote.back();
    expect(onExit).toHaveBeenCalledOnce();
  });
});
