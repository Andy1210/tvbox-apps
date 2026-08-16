import { describe, it, expect, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Library } from "../Library";
import { LibraryFilters } from "../LibraryFilters";
import { useApp } from "../state";
import { setupRemote, setFocus, remote } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaBackend, MediaItem } from "../backends/types";

// What a collection list may be narrowed by, and what happens on the way back.
//
// The panel has two halves and only the first was told which list it is
// arranging. Measured against the household's server on a library with 461
// collections: a genre, a year, a decade, a content rating, HDR or "in progress"
// each answer with NOTHING, so one press turned the collections into "this
// library has no collections" - a sentence about the library, from a chip the
// panel offered.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const FILMS = 6;

function item(n: number): MediaItem {
  return { id: `i${n}`, kind: "movie", title: `Film ${n}`, thumb: `/t/${n}` };
}

const SORTS = [
  { key: "titleSort", title: "Name" },
  { key: "addedAt", title: "Date added" },
];

function stub(seen?: (of: string | undefined) => void): MediaBackend {
  return {
    kind: "plex",
    libraryPage: async (_id: string, q: { offset: number; limit: number }) => ({
      total: FILMS,
      items: Array.from({ length: Math.max(0, Math.min(q.limit, FILMS - q.offset)) }, (_, i) => item(q.offset + i)),
    }),
    collections: async () => ({ total: 1, items: [{ id: "c1", kind: "collection", title: "Bond", thumb: "/c" }] }),
    letters: async () => [],
    sortOptions: async () => SORTS,
    filterOptions: async (_id: string, of?: string) => {
      seen?.(of);
      // The real backend answers [] for a collection; this one always offers a
      // flag, so the assertions below are about what the PANEL does with the
      // argument rather than about the stub.
      return [{ key: "hdr", title: "HDR", kind: "flag" }];
    },
    filterValues: async () => [],
    posterUrl: () => undefined,
    imageHeaders: () => ({}),
  } as unknown as MediaBackend;
}

beforeEach(async () => {
  useApp.setState({ backend: stub(), screen: { name: "home" }, history: [], failure: null });
  await act(async () => setFocus(""));
});

describe("the filter half of the panel", () => {
  it("is told which list it is arranging", async () => {
    const asked: (string | undefined)[] = [];
    useApp.setState({ backend: stub((of) => asked.push(of)) });
    render(
      <LibraryFilters
        libraryId="1"
        view={{ sort: "titleSort", desc: false, filters: {}, labels: {} }}
        of="collections"
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    // The sort half already got this; the filter half is the one that emptied
    // the grid.
    expect(asked[0], "the filters a collection can take are not a film's").toBe("collections");
  });

  it("shows no heading when the list cannot be narrowed at all", async () => {
    const backend = { ...stub(), filterOptions: async () => [] } as unknown as MediaBackend;
    useApp.setState({ backend });
    const { container } = render(
      <LibraryFilters
        libraryId="1"
        view={{ sort: "titleSort", desc: false, filters: {}, labels: {} }}
        of="collections"
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(container.textContent).toContain("Name"));
    const section = container.querySelector("section:last-of-type");
    expect(section?.className ?? "", "a heading over nothing promises a control that is not there").toContain("hidden");
  });

  it("puts the filter's name on the button, not its value", async () => {
    // A flag's value is the string "1", and the button outside falls back to the
    // value when a filter has no name.
    let applied: { labels: Record<string, string> } | null = null;
    render(
      <LibraryFilters
        libraryId="1"
        view={{ sort: "titleSort", desc: false, filters: {}, labels: {} }}
        onApply={(v) => {
          applied = v as never;
        }}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(document.body.textContent).toContain("HDR"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    await setFocus("lf-filter-0");
    await act(async () => {
      await remote.ok();
    });
    expect(applied).not.toBeNull();
    expect(applied!.labels.hdr, "the button would otherwise read · 1").toBe("HDR");
  });
});

describe("coming back from the collections", () => {
  it("puts the films back in the order they were left in", async () => {
    const { container } = render(<Library libraryId="1" title="Movies" />);
    await waitFor(() => expect(container.textContent).toContain("Film 0"));

    // An order is chosen for the films, through the panel, which is the only way
    // to a non-default one.
    await setFocus("lib-arrange");
    await act(async () => {
      await remote.ok();
    });
    await waitFor(() => expect(document.body.textContent).toContain("Date added"));
    // The panel takes its own focus a macrotask after it opens.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    await setFocus("lf-sort-1");
    await act(async () => {
      await remote.ok();
    });
    await act(async () => {
      await remote.back();
    });
    await waitFor(() => expect(container.textContent).toContain("Date added"));

    // Into the collections and straight back out.
    await setFocus("lib-mode");
    await act(async () => {
      await remote.ok();
    });
    await waitFor(() => expect(container.textContent).toContain("Bond"));
    await setFocus("lib-mode");
    await act(async () => {
      await remote.ok();
    });
    await waitFor(() => expect(container.textContent).toContain("Film 0"));

    expect(container.textContent, "the order chosen for the films was not the collections' to discard").toContain(
      "Date added",
    );
  });
});
