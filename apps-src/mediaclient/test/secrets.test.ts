import { describe, it, expect, vi } from "vitest";
import { PlexBackend } from "../backends/plex/backend";
import { redact, redactHeaders } from "../redact";
import type { Session } from "../backends/types";

// The account token is admin-level, and a media server wants it on every
// request. These tests pin the two places it must never reach: a URL that ends
// up in the page, and a log line.

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

describe("artwork URLs", () => {
  const backend = new PlexBackend(session, { clientId: "c", deviceName: "d" });

  it("carries no credential", () => {
    // The URL is rendered into <img src>, so anything in it is in the DOM, the
    // accessibility tree, and whatever the app later reports as now-playing -
    // which on this box is a retained topic other things read.
    const url = backend.posterUrl(
      { id: "1", kind: "movie", title: "x", thumb: "/library/metadata/1/thumb/1" },
      300,
      450,
    );

    expect(url).toBeDefined();
    expect(url).not.toContain(TOKEN);
    expect(url!.toLowerCase()).not.toContain("token");
  });

  it("still asks the server to scale the image", () => {
    // Full-size posters are the expensive mistake: an order of magnitude more
    // bytes and a large decode each, which a grid of them turns into stutter.
    const url = backend.posterUrl({ id: "1", kind: "movie", title: "x", thumb: "/t" }, 300, 450)!;
    expect(url).toContain("width=300");
    expect(url).toContain("height=450");
    // Without `url=` the transcoder answers 400 rather than falling back.
    expect(url).toContain("url=");
  });

  it("hands the credential over as a header instead", () => {
    expect(backend.imageHeaders()["X-Plex-Token"]).toBe(TOKEN);
  });
});

describe("redaction", () => {
  it("hides a token wherever it sits in the query string", () => {
    expect(redact(`http://x/y?X-Plex-Token=${TOKEN}`)).not.toContain(TOKEN);
    expect(redact(`http://x/y?a=1&X-Plex-Token=${TOKEN}&b=2`)).not.toContain(TOKEN);
    expect(redact(`http://x/y?a=1&x-plex-token=${TOKEN}`)).not.toContain(TOKEN);
  });

  it("hides a household PIN", () => {
    // A wrong PIN produces exactly the failed response whose URL gets logged.
    expect(redact("https://plex.tv/api/home/users/3/switch?pin=4821")).not.toContain("4821");
  });

  it("leaves the rest of the URL readable", () => {
    const out = redact(`http://s/library/sections/1/all?sort=titleSort&X-Plex-Token=${TOKEN}`);
    expect(out).toContain("/library/sections/1/all");
    expect(out).toContain("sort=titleSort");
  });

  it("hides credential headers", () => {
    const out = redactHeaders({ Accept: "application/json", "X-Plex-Token": TOKEN, Authorization: "Bearer x" });
    expect(out.Accept).toBe("application/json");
    expect(out["X-Plex-Token"]).not.toContain(TOKEN);
    expect(out.Authorization).not.toContain("Bearer x");
  });
});

describe("artwork the server points elsewhere", () => {
  const backend = new PlexBackend(session, { clientId: "c", deviceName: "d" });

  it("refuses a logo URL that leaves the server", () => {
    // Some artwork arrives as an absolute URL, and the value is the SERVER's.
    // The caller pairs artUrl with imageHeaders(), which carries the account
    // token - so returning a foreign host verbatim would have the box post an
    // admin-level credential wherever the server said, and the receiving host
    // answers its own CORS preflight.
    expect(backend.artUrl("https://attacker.example.com/collect")).toBeUndefined();
    expect(backend.artUrl("http://192.168.1.99:32400/library/x")).toBeUndefined();
    // A protocol-relative URL resolves against the server, and is then dropped
    // by the path bound rather than fetched - the host name became a path
    // segment, which is not an artwork path.
    expect(backend.artUrl("//attacker.example.com/x")).toBeUndefined();
  });

  it("will not let an artwork path reach another endpoint", () => {
    // The origin was the only bound, and it is not enough: this URL is fetched
    // with the account token as a header, so the server chose WHICH of its own
    // endpoints the box called. The traversal form matters most - it looks like
    // a real chapter thumbnail right up to the point where it collapses onto a
    // state-changing GET the server accepts.
    for (const bad of [
      "/library/media/1/chapterImages/../../../../:/scrobble?key=301",
      "/:/scrobble?key=301&identifier=com.plexapp.plugins.library",
      "/security/token?type=delegation&scope=all",
      "/library/sections/1/refresh?force=1",
      "/library/metadata/1/clearLogo/2?X-Plex-Token=attacker",
      "/library/metadata/1/clearLogo/2#/../..",
      "/library/../:/prefs",
    ]) {
      expect(backend.artUrl(bad), bad).toBeUndefined();
    }

    // The two shapes that actually occur, measured over 80 items on this
    // server: a chapter still and a clear logo.
    expect(backend.artUrl("/library/media/151484/chapterImages/3")).toContain("/library/media/151484/chapterImages/3");
    expect(backend.artUrl("/library/metadata/27009/clearLogo/1699887223")).toContain("clearLogo");
  });

  it("still resolves the server's own artwork", () => {
    expect(backend.artUrl("http://192.168.1.10:32400/library/metadata/1/clearLogo/2")).toBe(
      "http://192.168.1.10:32400/library/metadata/1/clearLogo/2",
    );
    expect(backend.artUrl("/library/metadata/1/clearLogo/2")).toContain("192.168.1.10:32400");
  });
});

describe("names the server chooses", () => {
  const backend = new PlexBackend(session, { clientId: "c", deviceName: "d" });

  it("will not take a filter name into a path", async () => {
    // Measured before the bound: a filter key of
    // "../../../../:/scrobble?key=99&identifier=..." reached the server as a
    // state-changing GET with the token attached.
    await expect(backend.filterValues("1", "../../../../:/scrobble?key=99")).rejects.toThrow();
    await expect(backend.filterValues("1", "genre/../..")).rejects.toThrow();
  });

  it("will not let a filter name replace the credential", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ MediaContainer: { Directory: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    // Plex prefers the query parameter over the header, so this would have
    // authenticated as whatever the server named.
    await backend.letters("1", { "X-Plex-Token": "attacker", sort: "hijacked", genre: "5" });
    expect(seen[0]).not.toContain("attacker");
    expect(seen[0]).not.toContain("hijacked");
    expect(seen[0]).toContain("genre=5");
    vi.unstubAllGlobals();
  });
});

describe("everything the credential is attached to", () => {
  const backend = new PlexBackend(session, { clientId: "c", deviceName: "d" });

  it("only ever points at the server", () => {
    // The rule this file needs, and did not have. "Not in the URL" was
    // satisfied by a themeUrl that pointed at attacker.example.com - the token
    // is a HEADER, so a substring check passes while the box posts an
    // admin-level credential to whatever host the metadata named. What matters
    // is the ORIGIN of everything imageHeaders() is handed to.
    const ours = "http://192.168.1.10:32400";
    // The whitespace forms are here because the check used to be a pattern on
    // the raw string while the resolution was `new URL`, and those two parsers
    // read different values: the URL parser strips leading and trailing spaces
    // and every tab, CR and LF anywhere in the input before parsing. So a tab
    // in front of the scheme made the string "not absolute" to the pattern and
    // absolute to the parser, and the off-origin check was skipped entirely.
    const off = [
      "https://attacker.example.com/x",
      "http://192.168.1.99:32400/x",
      "//attacker.example.com/x",
      "\thttps://attacker.example.com/x",
      " https://attacker.example.com/x",
      "\nhttps://attacker.example.com/x",
      "\rhttps://attacker.example.com/x",
      "ht\ttps://attacker.example.com/x",
      "\t//attacker.example.com/x",
      "HTTPS://attacker.example.com/x",
    ];

    for (const bad of off) {
      const art = backend.artUrl(bad);
      if (art) expect(new URL(art).origin).toBe(ours);

      const theme = backend.themeUrl({ id: "1", kind: "show", title: "x", theme: bad });
      if (theme) expect(new URL(theme).origin).toBe(ours);

      const drop = backend.backdropUrl({ id: "1", kind: "show", title: "x", art: bad }, 100, 100);
      if (drop) expect(new URL(drop).origin).toBe(ours);
    }
  });

  it("will not let a theme path reach another endpoint", () => {
    // Same string the filter-name bound was added for, on the call site that
    // shipped three commits later without one: with the token attached, this
    // is a state-changing GET chosen by the server.
    for (const bad of [
      "/../:/scrobble?key=99&identifier=com.plexapp.plugins.library",
      "/:/scrobble?key=99",
      "/library/sections/1/refresh",
      "/library/metadata/1/theme/2/../../..",
    ]) {
      expect(backend.themeUrl({ id: "1", kind: "show", title: "x", theme: bad })).toBeUndefined();
    }

    // The real shape still works.
    const ok = backend.themeUrl({
      id: "1",
      kind: "show",
      title: "x",
      theme: "/library/metadata/61161/theme/1784859962",
    });
    expect(ok).toContain("/library/metadata/61161/theme/1784859962");
  });

  it("will not let a part key reach another endpoint", async () => {
    // This URL is the one the token has to travel in, because the player is a
    // separate process that cannot send headers - so it ends up in mpv's argv
    // and its log. Bounding it to the server is not enough: a relative path
    // cannot change the host, so `..` kept the origin and aimed a tokened,
    // state-changing GET at any endpoint on it.
    const decision = (key: string): string =>
      JSON.stringify({
        MediaContainer: {
          Metadata: [{ Media: [{ Part: [{ decision: "directplay", key }] }] }],
        },
      });

    let body = "";
    vi.stubGlobal(
      "fetch",
      async () => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    for (const bad of [
      "/library/parts/1/2/../../../../:/scrobble",
      "/library/parts/1/2/\\..\\..",
      "/library/parts/1/2/sub/dir.mkv",
    ]) {
      body = decision(bad);
      await expect(backend.resolveStream("1", { session: "s" })).rejects.toThrow();
    }

    // The real shape this server sends still plays.
    body = decision("/library/parts/55784/1457113393/file.mkv");
    const out = await backend.resolveStream("1", { session: "s" });
    expect(out.url).toContain("/library/parts/55784/1457113393/file.mkv");
    vi.unstubAllGlobals();
  });
});
