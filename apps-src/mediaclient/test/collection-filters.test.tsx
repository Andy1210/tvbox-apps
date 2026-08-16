import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Library } from "../Library";
import { LibraryFilters } from "../LibraryFilters";
import { useApp } from "../state";
import { setupRemote, setFocus, remote, getCurrentFocusKey } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import { PlexBackend } from "../backends/plex/backend";
import { clearLibraryViews } from "../libraryView";
import { useFocusFallback } from "../focus";
import { FocusButton } from "@sdk";
import type { MediaBackend, MediaItem, Session, SortOption } from "../backends/types";

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
  clearLibraryViews();
  useApp.setState({ backend: stub(), screen: { name: "home" }, history: [], failure: null });
  await act(async () => setFocus(""));
});

const SESSION: Session = {
  profileId: "p",
  profileName: "p",
  token: "t",
  accountToken: "t",
  serverId: "s",
  serverName: "s",
  baseUrl: "http://192.168.1.10:32400",
  location: "lan",
};

// What the server offers a film library, in the shape it offers it.
const SERVER_FILTERS = [
  { filter: "genre", title: "Genre", filterType: "string" },
  { filter: "contentRating", title: "Content Rating", filterType: "string" },
  { filter: "year", title: "Year", filterType: "string" },
  { filter: "hdr", title: "HDR", filterType: "boolean" },
  { filter: "unwatched", title: "Unplayed", filterType: "boolean" },
];

describe("which filters a collection list is offered", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is the one that works, not all of them and not none", async () => {
    // The real backend, because this is the only line in the change that a
    // server can tell the difference about - and both the stub tests below pass
    // whether it is there or not.
    //
    // Swept against the household's server on 461 collections: 25 of the 27
    // filters return nothing, "unwatched" returns all 461 (ignored, so the chip
    // would claim a filter that is not in effect), and contentRating partitions
    // the list exactly - its values sum to 461.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ MediaContainer: { Directory: SERVER_FILTERS } })));
    const backend = new PlexBackend(SESSION, { clientId: "c", deviceName: "d" });

    const films = await backend.filterOptions("1");
    expect(films.map((f) => f.key)).toEqual(["genre", "contentRating", "year", "hdr", "unwatched"]);

    const collections = await backend.filterOptions("1", "collections");
    expect(collections.map((f) => f.key), "genre and the rest empty the grid; unwatched is ignored").toEqual([
      "contentRating",
    ]);
    // The kind travels with it, or the chip opens no value list.
    expect(collections[0].kind).toBe("list");
  });
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

    const heading = (text: string): HTMLElement | undefined =>
      Array.from(container.querySelectorAll("h3")).find((h) => h.textContent === text) as HTMLElement | undefined;
    const shown = (h: HTMLElement | undefined): boolean =>
      h !== undefined && !(h.closest("section")?.className ?? "").split(/\s+/).includes("hidden");

    // Not rendered at all is just as good as hidden; what must not happen is a
    // heading with nothing under it.
    expect(shown(heading("Filter")), "a heading over nothing promises a control that is not there").toBe(false);
    // And the half that DOES have chips has to survive, or the panel is a Done
    // button - which an assertion on the container's text cannot see, because
    // happy-dom loads no CSS and hidden text is still text.
    expect(shown(heading("Sort")), "the orders are still there to choose from").toBe(true);
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

    // Into the collections. Nothing may follow the films in: an order a
    // collection cannot take is answered with an empty list, which this screen
    // reports as "this library has no collections".
    await setFocus("lib-mode");
    await act(async () => {
      await remote.ok();
    });
    await waitFor(() => expect(container.textContent).toContain("Bond"));
    expect(container.textContent, "the film order must not be carried into the collections").not.toContain(
      "Date added",
    );
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

describe("opening something from the library", () => {
  it("leaves it arranged the way it was when you come back", async () => {
    // This screen is unmounted whenever anything is opened from it - a film, an
    // episode, a collection - because one screen is rendered at a time. So the
    // order somebody chose used to live until the first thing they opened, and
    // Back put them at the top of an alphabetical list. The mode button was the
    // only exit that kept it, which is not the exit people use.
    const first = render(<Library libraryId="1" title="Movies" />);
    await waitFor(() => expect(first.container.textContent).toContain("Film 0"));
    await setFocus("lib-arrange");
    await act(async () => {
      await remote.ok();
    });
    await waitFor(() => expect(document.body.textContent).toContain("Date added"));
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
    await waitFor(() => expect(first.container.textContent).toContain("Date added"));

    // Something is opened, and the screen goes.
    first.unmount();
    const again = render(<Library libraryId="1" title="Movies" />);
    await waitFor(() => expect(again.container.textContent).toContain("Film 0"));
    expect(again.container.textContent, "back from a film, into the list as it was left").toContain("Date added");
    again.unmount();

    // And it belongs to the person who chose it.
    clearLibraryViews();
    const third = render(<Library libraryId="1" title="Movies" />);
    await waitFor(() => expect(third.container.textContent).toContain("Film 0"));
    expect(third.container.textContent, "the next person to sign in starts clean").not.toContain("Date added");
  });
});

describe("a panel whose options never arrived", () => {
  it("does not park the cursor on a chip that is not there", async () => {
    // The worst failure this app can have: setFocus to an unmounted key leaves
    // the cursor there and every later press aborts inside smartNavigate, so
    // the remote does nothing at all and only Back escapes.
    const backend = {
      kind: "plex",
      sortOptions: async () => [],
      filterOptions: async () => [],
      filterValues: async () => [],
    } as unknown as MediaBackend;
    useApp.setState({ backend });
    render(
      <LibraryFilters
        libraryId="1"
        view={{ sort: "titleSort", desc: false, filters: {}, labels: {} }}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      await remote.down();
    });
    // The close button is the only thing mounted, and it is where the cursor
    // has to be - "leave" beats nothing at all when there is nothing to choose.
    expect(getCurrentFocusKey()).toBe("lf-close");
  });
});

describe("the fallback that catches a lost cursor", () => {
  it("may name something that has not mounted yet, and it lands there when it does", async () => {
    // This is what lets the panel name its first chip while the server is still
    // answering: the library re-focuses a preset key as soon as that component
    // registers. Pinned because the whole design of the panel's fallback rests
    // on it - refusing to name an unmounted key would cost a press and gain
    // nothing.
    function Screen({ ready }: { ready: boolean }): React.ReactElement {
      useFocusFallback("fb-late", (k) => k.startsWith("fb-"), true);
      return (
        <>
          <FocusButton focusKey="fb-other" onEnter={() => {}}>
            {"Other"}
          </FocusButton>
          {ready && (
            <FocusButton focusKey="fb-late" onEnter={() => {}}>
              {"Late"}
            </FocusButton>
          )}
        </>
      );
    }
    await act(async () => setFocus(""));
    const { rerender } = render(<Screen ready={false} />);
    await act(async () => {
      await remote.down();
    });
    // It arrives.
    await act(async () => rerender(<Screen ready={true} />));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(getCurrentFocusKey()).toBe("fb-late");
  });
});

describe("a panel whose options have not arrived yet", () => {
  it("does not put the cursor on the way out", async () => {
    // "No orders yet" and "no orders at all" are the same length of list and a
    // different situation. Naming the close button for the first means an arrow
    // then an OK closes the panel on a slow server - the accidental exit the
    // code two lines above says it avoids.
    let answer: (v: SortOption[]) => void = () => {};
    const backend = {
      kind: "plex",
      sortOptions: () => new Promise<SortOption[]>((r) => (answer = r)),
      filterOptions: async () => [],
      filterValues: async () => [],
    } as unknown as MediaBackend;
    useApp.setState({ backend });
    let closed = 0;
    render(
      <LibraryFilters
        libraryId="1"
        view={{ sort: "titleSort", desc: false, filters: {}, labels: {} }}
        onApply={() => {}}
        onClose={() => {
          closed += 1;
        }}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      await remote.down();
    });
    expect(getCurrentFocusKey(), "the way out is not where a lost cursor belongs").not.toBe("lf-close");
    await act(async () => {
      await remote.ok();
    });
    expect(closed, "and an OK in that window must not close the panel").toBe(0);

    // Once the orders arrive the cursor is on the first of them, by itself.
    await act(async () => {
      answer([{ key: "titleSort", title: "Name" }]);
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(getCurrentFocusKey()).toBe("lf-sort-0");
  });

  it("reaches the filters when the orders came back empty", async () => {
    // A server that names no order still has filters worth reaching, and a panel
    // that opens with nothing focused leaves the only highlight on screen behind
    // its own dimmed overlay.
    const backend = {
      kind: "plex",
      sortOptions: async () => [],
      filterOptions: async () => [{ key: "hdr", title: "HDR", kind: "flag" }],
      filterValues: async () => [],
    } as unknown as MediaBackend;
    useApp.setState({ backend });
    render(
      <LibraryFilters
        libraryId="1"
        view={{ sort: "titleSort", desc: false, filters: {}, labels: {} }}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(document.body.textContent).toContain("HDR"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(getCurrentFocusKey()).toBe("lf-filter-0");
  });
});
