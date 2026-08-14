import { describe, it, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { doesFocusableExist, getCurrentFocusKey } from "@noriginmedia/norigin-spatial-navigation";
import { Library } from "../Library";
import { useApp } from "../state";
import { setupRemote, setFocus, remote, place } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaBackend, MediaItem, Page, PageQuery } from "../backends/types";

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const TOTAL = 210;
const item = (n: number): MediaItem => ({ id: `i${n}`, kind: "movie", title: `Film ${n}`, thumb: `/t/${n}` });

const backend = (log: string[]): MediaBackend =>
  ({
    kind: "plex",
    async libraryPage(_id: string, q: PageQuery): Promise<Page<MediaItem>> {
      log.push(`page ${q.offset} sort=${q.sort} desc=${q.desc} filters=${JSON.stringify(q.filters)}`);
      const items: MediaItem[] = [];
      for (let i = q.offset; i < Math.min(TOTAL, q.offset + q.limit); i += 1) items.push(item(i));
      return { items, total: TOTAL };
    },
    async letters() {
      return [
        { key: "%23", title: "#", size: 24 },
        { key: "A", title: "A", size: 145 },
        { key: "S", title: "S", size: 41 },
      ];
    },
    async letterOffset() {
      return 100;
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
      return [
        { key: "221", title: "Action" },
        { key: "222", title: "Adventure" },
      ];
    },
    posterUrl: () => undefined,
    imageHeaders: () => ({}),
  }) as unknown as MediaBackend;

/** Real timers so useInitialFocus's setTimeout(0) actually runs. */
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
};

beforeEach(async () => {
  await setFocus("");
  useApp.setState({ failure: null, backend: null });
});

describe("reaching and using the arrange panel", () => {
  it("what happens when the arrange button has focus and a key arrives", async () => {
    const log: string[] = [];
    useApp.setState({ backend: backend(log) });
    const { container } = render(<Library libraryId="1" title="Movies" />);
    await settle();

    // Lay out just enough for real geometry: header button top-left, grid below.
    const arrange = [...container.querySelectorAll("div")].find((d) => d.textContent === en["library.arrange"]);
    if (arrange) place(arrange, 200, 0, 200, 60);
    console.log(`\n1) arrange button found in DOM: ${Boolean(arrange)}; focus now = ${getCurrentFocusKey()}`);

    await setFocus("lib-arrange");
    console.log(`2) after setFocus("lib-arrange"): focus = ${getCurrentFocusKey()}`);

    await remote.ok();
    console.log(`3) after OK: focus = ${getCurrentFocusKey()}  panel open = ${doesFocusableExist("lf-close")}`);

    await setFocus("lib-arrange");
    await remote.down();
    console.log(`4) focus lib-arrange then Down: focus = ${getCurrentFocusKey()}`);

    console.log(`   requests: ${JSON.stringify(log)}`);
  });

  it("with the fallback quiet (a film is playing) the button does open the panel", async () => {
    const log: string[] = [];
    useApp.setState({ backend: backend(log) });
    const { usePlayer } = await import("../playback/player");
    usePlayer.setState({
      current: {
        item: item(1),
        decision: { url: "x", session: "s", transcoded: false, version: 0 },
        markers: [],
        choice: { version: 0 },
      } as never,
    });
    render(<Library libraryId="1" title="Movies" />);
    await settle();
    await setFocus("lib-arrange");
    const before = getCurrentFocusKey();
    await remote.ok();
    console.log(
      `\n5) fallback disabled: focus before OK = ${before}, after = ${getCurrentFocusKey()}, panel open = ${doesFocusableExist("lf-close")}`,
    );

    if (doesFocusableExist("lf-sort-1")) {
      await setFocus("lf-sort-1");
      await remote.ok();
      await act(async () => {
        await Promise.resolve();
      });
      console.log(`6) mid-refetch: panel still there = ${doesFocusableExist("lf-close")}`);
      await settle();
      console.log(`7) after refetch: panel there = ${doesFocusableExist("lf-close")}  focus = ${getCurrentFocusKey()}`);
      console.log(`   requests: ${JSON.stringify(log)}`);
    }
    usePlayer.setState({ current: null });
  });
});
