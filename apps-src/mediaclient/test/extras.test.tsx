import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

/**
 * The trailers and featurettes under a film or a series.
 *
 * They are ordinary items to the server and go through the same player, so a
 * tile that highlights and accepts OK has to start something. Two ways it did
 * not: the part an online extra resolves to is proxied rather than held in the
 * library, and a play that cannot be resolved wrote to a field no screen draws.
 */

import type { Extra, ItemDetail, MediaItem, StreamDecision } from "../backends/types";

const { setupRemote, flushFocus } = await import("./remote");
setupRemote();

let n = 0;
let played: string[] = [];

const trailer: Extra = {
  id: "9001",
  title: "Official Trailer",
  subtype: "trailer",
  durationMs: 103_000,
};

interface Harness {
  film: MediaItem;
}

async function open(opts?: { resolve?: () => Promise<StreamDecision> }): Promise<Harness> {
  const { render } = await import("@testing-library/react");
  const { configureI18n } = await import("@sdk");
  const { Detail } = await import("../Detail");
  const { useApp } = await import("../state");
  const en = (await import("../locales/en.json")).default;
  const hu = (await import("../locales/hu.json")).default;
  configureI18n({ hu, en }, { fallback: "en" });

  n += 1;
  const film: MediaItem = { id: `film${n}`, kind: "movie", title: "A film", durationMs: 1_800_000 };
  const detail = (item: MediaItem, extras: Extra[]): ItemDetail =>
    ({
      ...item,
      roles: [],
      extras,
      reviews: [],
      scores: [],
      chapters: [],
      versions: [],
    }) as ItemDetail;

  useApp.setState({
    backend: {
      kind: "plex",
      item: async (id: string) => detail(id === film.id ? film : { id, kind: "movie", title: trailer.title }, id === film.id ? [trailer] : []),
      children: async () => [],
      setWatched: async () => {},
      posterUrl: () => undefined,
      artUrl: () => undefined,
      backdropUrl: () => undefined,
      themeUrl: () => undefined,
      imageHeaders: () => ({}),
      markers: async () => [],
      reportProgress: async () => {},
      keepAlive: async () => {},
      endSession: async () => {},
      resolveStream:
        opts?.resolve ??
        (async () =>
          ({
            url: "http://server:32400/services/iva/assets/573437/video.mp4?fmt=4",
            audio: "auto",
            sub: "no",
            session: "s",
            transcoded: false,
            version: 0,
          }) as StreamDecision),
    } as never,
    screen: { name: "item", itemId: film.id },
    history: [],
    failure: null,
  });

  render(<Detail itemId={film.id} />);
  await settle();
  return { film };
}

const el = (key: string): HTMLElement | null => document.querySelector(`[data-sfocus="${key}"]`);

/**
 * One turn of the event loop, under whichever clock the test is running.
 *
 * The screen places its cursor from a timer, so a test that fakes the clock has
 * to advance it rather than wait on it, or the page never finishes arriving.
 */
async function tick(): Promise<void> {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
  else await new Promise((r) => setTimeout(r, 0));
}

async function settle(): Promise<void> {
  const { act } = await import("@testing-library/react");
  for (let i = 0; i < 5; i++) {
    await act(tick);
    await flushFocus();
  }
}

async function press(key: string): Promise<void> {
  const { act } = await import("@testing-library/react");
  const btn = el(key);
  expect(btn, `the ${key} tile`).toBeTruthy();
  await act(async () => {
    btn!.click();
    await tick();
  });
  await settle();
}

beforeEach(() => {
  played = [];
  (globalThis as { window?: unknown }).window = globalThis;
  (globalThis as unknown as { tvbox: unknown }).tvbox = {
    play: (url: string) => played.push(url),
    stop: () => {},
    pause: () => {},
    resume: () => {},
    onPlayer: () => () => {},
    panel: { width: 1920, height: 1080 },
  };
});

afterEach(async () => {
  const { resetPlayer } = await import("../playback/player");
  resetPlayer();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("an extra on a detail screen", () => {
  it("is a tile that starts it", async () => {
    const h = await open();
    expect(el(`extras-${h.film.id}-${trailer.id}`)).toBeTruthy();
    await press(`extras-${h.film.id}-${trailer.id}`);

    const { usePlayer } = await import("../playback/player");
    expect(usePlayer.getState().current?.item.id).toBe(trailer.id);
    // The file the server proxies, handed to the box as it came back.
    expect(played).toEqual(["http://server:32400/services/iva/assets/573437/video.mp4?fmt=4"]);
  });

  it("says so when it cannot be started, instead of doing nothing", async () => {
    // A press that is taken and answered with an unchanged screen cannot be
    // told apart from a remote that has stopped working.
    const h = await open({
      resolve: async () => {
        throw new Error("no");
      },
    });
    await press(`extras-${h.film.id}-${trailer.id}`);

    expect(played).toEqual([]);
    expect(document.body.textContent).toContain("Official Trailer could not be started");
  });

  it("says nothing about a press made on another screen", async () => {
    // The field is one global with an eight second life, so somebody who
    // presses an extra and then opens something else used to take the line with
    // them and read it beside a title it said nothing about.
    const h = await open();
    const { usePlayer } = await import("../playback/player");
    const { act } = await import("@testing-library/react");
    await act(async () => {
      usePlayer.setState({ stepFailed: "Egy másik film", stepFailedId: "some-other-item" });
      await tick();
    });
    expect(document.body.textContent).not.toContain("Egy másik film");

    // The same field, about something this screen really can start.
    await act(async () => {
      usePlayer.setState({ stepFailed: trailer.title, stepFailedId: trailer.id });
      await tick();
    });
    expect(document.body.textContent).toContain("Official Trailer could not be started");
    expect(h.film.id).toBeTruthy();
  });

  it("puts the cursor back on the extra that was pressed, not on the film", async () => {
    // An extra is not a child of the screen, so the cursor came back to the top
    // of the page - on the button that starts the FILM. The next press would
    // have started a feature film part way through.
    const { getCurrentFocusKey, setFocus } = await import("./remote");
    const h = await open();
    await press(`extras-${h.film.id}-${trailer.id}`);

    const { usePlayer, resetPlayer } = await import("../playback/player");
    expect(usePlayer.getState().current?.item.id).toBe(trailer.id);

    // The player's overlay takes the cursor while it is up, and this page sits
    // hidden behind it - so what comes back is decided by the screen's own
    // first key, not by where the press was made. Named rather than rendered:
    // any key this screen does not own puts `useFocusOnReveal` in exactly the
    // state leaving a film does.
    const { act } = await import("@testing-library/react");
    await setFocus("player");
    await act(async () => {
      resetPlayer();
      await tick();
    });
    await settle();
    expect(getCurrentFocusKey()).toBe(`extras-${h.film.id}-${trailer.id}`);
  });

  it("stops saying it once the line has had its say", async () => {
    // The line belongs to the press, so it goes by itself: one left up would be
    // read as being about whatever is on screen minutes later.
    vi.useFakeTimers();
    const h = await open({
      resolve: async () => {
        throw new Error("no");
      },
    });
    await press(`extras-${h.film.id}-${trailer.id}`);
    expect(document.body.textContent).toContain("could not be started");

    const { act } = await import("@testing-library/react");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(document.body.textContent).not.toContain("could not be started");
    vi.useRealTimers();
  });
});
