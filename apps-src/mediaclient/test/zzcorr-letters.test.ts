import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const say = (s: string): void => require("node:fs").appendFileSync("/tmp/zzcorr.log", s + "\n");

import { describe, it, beforeEach, vi } from "vitest";
import { PlexBackend } from "../backends/plex/backend";
import type { Session } from "../backends/types";

const BASE = process.env.PLEX_URL;
const TOKEN = process.env.PLEX_TOKEN;

const session: Session = {
  profileId: "t",
  profileName: "t",
  token: TOKEN ?? "",
  accountToken: TOKEN ?? "",
  serverId: "t",
  serverName: "t",
  baseUrl: BASE ?? "",
  location: "lan",
};
const id = { clientId: "zzcorr", deviceName: "zzcorr" };

describe.skipIf(!BASE || !TOKEN)("letterOffset sweep", () => {
  beforeEach(() => vi.unstubAllGlobals());
  const backend = (): PlexBackend => new PlexBackend(session, id);

  it("non-title sort (addedAt)", async () => {
    const b = backend();
    const strip = await b.letters("1");
    say("\nSORT=addedAt (strip is still shown; nothing hides it)");
    for (const l of strip.slice(0, 10)) {
      const offset = await b.letterOffset("1", l.key, { sort: "addedAt" });
      const at = await b.libraryPage("1", { offset, limit: 1, sort: "addedAt" });
      const title = at.items[0]?.sortTitle ?? at.items[0]?.title ?? "";
      say(`${l.title.padEnd(3)} got=${String(offset).padStart(4)} landedOn=${JSON.stringify(title)}`);
    }
  }, 300_000);

  it("with a filter applied", async () => {
    const b = backend();
    const filters = { unwatched: "1" };
    const strip = await b.letters("1", filters);
    const all = await b.libraryPage("1", { offset: 0, limit: 1, filters });
    say(`\nFILTERED (unwatched=1) strip buckets: ${strip.length}  grid total: ${all.total}`);
    let wrong = 0;
    for (const l of strip) {
      const offset = await b.letterOffset("1", l.key, { sort: "titleSort", filters });
      const at = await b.libraryPage("1", { offset, limit: 1, sort: "titleSort", filters });
      const title = at.items[0]?.sortTitle ?? at.items[0]?.title ?? "";
      const initial = title.trim()[0]?.normalize("NFD")[0]?.toUpperCase();
      const want = l.title.normalize("NFD")[0].toUpperCase();
      const ok = !/^[A-Z]$/.test(want) || initial === want;
      if (!ok) wrong += 1;
      say(
        `${ok ? "ok  " : "WRONG"} ${l.title.padEnd(3)} size=${String(l.size).padStart(3)} got=${String(offset).padStart(4)} landedOn=${JSON.stringify(title)}`,
      );
    }
    say(`${wrong} wrong under a filter`);
  }, 300_000);

  it("a filter that empties the library", async () => {
    const b = backend();
    const filters = { year: "1801" };
    const all = await b.libraryPage("1", { offset: 0, limit: 1, filters });
    const strip = await b.letters("1", filters).catch((e) => [{ key: `ERR ${String(e)}`, title: "", size: 0 }]);
    say(`\nEMPTY filter (year=1801): grid total=${all.total} items=${all.items.length} stripBuckets=${strip.length}`);
    const offset = await b.letterOffset("1", "S", { sort: "titleSort", filters }).catch((e) => `ERR ${String(e)}`);
    say(`letterOffset("S") on an empty library: ${offset}`);
  }, 120_000);

  it("filter shapes, encoding, two at once", async () => {
    const b = backend();
    const sorts = await b.sortOptions("1");
    say(`\nsorts (${sorts.length}): ${sorts.map((s) => s.key).join(", ")}`);
    const fo = await b.filterOptions("1");
    say(`filters (${fo.length}): ${fo.map((f) => `${f.key}:${f.kind}`).join(", ")}`);

    const genres = await b.filterValues("1", "genre");
    say(`genre values: ${genres.length}; first 4: ${JSON.stringify(genres.slice(0, 4))}`);
    const g = genres[0];
    const all = await b.libraryPage("1", { offset: 0, limit: 1 });
    const one = await b.libraryPage("1", { offset: 0, limit: 1, filters: { genre: g.key } });
    const two = await b.libraryPage("1", { offset: 0, limit: 1, filters: { genre: g.key, unwatched: "1" } });
    say(`all=${all.total}  genre(${g.title}=${g.key})=${one.total}  genre+unwatched=${two.total}`);

    // A list filter whose VALUE is text rather than an id.
    for (const f of fo.filter((x) => x.kind === "list").slice(0, 30)) {
      const vals = await b.filterValues("1", f.key).catch(() => []);
      const v = vals[0];
      if (!v) {
        say(`  ${f.key}: no values`);
        continue;
      }
      const res = await b.libraryPage("1", { offset: 0, limit: 1, filters: { [f.key]: v.key } }).catch((e) => ({
        total: `ERR ${String(e)}`,
        items: [],
      }));
      const encoded = /[^A-Za-z0-9._~-]/.test(v.key);
      say(
        `  ${f.key.padEnd(16)} value=${JSON.stringify(v.key).padEnd(28)} needsEncoding=${encoded ? "YES" : "no "} total=${res.total} (all=${all.total})`,
      );
    }
  }, 300_000);

  it("a flag filter sent as the string 1, and what a list filter does to letters()", async () => {
    const b = backend();
    const all = await b.libraryPage("1", { offset: 0, limit: 1 });
    for (const f of ["unwatched", "inProgress", "hdr", "duplicate", "unmatched"]) {
      const r = await b.libraryPage("1", { offset: 0, limit: 1, filters: { [f]: "1" } }).catch((e) => ({
        total: `ERR ${String(e)}`,
      }));
      const s = await b.letters("1", { [f]: "1" }).catch(() => []);
      const stripTotal = s.reduce((n, l) => n + l.size, 0);
      say(`flag ${f.padEnd(12)} gridTotal=${r.total} stripSum=${stripTotal} (unfiltered grid=${all.total})`);
    }
  }, 180_000);
});
