import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { usePlayer, resetPlayer } from "../playback/player";
import { PlexBackend } from "../backends/plex/backend";
import type { MediaItem, Session, Track } from "../backends/types";

/**
 * A subtitle that lives beside the file rather than inside it.
 *
 * It has no position among the container's tracks, so it cannot be chosen by
 * index - a negative index means "no subtitles" to the player. There are TWO
 * paths that choose one and they used to disagree: before playback through
 * `resolveStream`, and during it through the track menu, which on a direct-play
 * file never goes near `resolveStream` at all.
 */

const session: Session = {
  profileId: "p",
  profileName: "p",
  token: "s3cr3t-token",
  accountToken: "s3cr3t-token",
  serverId: "s",
  serverName: "s",
  baseUrl: "http://192.168.1.10:32400",
  location: "lan",
};

const sub = (over: Partial<Track>): Track => ({
  ordinal: 0,
  id: "1",
  kind: "subtitle",
  label: "x",
  ...over,
});

describe("the file a sidecar is handed over as", () => {
  const backend = new PlexBackend(session, { clientId: "c", deviceName: "d" });

  it("is built for an external track and for nothing else", () => {
    const url = backend.subtitleFileUrl(sub({ ordinal: -1, id: "9", external: true, key: "/library/streams/26560" }));
    expect(url).toContain("/library/streams/26560");
    expect(new URL(url!).origin).toBe("http://192.168.1.10:32400");

    // An embedded track is selected by index; there is no file to open.
    expect(backend.subtitleFileUrl(sub({ ordinal: 0, id: "1" }))).toBeUndefined();
  });

  it("refuses a path that is not a stream", () => {
    // Same bound, and the same reason, as the media part: this URL carries the
    // token and is handed to another process, where it lands in argv and logs.
    for (const key of [
      "/library/streams/1/../../:/scrobble",
      "/:/scrobble?key=9",
      "http://elsewhere.example.com/x",
      "\thttp://elsewhere.example.com/x",
      "//elsewhere.example.com/x",
      "/library/streams/",
    ]) {
      expect(backend.subtitleFileUrl(sub({ ordinal: -1, id: "9", external: true, key })), key).toBeUndefined();
    }
  });
});

describe("choosing one while the film is already playing", () => {
  let selections: { audio?: number; sub?: number; subFile?: string }[] = [];

  const versions = [
    {
      index: 0,
      label: "1080p",
      partId: "1",
      audio: [sub({ kind: "audio", ordinal: 0, id: "a0" })],
      subtitles: [
        sub({ ordinal: 0, id: "e0", label: "Magyar" }),
        sub({ ordinal: -1, id: "x1", label: "SRT 1", external: true, key: "/library/streams/111" }),
        sub({ ordinal: -2, id: "x2", label: "SRT 2", external: true, key: "/library/streams/222" }),
      ],
    },
  ];

  beforeEach(async () => {
    selections = [];
    (globalThis as { window?: unknown }).window = globalThis;
    (globalThis as unknown as { tvbox: unknown }).tvbox = {
      play: () => {},
      stop: () => {},
      selectStreams: (s: { audio?: number; sub?: number; subFile?: string }) => selections.push(s),
      onPlayer: () => () => {},
      panel: { width: 1920, height: 1080 },
    };

    const item: MediaItem = { id: "m1", kind: "movie", title: "Film" };
    const written: { audioId?: string; subtitleId?: string }[] = [];
    (globalThis as unknown as { written: unknown }).written = written;
    await usePlayer.getState().play(
      {
        kind: "plex",
        resolveStream: async () => ({
          url: "http://192.168.1.10:32400/library/parts/1/2/f.mkv",
          audio: "auto",
          sub: "no",
          session: "s",
          // Direct play: this is the path that never reaches resolveStream again.
          transcoded: false,
          version: 0,
        }),
        markers: async () => [],
        item: async () => ({ id: "m1", kind: "movie", title: "Film", versions, roles: [], extras: [] }),
        children: async () => [],
        subtitleFileUrl: (t: Track) => new PlexBackend(session, { clientId: "c", deviceName: "d" }).subtitleFileUrl(t),
        setTracks: async (_id: string, _v: number, c: { audioId?: string; subtitleId?: string }) => {
          written.push(c);
        },
        reportProgress: async () => {},
        keepAlive: async () => {},
        endSession: async () => {},
      } as never,
      item,
      {},
    );
    selections = [];
  });

  afterEach(() => resetPlayer());

  it("hands the player a file, not a negative track index", async () => {
    await usePlayer.getState().changeTracks({ version: 0, subtitle: -1 });
    expect(selections.some((s) => s.subFile?.includes("/library/streams/111"))).toBe(true);
    // -1 is how the player is told OFF, so it must not travel as the choice.
    expect(selections.some((s) => s.sub === -1)).toBe(false);
  });

  it("tells them apart when an item has several", async () => {
    // With one shared -1 the second sidecar emitted no command at all, while the
    // menu moved its tick to it - a row shown as chosen and not in force.
    await usePlayer.getState().changeTracks({ version: 0, subtitle: -2 });
    expect(selections.some((s) => s.subFile?.includes("/library/streams/222"))).toBe(true);
  });

  it("still writes the right stream id to the server", async () => {
    // Resolved by ordinal: indexing by the choice read off the end of the array
    // for a negative one, so nothing was remembered and nothing said so.
    await usePlayer.getState().changeTracks({ version: 0, subtitle: -2 });
    const written = (globalThis as unknown as { written: { subtitleId?: string }[] }).written;
    expect(written.at(-1)?.subtitleId).toBe("x2");
  });

  it("selects an embedded one by index, as before", async () => {
    await usePlayer.getState().changeTracks({ version: 0, subtitle: 0 });
    expect(selections.some((s) => s.sub === 0)).toBe(true);
    expect(selections.some((s) => s.subFile)).toBe(false);
  });

  it("still turns subtitles off", async () => {
    await usePlayer.getState().changeTracks({ version: 0, subtitle: "none" });
    expect(selections.some((s) => s.sub === -1)).toBe(true);
  });
});
