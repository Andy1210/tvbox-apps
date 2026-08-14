import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const say = (s: string): void => require("node:fs").appendFileSync("/tmp/zzcorr2.log", s + "\n");

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

describe.skipIf(!BASE || !TOKEN)("filter values through the app's own path", () => {
  beforeEach(() => vi.unstubAllGlobals());
  const b = (): PlexBackend => new PlexBackend(session, id);

  it("every list filter, first 3 values, exactly as the panel would send them", async () => {
    const back = b();
    for (const key of ["studio", "audioLayout", "contentRating", "collection", "genre", "actor"]) {
      const vals = await back.filterValues("1", key).catch(() => []);
      say(`\n--- ${key} (${vals.length} values)`);
      for (const v of vals.slice(0, 4)) {
        const asIs = await back
          .libraryPage("1", { offset: 0, limit: 1, filters: { [key]: v.key } })
          .then((p) => p.total)
          .catch((e) => `ERR ${String(e)}`);
        const decoded = await back
          .libraryPage("1", { offset: 0, limit: 1, filters: { [key]: safeDecode(v.key) } })
          .then((p) => p.total)
          .catch((e) => `ERR ${String(e)}`);
        say(
          `  ${JSON.stringify(v.title).padEnd(40)} key=${JSON.stringify(v.key).padEnd(34)} appSends=${asIs}  decodedOnce=${decoded}`,
        );
      }
    }
  }, 300_000);

  it("how many studio values the panel would send to an empty grid", async () => {
    const back = b();
    const vals = await back.filterValues("1", "studio");
    let empty = 0;
    let ok = 0;
    for (const v of vals.slice(0, 40)) {
      const t = await back
        .libraryPage("1", { offset: 0, limit: 1, filters: { studio: v.key } })
        .then((p) => p.total ?? 0)
        .catch(() => -1);
      if (t === 0) empty += 1;
      else ok += 1;
    }
    say(`\nstudio: of the first 40 offered values, ${empty} give an EMPTY grid, ${ok} work`);
  }, 300_000);

  it("random sort, through the pager the grid uses", async () => {
    const back = b();
    const a = await back.libraryPage("1", { offset: 0, limit: 5, sort: "random" });
    const c = await back.libraryPage("1", { offset: 0, limit: 5, sort: "random" });
    const d = await back.libraryPage("1", { offset: 5, limit: 5, sort: "random" });
    const idsA = a.items.map((i) => i.id);
    const idsC = c.items.map((i) => i.id);
    const idsD = d.items.map((i) => i.id);
    say(`\nsort=random page0 first call : ${idsA.join(",")}`);
    say(`sort=random page0 second call: ${idsC.join(",")}  same=${idsA.join() === idsC.join()}`);
    say(`sort=random offset5          : ${idsD.join(",")}  overlapsPage0=${idsD.some((x) => idsA.includes(x))}`);
  }, 120_000);
});

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
