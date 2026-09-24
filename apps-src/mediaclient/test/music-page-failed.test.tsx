import { describe, it, expect, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { MusicList } from "../music/MusicList";
import { useApp } from "../state";
import { setupRemote, setFocus, remote, clearFocus, focusBecomes, focusLands } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaBackend, MediaItem } from "../backends/types";

// A page of the music list that could not be read must not look like one that is
// still loading: the rows say that OK tries again, and OK does.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const TOTAL = 300;
const JUMP = 150; // inside the second page (PAGE is 100)

function track(n: number): MediaItem {
  return { id: `t${n}`, kind: "track", title: `Song ${n}` } as MediaItem;
}

let failSecondPage = true;
let failLetterOffset = false;

function stubBackend(): MediaBackend {
  return {
    kind: "plex",
    libraryPage: async (_id: string, q: { offset: number; limit: number }) => {
      if (q.offset === 100 && failSecondPage) throw new Error("network");
      return {
        total: TOTAL,
        items: Array.from({ length: Math.max(0, Math.min(q.limit, TOTAL - q.offset)) }, (_, i) => track(q.offset + i)),
      };
    },
    letters: async () => [
      { key: "A", title: "A", size: JUMP },
      { key: "M", title: "M", size: TOTAL - JUMP },
    ],
    letterOffset: async (_id: string, key: string) => {
      if (failLetterOffset) throw new Error("network");
      return key === "M" ? JUMP : 0;
    },
    posterUrl: () => undefined,
    imageHeaders: () => ({}),
  } as unknown as MediaBackend;
}

beforeEach(async () => {
  failSecondPage = true;
  failLetterOffset = false;
  useApp.setState({ backend: stubBackend(), screen: { name: "home" }, history: [], failure: null });
  await clearFocus();
});

describe("a music page that failed", () => {
  it("says so, and OK reads it again", async () => {
    const { container } = render(<MusicList libraryId="9" lens="artists" title="Music" />);
    await waitFor(() => expect(container.textContent).toContain("Song 0"));
    // The strip arrives separately, and the list's own first focus lands on a
    // timer: pressing before either would reach the wrong control.
    await waitFor(() => expect(container.textContent).toContain("M"));
    await focusLands();
    await setFocus("letter-M");
    await act(async () => {
      await remote.ok();
    });
    await focusBecomes(`mrow-${JUMP}`);
    await waitFor(() => expect(container.textContent).toContain(en.music.pageFailed));
    // Said once, on the row the cursor is on, not on every row of the page.
    expect(container.textContent!.split(en.music.pageFailed).length - 1).toBe(1);

    failSecondPage = false;
    await act(async () => {
      await remote.ok();
    });
    await waitFor(() => expect(container.textContent).toContain(`Song ${JUMP}`));
    expect(container.textContent).not.toContain(en.music.pageFailed);
  });

  it("a letter whose place cannot be asked says so and leaves the cursor on the letter", async () => {
    failLetterOffset = true;
    const { container } = render(<MusicList libraryId="9" lens="artists" title="Music" />);
    await waitFor(() => expect(container.textContent).toContain("Song 0"));
    await waitFor(() => expect(container.textContent).toContain("M"));
    await focusLands();
    await setFocus("letter-M");
    await act(async () => {
      await remote.ok();
    });
    await waitFor(() => expect(container.textContent).toContain(en.music.jumpFailed));
    await focusBecomes("letter-M");
  });
});
