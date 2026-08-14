import { describe, it, expect } from "vitest";
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
    const url = backend.posterUrl({ id: "1", kind: "movie", title: "x", thumb: "/library/metadata/1/thumb/1" }, 300, 450);

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
