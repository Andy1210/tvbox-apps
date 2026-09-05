import { describe, it, expect, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Library } from "../Library";
import { useApp } from "../state";
import { clearLibraryViews } from "../libraryView";
import { setupRemote, setFocus, remote, focusEnters, focusLands } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaBackend, MediaItem } from "../backends/types";

// Naming the order on the button, and the loop that hid inside it.
//
// The button says what the library is sorted by, and the WORD comes from the
// server. The guard was "do I have a name for this sort yet", with the answers
// in the effect's own dependency list - so a sort the server does not name never
// satisfied it: the answer set a fresh object, the effect ran again, and the box
// asked the server about it for as long as the screen was open.
//
// The case that produces such a key is ordinary now that there are two backends:
// an order remembered on one server is not one the other names.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const ITEMS = 8;
let sortCalls = 0;

function item(n: number): MediaItem {
  return { id: `i${n}`, kind: "movie", title: `Film ${n}`, thumb: `/t/${n}` };
}

function stubBackend(): MediaBackend {
  return {
    kind: "plex",
    libraryPage: async (_id: string, q: { offset: number; limit: number }) => ({
      total: ITEMS,
      items: Array.from({ length: Math.max(0, Math.min(q.limit, ITEMS - q.offset)) }, (_, i) => item(q.offset + i)),
    }),
    collections: async () => ({ total: 0, items: [] }),
    letters: async () => [],
    // The panel is offered an order that the LATER answers do not name. That is
    // the shape of a sort remembered from another server: it is a real order on
    // the box, and the list this server sends back has no word for it.
    sortOptions: async () => {
      sortCalls += 1;
      return sortCalls === 1
        ? [
            { key: "titleSort", title: "Name" },
            { key: "addedAt", title: "Date added" },
          ]
        : [{ key: "titleSort", title: "Name" }];
    },
    filterOptions: async () => [],
    filterValues: async () => [],
    posterUrl: () => undefined,
    imageHeaders: () => ({}),
  } as unknown as MediaBackend;
}

beforeEach(async () => {
  // A library remembers how it was left; these mount the same one.
  clearLibraryViews();
  sortCalls = 0;
  useApp.setState({ backend: stubBackend(), screen: { name: "home" }, history: [], failure: null });
  await act(async () => setFocus(""));
});

describe("the word on the sort button", () => {
  it("is asked for once, even when the server does not have one for that order", async () => {
    const { container } = render(<Library libraryId="1" title="Movies" />);
    await waitFor(() => expect(container.textContent).toContain("Film 0"));
    // The grid's own cursor first, for the same reason the panel's is waited
    // for below: it lands on a timer, and one that arrives after the line under
    // this takes the cursor off the arrange button - so the press that opens
    // the panel goes to a tile instead and nothing opens at all.
    await focusLands();

    // Through the panel, which is the only way to a non-default order.
    await setFocus("lib-arrange");
    await act(async () => {
      await remote.ok();
    });
    await waitFor(() => expect(document.body.textContent).toContain("Date added"));

    // The panel focuses its own first row a macrotask after it opens, so a
    // setFocus issued before that is simply overwritten - and the press then
    // lands on "Name", which IS named, and the test passes against the bug.
    // Waited for rather than slept through: twenty milliseconds is a guess
    // about the machine, and this failed about one full-suite run in three.
    await focusEnters("lf-");

    // The SECOND order in the list - the one the stub names - is chosen, and
    // then the screen is left with a sort whose name is missing from the next
    // answer.
    await setFocus("lf-sort-1");
    await act(async () => {
      await remote.ok();
    });
    // The order that was actually applied, so the test cannot quietly measure
    // the default one. Waited for, since what it waits on is a screen redrawing
    // rather than a number of milliseconds.
    await waitFor(() => expect(container.textContent).toContain("Date added"));
    const afterApply = sortCalls;
    // Time passes with the screen open. A looping effect shows up here and
    // nowhere else: nothing errors, the grid looks right, and the box asks the
    // server about the same thing for ever.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    expect(sortCalls).toBe(afterApply);
    expect(sortCalls, "asked once per library and order, not once per answer").toBeLessThanOrEqual(2);
  });
});

describe("arranging a collection list", () => {
  it("asks for the orders a collection can have, not the ones a film has", async () => {
    // A collection has no resolution and no unwatched count, and the backend
    // keeps a shorter list for exactly that reason - which was never once used,
    // because both call sites left the argument out.
    const asked: (string | undefined)[] = [];
    const backend = {
      kind: "plex",
      sortOptions: async (_id: string, of?: string) => {
        asked.push(of);
        return [{ key: "titleSort", title: "Name" }];
      },
      filterOptions: async () => [],
      filterValues: async () => [],
    } as unknown as MediaBackend;
    useApp.setState({ backend });

    const { LibraryFilters } = await import("../LibraryFilters");
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
    expect(asked[0]).toBe("collections");
  });
});
