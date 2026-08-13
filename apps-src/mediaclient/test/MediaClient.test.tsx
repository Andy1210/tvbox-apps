import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { MediaClient } from "../MediaClient";
import { setupRemote, place, remote, setFocus, getCurrentFocusKey } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

describe("MediaClient", () => {
  it("renders the player stage, because the shell reveals mpv through it", () => {
    render(<MediaClient onExit={vi.fn()} />);

    // The manifest names #player-stage as the node the shell makes transparent.
    // If the id ever drifts from the manifest the film plays behind an opaque
    // page and nothing else fails - so it is asserted here.
    expect(document.querySelector("#player-stage")).not.toBeNull();
  });

  it("leaves the app on Back", async () => {
    const onExit = vi.fn();
    render(<MediaClient onExit={onExit} />);

    await remote.back();

    expect(onExit).toHaveBeenCalledOnce();
  });

  it("leaves the app when the exit button is pressed", async () => {
    const onExit = vi.fn();
    render(<MediaClient onExit={onExit} />);

    // happy-dom has no layout engine, so the harness supplies the geometry
    // norigin resolves focus against.
    place(screen.getByText(en.app.back), 0, 0);
    await setFocus("exit");
    expect(getCurrentFocusKey()).toBe("exit");

    await remote.ok();

    expect(onExit).toHaveBeenCalledOnce();
  });
});
