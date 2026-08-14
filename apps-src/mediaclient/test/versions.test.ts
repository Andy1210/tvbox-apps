import { describe, it, expect } from "vitest";
import { toVersions, type PlexMediaEntry } from "../backends/plex/map";
import type { PlexMetadata } from "../backends/plex/map";

// Choosing between two copies of the same film.
//
// The server leaves its own version title empty in practice, so the label is
// composed here - and what it says decides whether the choice is usable. In a
// real library the copies differ by LANGUAGE as often as by resolution: the same
// film dubbed and original, as two whole files. A label that reads "1080p" twice
// is no help at all.

function media(over: Partial<PlexMediaEntry> & { langs?: string[] } = {}): PlexMediaEntry {
  const { langs = [], ...rest } = over;
  return {
    videoResolution: "1080",
    videoCodec: "h264",
    audioCodec: "ac3",
    Part: [
      {
        id: 1,
        size: 2_000_000_000,
        Stream: [
          { id: 10, streamType: 1, codec: "h264" },
          ...langs.map((l, i) => ({ id: 20 + i, streamType: 2, language: l, codec: "ac3", channels: 6 })),
        ],
      },
    ],
    ...rest,
  };
}

const item = (entries: PlexMediaEntry[]): PlexMetadata & { Media?: PlexMediaEntry[] } => ({
  ratingKey: "1",
  type: "movie",
  title: "A film",
  Media: entries,
});

describe("versions", () => {
  it("says nothing extra when there is only one", () => {
    const [only] = toVersions(item([media({ langs: ["magyar"] })]));
    // With no choice to make, a label describing the file is noise.
    expect(only.label).toBe("?");
    expect(only.index).toBe(0);
  });

  it("names the language when that is what differs", () => {
    const versions = toVersions(item([media({ langs: ["magyar"] }), media({ langs: ["angol"] })]));
    expect(versions.map((v) => v.label)).toEqual(["magyar", "angol"]);
  });

  it("names the resolution when that is what differs", () => {
    const versions = toVersions(
      item([media({ videoResolution: "4k", langs: ["magyar"] }), media({ videoResolution: "720", langs: ["magyar"] })]),
    );
    expect(versions.map((v) => v.label)).toEqual(["4K", "720p"]);
  });

  it("names both when both differ, language first", () => {
    // Language leads because it is the one someone cannot work around: a smaller
    // picture is a compromise, the wrong language is unwatchable.
    const versions = toVersions(
      item([media({ videoResolution: "4k", langs: ["angol"] }), media({ videoResolution: "720", langs: ["magyar"] })]),
    );
    expect(versions[0].label).toBe("angol · 4K");
    expect(versions[1].label).toBe("magyar · 720p");
  });

  it("falls back to size when nothing else separates them", () => {
    // Two identical-looking copies must still be told apart, or the choice is a
    // coin toss.
    const versions = toVersions(
      item([
        media({ langs: ["magyar"], Part: [{ id: 1, size: 2_000_000_000 }] }),
        media({ langs: ["magyar"], Part: [{ id: 2, size: 8_000_000_000 }] }),
      ]),
    );
    expect(versions.map((v) => v.label)).toEqual(["2.0 GB", "8.0 GB"]);
  });

  it("reads the server's own title when it has one", () => {
    const versions = toVersions(item([media({ title: "Director's cut" }), media({ videoResolution: "720" })]));
    expect(versions[0].label).toBe("Director's cut");
  });

  it("writes SD rather than the server's placeholder", () => {
    // "sdp" and "sd" are the server saying it does not know, not a resolution.
    const versions = toVersions(item([media({ videoResolution: "sdp" }), media({ videoResolution: "1080" })]));
    expect(versions.map((v) => v.label)).toEqual(["SD", "1080p"]);
  });

  it("carries the part id, which is what a track change is addressed to", () => {
    const [v] = toVersions(item([media({ Part: [{ id: 4242, size: 1 }] })]));
    expect(v.partId).toBe("4242");
  });
});

describe("tracks", () => {
  const withTracks = item([
    {
      Part: [
        {
          id: 1,
          Stream: [
            { id: 10, streamType: 1, codec: "h264" },
            { id: 20, streamType: 2, language: "magyar", codec: "ac3", channels: 6, selected: true },
            { id: 21, streamType: 2, language: "angol", codec: "aac", channels: 2 },
            { id: 30, streamType: 3, language: "magyar", codec: "srt", key: "/library/streams/30" },
            { id: 31, streamType: 3, language: "angol", codec: "pgs", forced: true },
          ],
        },
      ],
    },
  ]);

  it("numbers tracks within their own type", () => {
    // The box's player counts audio and subtitles separately; handing it a
    // position from a mixed list selects the wrong one.
    const [v] = toVersions(withTracks);
    expect(v.audio.map((a) => a.ordinal)).toEqual([0, 1]);
    expect(v.subtitles.map((s) => s.ordinal)).toEqual([0, 1]);
  });

  it("keeps the server's own id, which is what a change is reported with", () => {
    const [v] = toVersions(withTracks);
    expect(v.audio[1].id).toBe("21");
    expect(v.subtitles[0].id).toBe("30");
  });

  it("marks what the server currently has selected", () => {
    const [v] = toVersions(withTracks);
    expect(v.audio[0].selected).toBe(true);
    expect(v.audio[1].selected).toBe(false);
  });

  it("tells an external subtitle from an embedded one", () => {
    // One lives beside the file and can be handed to the player as a URL; the
    // other is inside it and is chosen by position.
    const [v] = toVersions(withTracks);
    expect(v.subtitles[0].external).toBe(true);
    expect(v.subtitles[1].external).toBe(false);
    expect(v.subtitles[1].forced).toBe(true);
  });

  it("composes a label when the server gives no display title", () => {
    const [v] = toVersions(withTracks);
    expect(v.audio[0].label).toBe("magyar · 5.1 · AC3");
  });
});
