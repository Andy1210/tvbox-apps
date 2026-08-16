import { describe, it, expect } from "vitest";
import { toItem, toKind, toLibrary } from "../backends/plex/map";
import { PlexBackend } from "../backends/plex/backend";
import type { Session } from "../backends/types";

const session: Session = {
  kind: "plex",
  profileId: "1",
  profileName: "home",
  token: "TOKEN",
  accountToken: "TOKEN",
  serverId: "MACHINE",
  serverName: "MediaServer",
  baseUrl: "http://server:32400",
  location: "lan",
};

const backend = new PlexBackend(session, { clientId: "c", deviceName: "box" });

describe("what a music library looks like on the way in", () => {
  it("names the three music kinds", () => {
    expect(toKind("artist")).toBe("artist");
    expect(toKind("album")).toBe("album");
    expect(toKind("track")).toBe("track");
  });

  it("calls an artist section a music library", () => {
    expect(toLibrary({ key: "5", title: "Music", type: "artist" }).kind).toBe("music");
  });

  it("keeps a track's file, so a queue costs no request per song", () => {
    const item = toItem({
      ratingKey: 1,
      type: "track",
      title: "Alone",
      parentTitle: "Alone",
      grandparentTitle: "Alan Walker",
      duration: 162_000,
      Media: [{ Part: [{ key: "/library/parts/63598/1547419084/file.mp3" }] }],
    });
    expect(item.kind).toBe("track");
    expect(item.grandparentTitle).toBe("Alan Walker");
    expect(item.mediaKey).toBe("/library/parts/63598/1547419084/file.mp3");
  });

  it("leaves the file undefined when the server sent none", () => {
    // Guessed paths reach the player and fail where nothing can explain it.
    expect(toItem({ ratingKey: 2, type: "album", title: "Alone" }).mediaKey).toBeUndefined();
  });

  it("falls back to the album's cover, which is what a track usually has", () => {
    // Measured on this library: 197 of 462 tracks carry their own art and 461
    // can reach one through the album.
    const item = toItem({ ratingKey: 3, type: "track", title: "x", parentThumb: "/album/art" });
    expect(item.thumb).toBe("/album/art");
  });
});

describe("playing one track", () => {
  it("builds a direct URL carrying the credential, because the player is another process", () => {
    const url = backend.trackUrl({
      id: "1",
      kind: "track",
      title: "Alone",
      mediaKey: "/library/parts/1/2/file.mp3",
    });
    expect(url).toContain("http://server:32400/library/parts/1/2/file.mp3");
    expect(url).toContain("X-Plex-Token=TOKEN");
  });

  it("answers nothing for an item with no file, rather than a URL that 404s", () => {
    expect(backend.trackUrl({ id: "1", kind: "album", title: "Alone" })).toBeUndefined();
  });
});

describe("writing a playlist", () => {
  it("refuses ids that are not rating keys", async () => {
    // The uri is a server-side selector carried with an admin token; one
    // free-form entry in the comma-joined list would address something else.
    await expect(backend.createPlaylist("x", ["../../:/prefs?x=1"], "audio")).rejects.toThrow();
    await expect(backend.addToPlaylist("12", [])).rejects.toThrow();
  });

  it("refuses a playlist id that is not one", async () => {
    await expect(backend.addToPlaylist("../../:/prefs", ["1"])).rejects.toThrow();
  });
});
