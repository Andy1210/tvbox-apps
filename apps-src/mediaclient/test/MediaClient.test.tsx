import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { MediaClient } from "../MediaClient";
import { useApp } from "../state";
import { useMusic } from "../playback/music";
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
  it("hands a spoken command to the queue even while the picker is up", async () => {
    // The Companion door refuses that screen and answers a refusal for it. This
    // one cannot: it is fire-and-forget, so the shell's publish succeeds whatever
    // happens here and the assistant says out loud that it did what it was asked.
    // Half of these are also this app's own half of something the shell has
    // ALREADY done to mpv, so dropping them leaves the room quiet with the screen
    // still saying "playing". Gating it was measured to do both.
    let deliver: ((c: unknown) => void) | undefined;
    (globalThis as unknown as { tvbox: unknown }).tvbox = {
      onCommand: (fn: (c: unknown) => void) => {
        deliver = fn;
        return () => {};
      },
    };
    useMusic.setState({
      queue: [{ id: "t1", kind: "track", title: "A Song" }] as never,
      index: 0,
      state: "playing",
      shuffle: false,
    });
    useApp.setState({ screen: { name: "profiles" }, history: [] });
    render(<MediaClient onExit={vi.fn()} />);

    await act(async () => deliver?.({ action: "shuffle", state: "on" }));
    expect(useMusic.getState().shuffle, "the command reached the queue").toBe(true);

    useMusic.setState({ queue: [], index: 0, state: "stopped", shuffle: false });
    delete (globalThis as unknown as { tvbox?: unknown }).tvbox;
  });

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
