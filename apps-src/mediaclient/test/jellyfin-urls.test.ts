import { describe, it, expect, vi, afterEach } from "vitest";
import { JellyfinBackend } from "../backends/jellyfin/backend";
import type { MediaItem, Session, Track } from "../backends/types";

// Where a URL built from a server's own words is allowed to point.
//
// Three of these carry the account token and reach ANOTHER PROCESS: the stream
// and the sidecar subtitle are handed to mpv, which opens whatever it is given.
// The strings they are built from - `TranscodingUrl`, a subtitle's
// `DeliveryUrl`, an image path - are chosen by the server, and this app will
// sign into servers the household does not own.
//
// The sibling backend states the rule after learning it three times: it is not
// "bound these three functions", it is "bound everything the token is attached
// to". This file is that rule for the second backend.
//
// The trick each case defends against is one parser disagreeing with another.
// Deciding "is this absolute?" with a pattern and then resolving with `new URL`
// reads one value twice: the URL parser strips leading spaces and every tab, CR
// and LF anywhere in the input before parsing, so a value that is not absolute
// to a regex is absolute to it.

const session: Session = {
  kind: "jellyfin",
  profileId: "u1",
  profileName: "test",
  token: "SECRET-token-value",
  accountToken: "SECRET-token-value",
  serverId: "s",
  serverName: "server",
  baseUrl: "http://192.168.1.19:8096",
  location: "lan",
};

const backend = new JellyfinBackend(session, { deviceId: "d1", deviceName: "box" });

function subtitle(key: string): Track {
  return { ordinal: -1, id: "3", kind: "subtitle", label: "sub", external: true, key };
}

function item(thumb: string): MediaItem {
  return { id: "1", kind: "movie", title: "Film", thumb };
}

afterEach(() => vi.unstubAllGlobals());

describe("a subtitle file the player is handed", () => {
  it("carries the token when it is on this server", () => {
    const url = backend.subtitleFileUrl(subtitle("/Videos/1/2/Subtitles/3/0/Stream.srt"));
    expect(url).toContain("192.168.1.19:8096");
    expect(url).toContain("api_key=");
  });

  it("is dropped when the server names another host, in any of its disguises", () => {
    for (const key of [
      "http://elsewhere.example/x",
      "HtTp://elsewhere.example/x",
      "\thttp://elsewhere.example/x",
      "  http://elsewhere.example/x",
      "\nhttp://elsewhere.example/x",
      "//elsewhere.example/x",
      "file:///etc/shadow",
      "smb://attacker/share",
    ]) {
      expect(backend.subtitleFileUrl(subtitle(key)), key).toBeUndefined();
    }
  });
});

describe("artwork built from a server's own path", () => {
  it("stays on the server, and never carries a credential", () => {
    const url = backend.posterUrl(item("Items/1/Images/Primary?tag=abc"), 300, 450);
    expect(url).toContain("192.168.1.19:8096");
    expect(url).not.toContain("api_key");
    expect(url).not.toContain("SECRET-token-value");
  });

  it("is dropped when it points elsewhere", () => {
    expect(backend.posterUrl(item("http://elsewhere.example/x.jpg"), 300, 450)).toBeUndefined();
    expect(backend.posterUrl(item("\thttp://elsewhere.example/x.jpg"), 300, 450)).toBeUndefined();
    // Protocol-relative is the one a leading-slash strip turns into a path by
    // accident on some call paths and not on others - so it is checked here
    // rather than left to luck.
    expect(backend.posterUrl(item("//elsewhere.example/x.jpg"), 300, 450)).toBeUndefined();
    expect(backend.artUrl("http://elsewhere.example/x.jpg")).toBeUndefined();
    expect(backend.artUrl("\t\nhttp://elsewhere.example/x.jpg")).toBeUndefined();
  });
});

describe("the stream URL the server decides", () => {
  function stubPlaybackInfo(transcodingUrl?: string): void {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({
          PlaySessionId: "ps1",
          MediaSources: [
            {
              Id: "ms1",
              TranscodingUrl: transcodingUrl,
              MediaStreams: [{ Index: 0, Type: "Video", Codec: "h264" }],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }

  it("plays a transcode this server is serving", async () => {
    stubPlaybackInfo("/videos/1/master.m3u8?PlaySessionId=ps1");
    const decision = await backend.resolveStream("1", { session: "s" });
    expect(decision.transcoded).toBe(true);
    expect(decision.url).toContain("192.168.1.19:8096");
    expect(decision.url).toContain("api_key=");
  });

  it("refuses to play - and to send the token - when the server points elsewhere", async () => {
    stubPlaybackInfo("http://elsewhere.example/master.m3u8");
    // Refused rather than played without the credential: an unplayable film is
    // a bad evening, a token posted to somebody else's host is worse and
    // silent.
    await expect(backend.resolveStream("1", { session: "s" })).rejects.toThrow();
  });

  it("falls back to a direct stream on this server when there is no transcode", async () => {
    stubPlaybackInfo(undefined);
    const decision = await backend.resolveStream("1", { session: "s" });
    expect(decision.transcoded).toBe(false);
    expect(decision.url).toContain("192.168.1.19:8096/Videos/1/stream");
  });
});

describe("giving up a token", () => {
  it("tells the server before the box forgets how to say so", async () => {
    // A Quick Connect token does not expire. Without this the box signs out,
    // deletes its only copy, and leaves a valid credential listed as an active
    // device that nothing on the television can revoke any more.
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      return new Response("", { status: 204 });
    });

    await backend.revokeSession();
    expect(calls.some((u) => u.includes("/Sessions/Logout"))).toBe(true);
  });

  it("does not fail when the server is off", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network unreachable");
    });
    // A sign-out has to finish either way: somebody who asked to leave must not
    // be left looking at the library because a server is down.
    await expect(backend.revokeSession()).resolves.toBeUndefined();
  });
});
