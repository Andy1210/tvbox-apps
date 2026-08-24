import { describe, it, expect } from "vitest";
import {
  epochSeconds,
  imagePath,
  itemKind,
  msToTicks,
  ticksToMs,
  toChapters,
  toDetail,
  toItem,
  toLibrary,
  toTracks,
  toVersion,
  type JellyfinStream,
} from "../backends/jellyfin/map";

// Turning Jellyfin's shapes into the ones the screens read.
//
// This file had no test at all, and both of the defects found in it were the
// kind nothing errors on: a subtitle that could never be turned on, and two
// subtitles that were one row to the remote. The live suite exercises the
// requests; this exercises the conversion, which is where the numbers are.

describe("time", () => {
  it("converts ticks of 100 nanoseconds, both directions", () => {
    // A two-hour film. Getting this wrong by a factor of ten thousand is the
    // whole reason it is a named function.
    expect(ticksToMs(72_000_000_000)).toBe(7_200_000);
    expect(msToTicks(7_200_000)).toBe(72_000_000_000);
    expect(ticksToMs(msToTicks(1234))).toBe(1234);
  });

  it("answers nothing for what is not a number", () => {
    expect(ticksToMs(undefined)).toBeUndefined();
    expect(ticksToMs(null)).toBeUndefined();
    expect(ticksToMs(Number.NaN)).toBeUndefined();
    expect(msToTicks(-5), "a negative position is zero, not a negative tick").toBe(0);
  });

  it("reads a date as epoch seconds, which is what the item type carries", () => {
    expect(epochSeconds("2026-08-15T20:00:00.000Z")).toBe(1786824000);
    expect(epochSeconds(undefined)).toBeUndefined();
    expect(epochSeconds("not a date")).toBeUndefined();
  });
});

describe("an item", () => {
  it("carries the fields a tile draws", () => {
    const it = toItem({
      Id: "abc",
      Name: "Film",
      Type: "Movie",
      SortName: "film",
      ProductionYear: 2015,
      RunTimeTicks: 60_758_400_000,
      ImageTags: { Primary: "tag1" },
      BackdropImageTags: ["tag2"],
      DateCreated: "2026-01-02T03:04:05.000Z",
      UserData: { PlaybackPositionTicks: 30_000_000, PlayCount: 2, LastPlayedDate: "2026-02-03T00:00:00.000Z" },
    });
    expect(it.kind).toBe("movie");
    expect(it.durationMs).toBe(6_075_840);
    expect(it.viewOffsetMs).toBe(3000);
    expect(it.viewCount).toBe(2);
    expect(it.thumb).toContain("Items/abc/Images/Primary");
    expect(it.art).toContain("Images/Backdrop");
  });

  it("leaves the progress bar off something nobody has started", () => {
    // Jellyfin sends 0 for everything untouched, and a 0 here puts an empty
    // progress bar on every poster in the library.
    const it = toItem({ Id: "a", Name: "x", Type: "Movie", UserData: { PlaybackPositionTicks: 0 } });
    expect(it.viewOffsetMs).toBeUndefined();
  });

  it("splits an episode's names the way the screens read them", () => {
    const ep = toItem({
      Id: "e1",
      Name: "1. epizód",
      Type: "Episode",
      SeriesName: "Sorozat",
      SeriesId: "s1",
      SeasonName: "1. évad",
      ParentId: "se1",
      IndexNumber: 1,
      ParentIndexNumber: 2,
      SeriesPrimaryImageTag: "stag",
    });
    expect(ep.kind).toBe("episode");
    expect(ep.grandparentTitle).toBe("Sorozat");
    expect(ep.parentTitle, "the season, which is what sits under an episode's title").toBe("1. évad");
    expect(ep.grandparentId).toBe("s1");
    expect(ep.grandparentThumb).toContain("Items/s1/Images/Primary");
    expect(ep.index).toBe(1);
    expect(ep.parentIndex).toBe(2);
  });

  it("maps the types it knows and keeps the rest visible", () => {
    expect(itemKind("Series")).toBe("show");
    expect(itemKind("Season")).toBe("season");
    expect(itemKind("BoxSet")).toBe("collection");
    expect(itemKind("Playlist")).toBe("playlist");
    // An unknown type still has a title and a poster; a hole in a row is worse
    // than something slightly mislabelled.
    expect(itemKind("MusicVideo")).toBe("movie");
  });

  it("escapes what goes into an image path", () => {
    expect(imagePath("a/b", "t")).toContain("a%2Fb");
    expect(imagePath("a", undefined), "no tag means no image, not a 404 placeholder").toBeUndefined();
  });

  it("calls a library by the kind the screens branch on", () => {
    expect(toLibrary({ Id: "1", Name: "Movies", CollectionType: "movies" }).kind).toBe("movie");
    expect(toLibrary({ Id: "2", Name: "Shows", CollectionType: "tvshows" }).kind).toBe("show");
    // A mixed library is a real configuration, not an error.
    expect(toLibrary({ Id: "3", Name: "Vegyes" }).kind).toBe("other");
  });
});

describe("tracks", () => {
  const streams: JellyfinStream[] = [
    { Index: 0, Type: "Video", Codec: "h264" },
    { Index: 1, Type: "Audio", Language: "hun", DisplayTitle: "Magyar" },
    { Index: 2, Type: "Audio", Language: "eng", DisplayTitle: "English" },
    { Index: 3, Type: "Subtitle", Language: "hun", DisplayTitle: "Magyar felirat" },
    {
      Index: 4,
      Type: "Subtitle",
      Language: "eng",
      IsExternal: true,
      DeliveryUrl: "/Videos/1/2/Subtitles/4/0/Stream.srt",
    },
    {
      Index: 5,
      Type: "Subtitle",
      Language: "ger",
      IsExternal: true,
      DeliveryUrl: "/Videos/1/2/Subtitles/5/0/Stream.srt",
    },
  ];

  it("numbers what is inside the file from zero, ignoring the video", () => {
    // The ordinal is what the box's player counts, and it counts per type.
    const audio = toTracks(streams, "Audio");
    expect(audio.map((t) => t.ordinal)).toEqual([0, 1]);
    expect(
      audio.map((t) => t.id),
      "the server's own index, for asking it things",
    ).toEqual(["1", "2"]);
  });

  it("gives every sidecar its own negative ordinal", () => {
    // One shared -1 made two sidecars a single row to the remote: the track
    // menu builds its focus keys from the ordinal, so the second was
    // unreachable, and a lookup by ordinal always found the first.
    const subs = toTracks(streams, "Subtitle");
    expect(subs.map((t) => t.ordinal)).toEqual([0, -1, -2]);
    expect(new Set(subs.map((t) => t.ordinal)).size).toBe(subs.length);
    expect(subs[1].external).toBe(true);
    expect(subs[1].key).toContain("Subtitles/4");
  });

  it("keeps an embedded track's number even when a sidecar comes first", () => {
    const odd = toTracks(
      [
        { Index: 1, Type: "Subtitle", IsExternal: true, DeliveryUrl: "/x" },
        { Index: 2, Type: "Subtitle" },
        { Index: 3, Type: "Subtitle" },
      ],
      "Subtitle",
    );
    // The two inside the file are still 0 and 1 - they are what the player
    // counts, and it cannot see the sidecar at all.
    expect(odd.map((t) => t.ordinal)).toEqual([-1, 0, 1]);
  });
});

describe("a file and its chapters", () => {
  it("describes a version by what it is, not by the file name", () => {
    const v = toVersion(
      {
        Id: "ms1",
        Name: "Some.Release.Name.1080p.mkv",
        Bitrate: 11_389_750,
        Size: 4_000_000_000,
        RunTimeTicks: 60_758_400_000,
        MediaStreams: [
          { Index: 0, Type: "Video", Codec: "h264", Height: 800 },
          { Index: 1, Type: "Audio", Codec: "eac3", Language: "hun", Channels: 6 },
        ],
      },
      0,
    );
    expect(v.partId).toBe("ms1");
    expect(v.resolution).toBe("800p");
    expect(v.bitrateKbps).toBe(11_390);
    expect(v.durationMs).toBe(6_075_840);
    expect(v.label).toContain("800p");
    expect(v.label).not.toContain("Some.Release");
    // Jellyfin has no split-part concept: a two-disc film is two sources.
    expect(v.parts).toBe(1);
    expect(v.partIndex).toBe(0);
  });

  it("gives every chapter an end, because a band cannot be drawn from a start", () => {
    const ch = toChapters(
      [
        { StartPositionTicks: 0, Name: "Kezdés", ImageTag: "t0" },
        { StartPositionTicks: 6_000_000_000, Name: "Közép" },
      ],
      "item1",
      1_200_000,
    );
    expect(ch[0].endMs).toBe(600_000);
    expect(ch[1].endMs, "the last one runs to the end of the film").toBe(1_200_000);
    expect(ch[0].thumb).toContain("Images/Chapter/0");
    expect(ch[1].thumb, "no image tag means no still").toBeUndefined();
  });
});

describe("a detail", () => {
  it("puts both scores on the scale the screens draw", () => {
    // The community rates out of ten and the critics out of a hundred, and the
    // interface says 0-10.
    const d = toDetail({
      Id: "1",
      Name: "Film",
      Type: "Movie",
      CommunityRating: 8.3,
      CriticRating: 94,
      People: [
        { Id: "p1", Name: "Színész", Role: "Szerep", Type: "Actor", PrimaryImageTag: "pt" },
        { Id: "p2", Name: "Rendező", Type: "Director" },
      ],
      Genres: ["Akció"],
      Studios: [{ Name: "Stúdió" }],
      Taglines: ["Egy mondat"],
      ProviderIds: { Imdb: "tt1" },
    });
    expect(d.scores.find((s) => s.kind === "audience")?.value).toBe(8.3);
    expect(d.scores.find((s) => s.kind === "critic")?.value).toBe(9.4);
    expect(d.roles).toHaveLength(1);
    expect(d.roles[0].character).toBe("Szerep");
    expect(d.directors).toEqual(["Rendező"]);
    expect(d.tagline).toBe("Egy mondat");
    expect(d.studio).toBe("Stúdió");
    // Jellyfin holds no written reviews at all, and the screen draws nothing
    // for an empty list.
    expect(d.reviews).toEqual([]);
  });
});

describe("what a sort is called", () => {
  it("follows the screen's language rather than one baked in", async () => {
    const { configureI18n, useLocaleStore } = await import("@sdk");
    const en = (await import("../locales/en.json")).default;
    const hu = (await import("../locales/hu.json")).default;
    const { JellyfinBackend } = await import("../backends/jellyfin/backend");
    configureI18n({ hu, en }, { fallback: "en" });
    const backend = new JellyfinBackend(
      {
        kind: "jellyfin",
        profileId: "u",
        profileName: "u",
        token: "t",
        accountToken: "t",
        serverId: "s",
        serverName: "s",
        baseUrl: "http://x:8096",
        location: "lan",
      },
      { deviceId: "d", deviceName: "b" },
    );

    // Jellyfin names none of these itself - Plex answers in the language the
    // request carries and this server has no such endpoint - so a hardcoded
    // list showed Hungarian to an English screen.
    useLocaleStore.setState({ locale: "en" });
    expect((await backend.sortOptions()).map((s2) => s2.title)).toContain("Date added");
    expect((await backend.filterOptions()).map((f) => f.title)).toContain("Genre");

    useLocaleStore.setState({ locale: "hu" });
    expect((await backend.sortOptions()).map((s2) => s2.title)).toContain("Hozzáadva");
    expect((await backend.filterOptions()).map((f) => f.title)).toContain("Műfaj");
  });
});

describe("the unwatched count a tile now reads as \"finished\"", () => {
  it("is set for a series and a season and for nothing else", () => {
    // Jellyfin fills UnplayedItemCount in for a boxset and a playlist as well,
    // and a tile draws its tick from that count being zero - so a collection
    // with nothing marked would carry a watched tick that means nothing. The
    // Plex mapper has always restricted it to the two kinds it describes.
    const count = (type: string): number | undefined =>
      toItem({ Id: "1", Name: "x", Type: type, UserData: { UnplayedItemCount: 0 } } as never).unwatchedCount;
    expect(count("Series")).toBe(0);
    expect(count("Season")).toBe(0);
    expect(count("BoxSet")).toBeUndefined();
    expect(count("Playlist")).toBeUndefined();
    expect(count("Movie")).toBeUndefined();
  });
});
