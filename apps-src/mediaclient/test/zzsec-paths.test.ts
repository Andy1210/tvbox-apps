import { describe, it, expect, vi } from "vitest";
import { PlexBackend } from "../backends/plex/backend";
import type { Session } from "../backends/types";

const TOKEN = "s3cr3t-account-token";
const session: Session = {
  profileId: "p",
  profileName: "p",
  token: TOKEN,
  accountToken: TOKEN,
  serverId: "s",
  serverName: "s",
  baseUrl: "http://192.168.1.10:32400",
  location: "lan",
};

/** Capture every URL + header bag fetch is called with, answer with `body`. */
function spyFetch(body: unknown): { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        blob: async () => new Blob([]),
      } as unknown as Response;
    }),
  );
  return { calls };
}

const backend = (): PlexBackend => new PlexBackend(session, { clientId: "c", deviceName: "d" });

describe("PROBE: server-controlled path segments", () => {
  it("filterValues does not encode the filter it was given", async () => {
    const f = spyFetch({ MediaContainer: { Directory: [] } });
    await backend().filterValues("1", "../../../../:/scrobble?key=99&identifier=com.plexapp.plugins.library");
    console.log("filterValues traversal ->", f.calls[0].url);
    expect(f.calls[0].url).toBeDefined();
  });

  it("filterValues can be pushed onto plex.tv-shaped paths / other server paths", async () => {
    const f = spyFetch({ MediaContainer: { Directory: [] } });
    await backend().filterValues("1", "..%2f..%2f..%2fsystem");
    console.log("filterValues encoded traversal ->", f.calls[0].url);

    const g = spyFetch({ MediaContainer: { Directory: [] } });
    await backend().filterValues("1", "//evil.example.com/x");
    console.log("filterValues protocol-relative ->", g.calls[0].url);

    const h = spyFetch({ MediaContainer: { Directory: [] } });
    await backend().filterValues("1", "\\\\evil.example.com/x");
    console.log("filterValues backslash ->", h.calls[0].url);
  });

  it("letterPage DOES encode its key (the asymmetry)", async () => {
    const f = spyFetch({ MediaContainer: { Metadata: [] } });
    await backend().letterPage("1", "../../../../:/scrobble?key=99", { offset: 0, limit: 1 });
    console.log("letterPage traversal attempt ->", f.calls[0].url);
  });

  it("letters() spreads server-supplied filter KEYS straight into the query", async () => {
    const f = spyFetch({ MediaContainer: { Directory: [] } });
    await backend().letters("1", { "X-Plex-Token": "attacker-chosen", genre: "5" });
    console.log("letters with hostile filter key ->", f.calls[0].url);
    console.log("letters headers ->", JSON.stringify(f.calls[0].headers));
  });

  it("libraryPage: a filter key can overwrite sort but not the paging", async () => {
    const f = spyFetch({ MediaContainer: { Metadata: [], totalSize: 0 } });
    await backend().libraryPage("1", {
      offset: 0,
      limit: 5,
      sort: "titleSort",
      filters: { sort: "hijacked", "X-Plex-Container-Size": "99999" },
    });
    console.log("libraryPage hostile filter keys ->", f.calls[0].url);
  });

  it("artUrl returns an absolute server-supplied URL verbatim", () => {
    const b = backend();
    const u = b.artUrl("https://attacker.example.com/collect");
    console.log("artUrl absolute ->", u, " headers ->", JSON.stringify(b.imageHeaders()));
    expect(u).toBe("https://attacker.example.com/collect");
    expect(b.imageHeaders()["X-Plex-Token"]).toBe(TOKEN);
  });

  it("no length bound on titles that reach the UI", async () => {
    const long = "x".repeat(5000);
    spyFetch({ MediaContainer: { Directory: [{ key: "1", title: long, size: 1, filter: "genre" }] } });
    const opts = await backend().filterOptions("1");
    const vals = await backend().filterValues("1", "genre");
    const ls = await backend().letters("1");
    console.log("filterOption title length ->", opts[0]?.title.length);
    console.log("filterValue title length ->", vals[0]?.title.length);
    console.log("letter bucket title length ->", ls[0]?.title.length);
  });

  it("letterOffset request count on a claimed-huge library", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        n += 1;
        const s = String(url);
        const body = s.includes("firstCharacter")
          ? { MediaContainer: { Directory: [{ key: "A", title: "A", size: 1 }, { key: "Z", title: "Z", size: 1 }] } }
          : { MediaContainer: { Metadata: [{ ratingKey: "1", title: "A", type: "movie" }], totalSize: 2_000_000_000 } };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
      }),
    );
    const off = await backend().letterOffset("1", "Z", {});
    console.log("letterOffset requests ->", n, "offset ->", off);
  });
});
