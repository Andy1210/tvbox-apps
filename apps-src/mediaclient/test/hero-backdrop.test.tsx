import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Hero } from "../Hero";
import { useApp } from "../state";
import { usePlayer, type PlayingItem } from "../playback/player";
import type { MediaItem } from "../backends/types";
import en from "../locales/en.json";
import hu from "../locales/hu.json";

configureI18n({ hu, en }, { fallback: "en" });

/**
 * The home screen's backdrop must not survive into a film.
 *
 * The shell reveals mpv by making the page transparent down to `#player-stage`,
 * and the browsing screens get out of the way with `hidden`. The hero's backdrop
 * is portalled into the BODY, though - deliberately, so it paints behind the
 * page's own stacking context - which puts it outside everything `hidden`
 * reaches. Four fixed full-screen layers then sit over the picture, and the only
 * sign of the film is its sound.
 *
 * Asserted on the body rather than on the render container, because the render
 * container is exactly what the portal escapes.
 */
const ITEM = {
  id: "1",
  kind: "movie",
  title: "Dűne",
  // Four corners means the tint layer AND its scrim, so this covers more than
  // one of the portalled layers without loading any artwork.
  colors: { topLeft: "#101010", topRight: "#202020", bottomRight: "#303030", bottomLeft: "#404040" },
} as unknown as MediaItem;

const layers = (): number => document.body.querySelectorAll('[aria-hidden="true"].fixed').length;

beforeEach(() => {
  // No backend, so neither the artwork nor the detail effect asks anything of a
  // server: this test is about what is on the page, not about what fills it.
  useApp.setState({ backend: null });
  usePlayer.setState({ current: null });
});

describe("the home backdrop", () => {
  it("is drawn while browsing", () => {
    render(<Hero item={ITEM} />);

    expect(layers()).toBeGreaterThan(0);
  });

  it("is gone while a film plays, because `hidden` cannot reach a portal", () => {
    render(<Hero item={ITEM} />);

    act(() => {
      usePlayer.setState({ current: { item: ITEM } as unknown as PlayingItem });
    });

    expect(layers()).toBe(0);
  });

  it("comes back when the film stops", () => {
    render(<Hero item={ITEM} />);

    act(() => {
      usePlayer.setState({ current: { item: ITEM } as unknown as PlayingItem });
    });
    act(() => {
      usePlayer.setState({ current: null });
    });

    expect(layers()).toBeGreaterThan(0);
  });
});
