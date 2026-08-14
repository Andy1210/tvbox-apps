import { describe, it, expect, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Library } from "../Library";
import { useApp } from "../state";
import { setupRemote, setFocus, remote, flushFocus } from "./remote";
import { doesFocusableExist, getCurrentFocusKey } from "@noriginmedia/norigin-spatial-navigation";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaBackend, MediaItem, Page, PageQuery } from "../backends/types";

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const TOTAL = 1693;
const item = (n: number): MediaItem => ({ id: `i${n}`, kind: "movie", title: `Film ${n}`, thumb: `/t/${n}` });

interface Calls {
  pages: PageQuery[];
  letters: (Record<string, string> | undefined)[];
  offsets: string[];
}

function makeBackend(calls: Calls, opts?: { total?: number }): MediaBackend {
  const total = opts?.total ?? TOTAL;
  return {
    kind: "plex",
    async libraryPage(_id: string, q: PageQuery): Promise<Page<MediaItem>> {
      calls.pages.push({ ...q });
      const items: MediaItem[] = [];
      for (let i = q.offset; i < Math.min(total, q.offset + q.limit); i += 1) items.push(item(i));
      return { items, total };
    },
    async letters(_id: string, filters?: Record<string, string>) {
      calls.letters.push(filters);
      return [
        { key: "%23", title: "#", size: 24 },
        { key: "A", title: "A", size: 145 },
        { key: "S", title: "S", size: 169 },
      ];
    },
    async letterOffset(_id: string, key: string): Promise<number> {
      calls.offsets.push(key);
      return 1301;
    },
    async sortOptions() {
      return [
        { key: "titleSort", title: "Title" },
        { key: "addedAt", title: "Added" },
      ];
    },
    async filterOptions() {
      return [
        { key: "unwatched", title: "Unwatched", kind: "flag" as const },
        { key: "genre", title: "Genre", kind: "list" as const },
      ];
    },
    async filterValues() {
      return [{ key: "221", title: "Action" }];
    },
    posterUrl: () => undefined,
    imageHeaders: () => ({}),
  } as unknown as MediaBackend;
}

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
  });
  await flushFocus();
};

beforeEach(async () => {
  await setFocus("");
  useApp.setState({ failure: null });
});

describe("library screen", () => {
  it("A: pressing a sort chip - does the arrange panel survive?", async () => {
    const calls: Calls = { pages: [], letters: [], offsets: [] };
    useApp.setState({ backend: makeBackend(calls) });
    render(<Library libraryId="1" title="Movies" />);
    await settle();

    await setFocus("lib-arrange");
    const afterSet = getCurrentFocusKey();
    await remote.ok();
    const afterOk = getCurrentFocusKey();
    await settle();
    const afterSettle = getCurrentFocusKey();
    console.log(`\nA0) focus after setFocus=${afterSet}  after Enter=${afterOk}  after settle=${afterSettle}`);
    const panelBefore = doesFocusableExist("lf-close");

    // Choose the second sort ("Added"), i.e. change the view.
    await setFocus("lf-sort-1");
    await remote.ok();
    // ONE microtask: the state has changed but the refetch has not resolved.
    await act(async () => {
      await Promise.resolve();
    });
    const panelMidFetch = doesFocusableExist("lf-close");
    const loadingMidFetch = document.body.textContent?.includes(en["common.loading"] ?? "Loading");

    await settle();
    const panelAfter = doesFocusableExist("lf-close");

    console.log(
      `\nA) panel before=${panelBefore}  during refetch=${panelMidFetch} (loading msg shown=${loadingMidFetch})  after=${panelAfter}`,
    );
    console.log(`   pages requested: ${JSON.stringify(calls.pages)}`);
    expect(panelBefore).toBe(true);
  });

  it("B: jump arithmetic - is the row the jump scrolls to inside the page it fetched?", () => {
    const PAGE = 100;
    const COLUMNS = 7;
    const rows: string[] = [];
    for (let offset = 0; offset < TOTAL; offset += 1) {
      const row = Math.floor(offset / COLUMNS);
      const asked = Math.floor(offset / PAGE);
      const firstOfRow = row * COLUMNS;
      const lastOfRow = firstOfRow + COLUMNS - 1;
      const need = new Set([Math.floor(firstOfRow / PAGE), Math.floor(lastOfRow / PAGE)]);
      if (![...need].every((p) => p === asked))
        rows.push(`offset=${offset} row=${row} items ${firstOfRow}-${lastOfRow} need pages ${[...need]} got ${asked}`);
    }
    console.log(`\nB) offsets whose landing row straddles the fetched page: ${rows.length} of ${TOTAL}`);
    console.log("   " + rows.slice(0, 6).join("\n   "));
  });

  it("C: how much of the screen a single fetched page covers", () => {
    const VIEWPORT = 1080;
    const rowHeight = Math.round(VIEWPORT * (34 / 100));
    const visibleRows = Math.ceil(VIEWPORT / rowHeight) + 2 * 2;
    console.log(
      `\nC) rowHeight=${rowHeight}px  rows in view+overscan=${visibleRows}  items=${visibleRows * 7}  page=100`,
    );
  });

  it("D: strip is rendered regardless of the sort", async () => {
    const calls: Calls = { pages: [], letters: [], offsets: [] };
    useApp.setState({ backend: makeBackend(calls) });
    render(<Library libraryId="1" title="Movies" />);
    await settle();
    await setFocus("lib-arrange");
    await remote.ok();
    await settle();
    await setFocus("lf-sort-1"); // addedAt
    await remote.ok();
    await settle();
    // close the panel
    await setFocus("lf-close");
    await remote.ok();
    await settle();
    const stripUp = doesFocusableExist("letter-A");
    const sortUsed = calls.pages[calls.pages.length - 1]?.sort;
    console.log(`\nD) after choosing sort=${sortUsed}: A-Z strip still on screen = ${stripUp}`);
    expect(stripUp).toBe(true);
  });

  it("E: empty library - is the strip hidden and does it say so?", async () => {
    const calls: Calls = { pages: [], letters: [], offsets: [] };
    useApp.setState({ backend: makeBackend(calls, { total: 0 }) });
    render(<Library libraryId="1" title="Movies" />);
    await settle();
    const stripUp = doesFocusableExist("letter-A");
    console.log(
      `\nE) empty library: strip rendered=${stripUp}; body says: ${JSON.stringify(document.body.textContent?.slice(0, 120))}`,
    );
  });

  it("F: does the count in the header follow the filter?", async () => {
    const calls: Calls = { pages: [], letters: [], offsets: [] };
    useApp.setState({ backend: makeBackend(calls) });
    const { container } = render(<Library libraryId="1" title="Movies" />);
    await settle();
    console.log(`\nF) header text: ${JSON.stringify(container.querySelector("h1")?.textContent)}`);
  });
});
