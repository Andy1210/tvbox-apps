import { describe, it, expect, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { LibraryFilters, type LibraryView } from "../LibraryFilters";
import { useApp } from "../state";
import { setupRemote, place, remote, setFocus, getCurrentFocusKey, flushFocus } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaBackend } from "../backends/types";

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const SORTS = [
  { key: "titleSort", title: "Title" },
  { key: "addedAt", title: "Date Added" },
  { key: "originallyAvailableAt", title: "Release Date" },
  { key: "rating", title: "Critic Rating" },
  { key: "audienceRating", title: "Audience Rating" },
  { key: "duration", title: "Duration" },
  { key: "viewCount", title: "Plays" },
  { key: "lastViewedAt", title: "Last Played" },
  { key: "mediaHeight", title: "Resolution" },
];

const FILTERS = [
  { key: "genre", title: "Genre", kind: "list" as const },
  { key: "year", title: "Year", kind: "list" as const },
  { key: "unwatched", title: "Unplayed", kind: "flag" as const },
  { key: "hdr", title: "HDR", kind: "flag" as const },
  { key: "actor", title: "Actor", kind: "list" as const },
];

const GENRES = Array.from({ length: 31 }, (_, i) => ({ key: String(200 + i), title: `Genre ${i}` }));

function stubBackend(over: Partial<MediaBackend> = {}): MediaBackend {
  return {
    kind: "plex",
    sortOptions: async () => SORTS,
    filterOptions: async () => FILTERS,
    // A round trip to the server, not a resolved promise: the values arrive a
    // macrotask later than a microtask-resolved stub would, which is what the
    // box sees.
    filterValues: async () => {
      await new Promise((r) => setTimeout(r, 0));
      return GENRES;
    },
    posterUrl: () => undefined,
    imageHeaders: () => ({}),
    ...over,
  } as unknown as MediaBackend;
}

const VIEW: LibraryView = { sort: "titleSort", desc: false, filters: {}, labels: {} };

beforeEach(async () => {
  useApp.setState({ backend: stubBackend(), screen: { name: "home" }, history: [], failure: null });
  await act(async () => setFocus(""));
});

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    await flushFocus();
  }
}

/** Every FocusButton, in DOM order. */
function buttons(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("div.transition-transform")];
}

/**
 * Lay chips out the way `flex-wrap` would at 1080p: the panel's inner width is
 * 86vw - 2*3vh of padding, chips are roughly 10vw wide with a 0.8vw gap, so a
 * row holds about seven of them.
 */
function wrap(els: HTMLElement[], perRow: number, originY: number, w = 180, h = 44): void {
  els.forEach((el, i) => {
    const r = Math.floor(i / perRow);
    const c = i % perRow;
    place(el, 100 + c * (w + 15), originY + r * (h + 12), w, h);
  });
}

describe("the sort and filter panel", () => {
  it("focuses the first sort chip when it opens", async () => {
    render(<LibraryFilters libraryId="1" view={VIEW} onApply={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(getCurrentFocusKey()).not.toBe(""));
    await settle();
    expect(getCurrentFocusKey()).toBe("lf-sort-0");
  });

  it("walks a wrapped row and crosses into the filter section", async () => {
    const { container } = render(<LibraryFilters libraryId="1" view={VIEW} onApply={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain("Resolution"));
    await settle();

    const all = buttons(container);
    const done = all[0];
    const sortEls = all.slice(1, 1 + SORTS.length);
    const filterEls = all.slice(1 + SORTS.length, 1 + SORTS.length + FILTERS.length);
    place(done, 900, 20, 160, 44);
    wrap(sortEls, 7, 140); // rows at y=140 and y=196
    wrap(filterEls, 7, 320);

    await act(async () => setFocus("lf-sort-0"));
    await remote.right();
    expect(getCurrentFocusKey()).toBe("lf-sort-1");

    // The end of a wrapped row: seven per row, so index 6 is the last of row 1.
    await act(async () => setFocus("lf-sort-6"));
    await remote.right();
    const afterRight = getCurrentFocusKey();

    // Down from the last chip of the wrapped row.
    await act(async () => setFocus("lf-sort-6"));
    await remote.down();
    const downFromRowEnd = getCurrentFocusKey();

    // Down from the LAST sort chip (row 2, position 2) must reach the filters.
    await act(async () => setFocus(`lf-sort-${SORTS.length - 1}`));
    await remote.down();
    const intoFilters = getCurrentFocusKey();

    // eslint-disable-next-line no-console
    console.log("PROBE wrapped-row:", { afterRight, downFromRowEnd, intoFilters });
    expect(intoFilters.startsWith("lf-filter-")).toBe(true);
  });

  it("Up from the sort section reaches the Done button", async () => {
    const { container } = render(<LibraryFilters libraryId="1" view={VIEW} onApply={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain("Resolution"));
    await settle();

    const all = buttons(container);
    place(all[0], 900, 20, 160, 44);
    wrap(all.slice(1, 1 + SORTS.length), 7, 140);
    wrap(all.slice(1 + SORTS.length, 1 + SORTS.length + FILTERS.length), 7, 320);

    await act(async () => setFocus("lf-sort-0"));
    await remote.up();
    // eslint-disable-next-line no-console
    console.log("PROBE up-from-first-sort:", getCurrentFocusKey());

    await act(async () => setFocus("lf-sort-3"));
    await remote.up();
    // eslint-disable-next-line no-console
    console.log("PROBE up-from-mid-sort:", getCurrentFocusKey());
  });

  it("says where focus lands when the value list opens", async () => {
    const view: LibraryView = { ...VIEW };
    const { container } = render(<LibraryFilters libraryId="1" view={view} onApply={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(container.textContent).toContain("Genre"));
    await settle();

    const all = buttons(container);
    place(all[0], 900, 20, 160, 44);
    wrap(all.slice(1, 1 + SORTS.length), 7, 140);
    wrap(all.slice(1 + SORTS.length, 1 + SORTS.length + FILTERS.length), 7, 320);

    // Open the genre list from its chip.
    await act(async () => setFocus("lf-filter-0"));
    await remote.ok();
    await settle();
    await waitFor(() => expect(container.textContent).toContain("Genre 0"));
    await settle();

    const afterOpen = getCurrentFocusKey();
    // eslint-disable-next-line no-console
    console.log("PROBE value-list focus right after it opens:", afterOpen);

    // Now the first press a person makes.
    const vals = buttons(container);
    place(vals[0], 900, 20, 160, 44); // Back
    wrap(vals.slice(1), 6, 140);
    await remote.down();
    // eslint-disable-next-line no-console
    console.log("PROBE value-list focus after first Down:", getCurrentFocusKey());
  });

  it("says where focus lands after a value is chosen", async () => {
    let view: LibraryView = { ...VIEW };
    const { container, rerender } = render(
      <LibraryFilters
        libraryId="1"
        view={view}
        onApply={(next) => {
          view = next;
        }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(container.textContent).toContain("Genre"));
    await settle();

    const all = buttons(container);
    place(all[0], 900, 20, 160, 44);
    wrap(all.slice(1, 1 + SORTS.length), 7, 140);
    wrap(all.slice(1 + SORTS.length, 1 + SORTS.length + FILTERS.length), 7, 320);

    await act(async () => setFocus("lf-filter-0"));
    await remote.ok();
    await waitFor(() => expect(container.textContent).toContain("Genre 0"));
    await settle();

    await act(async () => setFocus("lf-val-3"));
    await remote.ok();
    await settle();
    rerender(
      <LibraryFilters
        libraryId="1"
        view={view}
        onApply={(next) => {
          view = next;
        }}
        onClose={() => {}}
      />,
    );
    await settle();

    // eslint-disable-next-line no-console
    console.log("PROBE focus right after choosing a value:", getCurrentFocusKey());

    const back = buttons(container);
    place(back[0], 900, 20, 160, 44);
    wrap(back.slice(1, 1 + SORTS.length), 7, 140);
    wrap(back.slice(1 + SORTS.length, 1 + SORTS.length + FILTERS.length), 7, 320);
    await remote.down();
    // eslint-disable-next-line no-console
    console.log("PROBE focus after the first press back in the panel:", getCurrentFocusKey());
  });

  it("says what happens to focus when the clear button disappears", async () => {
    let view: LibraryView = { ...VIEW, filters: { genre: "201" }, labels: { genre: "Genre 1" } };
    const { container, rerender } = render(
      <LibraryFilters
        libraryId="1"
        view={view}
        onApply={(next) => {
          view = next;
        }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(container.textContent).toContain("Clear filters"));
    await settle();

    await act(async () => setFocus("lf-clear"));
    await remote.ok();
    await settle();
    rerender(
      <LibraryFilters
        libraryId="1"
        view={view}
        onApply={(next) => {
          view = next;
        }}
        onClose={() => {}}
      />,
    );
    await settle();
    // eslint-disable-next-line no-console
    console.log("PROBE focus after Clear filters:", getCurrentFocusKey(), "filters:", JSON.stringify(view.filters));

    const all = buttons(container);
    place(all[0], 900, 20, 160, 44);
    wrap(all.slice(1, 1 + SORTS.length), 7, 140);
    wrap(all.slice(1 + SORTS.length, 1 + SORTS.length + FILTERS.length), 7, 320);
    await remote.down();
    // eslint-disable-next-line no-console
    console.log("PROBE focus after the next press:", getCurrentFocusKey());
  });
});
