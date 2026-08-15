import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Search } from "../Search";
import { Tile } from "../Tile";
import { useApp } from "../state";
import { setupRemote, setFocus, remote, getCurrentFocusKey } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaBackend, MediaItem } from "../backends/types";

// The poster loader, answering at once with a blob named after what was asked
// for - so a stale one is recognisable on sight.
vi.mock("../posters", async () => {
  const actual = await vi.importActual<typeof import("../posters")>("../posters");
  return {
    ...actual,
    loadImage: async (url: string) => `blob:${url.includes("one") ? "one" : "two"}`,
  };
});

// Two buttons that did nothing, and a poster that belonged to something else.
//
// Both are the same shape of fault: the screen looks right, the remote responds,
// and the thing that was supposed to happen did not. Nothing errors, so only
// somebody sitting in front of it would ever know.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

function item(n: number): MediaItem {
  return { id: `i${n}`, kind: "movie", title: `Film ${n}`, thumb: `/t/${n}` };
}

beforeEach(async () => {
  useApp.setState({ screen: { name: "search" }, history: [], failure: null });
  await act(async () => setFocus(""));
});

describe("trying a failed search again", () => {
  it("runs the search a second time", async () => {
    // `setQuery(q => `${q}`)` makes an equal string, React bails out of the
    // render, and the effect never re-fires - so the button was a decoration on
    // the one screen where somebody is already annoyed.
    let calls = 0;
    const backend = {
      kind: "plex",
      search: async () => {
        calls += 1;
        if (calls === 1) {
          useApp.getState().fail({ kind: "offline" });
          throw new Error("server said no");
        }
        return [item(1)];
      },
      posterUrl: () => undefined,
      imageHeaders: () => ({}),
    } as unknown as MediaBackend;
    useApp.setState({ backend, failure: null });

    const { container } = render(<Search />);
    // Typed on the real keyboard, because that is the only way into this
    // screen: one letter is enough for a search to be started.
    await setFocus("osk-0-0");
    await act(async () => {
      await remote.ok();
    });
    await setFocus("osk-done");
    await act(async () => {
      await remote.ok();
    });
    await waitFor(() => expect(calls).toBe(1));
    await waitFor(() => expect(getCurrentFocusKey()).toBe("msg-retry"));

    await act(async () => {
      await remote.ok();
    });

    // The whole of it: the second call happened.
    await waitFor(() => expect(calls).toBe(2));
    expect(container.textContent).toContain("Film 1");
  });
});

describe("a tile that is given a different poster", () => {
  it("does not keep showing the previous one", async () => {
    // A grid recycles its tiles as it scrolls. Holding the blob without the URL
    // it belongs to left the previous film's poster under the new film's title
    // until the next one arrived - and for good on an item with no artwork.
    //
    // The loader is replaced here so a poster genuinely arrives: without that
    // nothing ever loads in this environment and the assertion would hold
    // against the bug as well as against the fix.
    const { container, rerender } = render(
      <Tile item={item(1)} posterUrl="http://s/one.jpg" focusKey="t1" onEnter={() => {}} />,
    );
    const img = (): HTMLImageElement | null => container.querySelector("img");
    await waitFor(() => expect(img()?.src ?? "").toContain("blob:one"));

    rerender(<Tile item={item(2)} posterUrl="http://s/two.jpg" focusKey="t1" onEnter={() => {}} />);
    // The moment the URL changes, before anything new has arrived.
    expect(img()?.src ?? "", "another film's poster must not sit under this title").not.toContain("blob:one");

    await waitFor(() => expect(img()?.src ?? "").toContain("blob:two"));
    rerender(<Tile item={item(3)} posterUrl={undefined} focusKey="t1" onEnter={() => {}} />);
    expect(img(), "an item with no artwork shows none").toBeNull();
  });
});
