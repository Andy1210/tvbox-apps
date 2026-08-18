import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetCastQueue,
  isActive,
  rememberCastQueue,
  stopped,
  timelineFor,
  timelineXml,
  type Timeline,
} from "../playback/timeline";
import type { MediaItem } from "../backends/types";

const track = (id: string): MediaItem =>
  ({ id, kind: "track", title: "You Shook Me All Night Long", versions: [] }) as unknown as MediaItem;

const server = { machineIdentifier: "MACHINE", baseUrl: "https://box.plex.direct:32400" };

describe("companion timeline", () => {
  beforeEach(() => {
    forgetCastQueue("music");
    forgetCastQueue("video");
  });

  it("reports all three kinds, so a controller can change its mind", () => {
    // A phone decides which player it is holding from the line that is not
    // stopped. Reporting only the kind that plays leaves it holding the
    // previous one - it never hears that the other stopped.
    const lines = [
      timelineFor("video", { item: null, state: "stopped", positionMs: 0, durationMs: 0 }, server),
      timelineFor("music", { item: track("1"), state: "playing", positionMs: 1000, durationMs: 2000 }, server),
      stopped("photo"),
    ];
    expect(lines.map((l) => l.type)).toEqual(["video", "music", "photo"]);
    expect(lines.map((l) => l.state)).toEqual(["stopped", "playing", "stopped"]);
  });

  it("is stopped when there is no item, whatever the state says", () => {
    // The stores clear the item first and the state a moment later, and a line
    // claiming to play nothing makes a phone draw a scrubber over a blank title.
    const line = timelineFor("music", { item: null, state: "playing", positionMs: 5, durationMs: 5 }, server);
    expect(line.state).toBe("stopped");
    expect(line.key).toBeUndefined();
  });

  it("carries the queue a cast arrived with", () => {
    rememberCastQueue("music", "/playQueues/20426", { entryIds: { "65823": "9911" }, version: "7" });
    const line = timelineFor("music", { item: track("65823"), state: "playing", positionMs: 0, durationMs: 1 }, server);
    expect(line.containerKey).toBe("/playQueues/20426");
    expect(line.playQueueID).toBe("20426");
    // WHICH row is playing, by the queue's own id for it - a controller has no
    // remote to draw without one.
    expect(line.playQueueItemID).toBe("9911");
    expect(line.playQueueVersion).toBe("7");
    expect(line.key).toBe("/library/metadata/65823");
    expect(line.ratingKey).toBe("65823");
  });

  it("drops the queue when that kind stops", () => {
    // Otherwise a queue outlives the music it described and is reported against
    // the next thing somebody starts from the television.
    rememberCastQueue("music", "/playQueues/1");
    timelineFor("music", { item: null, state: "stopped", positionMs: 0, durationMs: 0 }, server);
    const next = timelineFor("music", { item: track("2"), state: "playing", positionMs: 0, durationMs: 1 }, server);
    expect(next.containerKey).toBeUndefined();
    expect(next.playQueueID).toBeUndefined();
  });

  it("names the server and a port even when the url leaves it out", () => {
    // An empty port attribute is an address a controller cannot reach.
    const line = timelineFor(
      "video",
      { item: track("7"), state: "playing", positionMs: 0, durationMs: 1 },
      { machineIdentifier: "M", baseUrl: "https://example.plex.direct" },
    );
    expect(line.protocol).toBe("https");
    expect(line.address).toBe("example.plex.direct");
    expect(line.port).toBe("443");
    expect(line.machineIdentifier).toBe("M");
  });

  it("survives a base url it cannot parse", () => {
    const line = timelineFor(
      "music",
      { item: track("7"), state: "playing", positionMs: 0, durationMs: 1 },
      {
        machineIdentifier: "M",
        baseUrl: "not a url",
      },
    );
    expect(line.state).toBe("playing");
    expect(line.address).toBeUndefined();
  });

  it("sends shuffle and repeat as the numbers the protocol uses", () => {
    const line = timelineFor(
      "music",
      { item: track("1"), state: "playing", positionMs: 0, durationMs: 1, shuffle: true, repeat: 2 },
      server,
    );
    expect(line.shuffle).toBe(1);
    expect(line.repeat).toBe(2);
  });

  it("claims only controls this app implements", () => {
    // A phone greys out what is missing; claiming a control that does nothing
    // draws a button that answers a press with silence.
    const music = timelineFor("music", { item: track("1"), state: "playing", positionMs: 0, durationMs: 1 }, server);
    expect(music.controllable).toContain("skipNext");
    const video = timelineFor("video", { item: track("1"), state: "playing", positionMs: 0, durationMs: 1 }, server);
    expect(video.controllable).not.toContain("skipNext");
    // Nothing without a handler. `shuffle`/`repeat` arrive as `setParameters`
    // and the stream pickers as `setStreams`, and neither is implemented - this
    // assertion pinned the claim rather than the behaviour before.
    for (const claimed of [music.controllable, video.controllable]) {
      for (const absent of ["shuffle", "repeat", "subtitleStream", "audioStream", "volume"]) {
        expect(claimed, absent).not.toContain(absent);
      }
    }
  });

  it("rounds the clock, because the protocol counts whole milliseconds", () => {
    const line = timelineFor(
      "music",
      { item: track("1"), state: "playing", positionMs: 1234.7, durationMs: -5 },
      server,
    );
    expect(line.time).toBe(1235);
    expect(line.duration).toBe(0);
  });

  describe("the document", () => {
    it("is attributes only, with the location on the container", () => {
      const xml = timelineXml([stopped("video"), stopped("music"), stopped("photo")]);
      expect(xml).toContain('<MediaContainer location="navigation">');
      expect(xml.match(/<Timeline /g)).toHaveLength(3);
      expect(xml).not.toContain("undefined");
    });

    it("escapes what a title can contain", () => {
      // Not a title today - but `key` and `containerKey` are server-shaped
      // strings and one unescaped ampersand makes the whole report unparseable,
      // which a controller reads as the box saying nothing.
      const line: Timeline = { type: "music", state: "playing", key: 'a&b<c>"d"' };
      const xml = timelineXml([line]);
      expect(xml).toContain("a&amp;b&lt;c&gt;&quot;d&quot;");
    });

    it("leaves out what is not set", () => {
      const xml = timelineXml([{ type: "music", state: "stopped", controllable: "" }]);
      expect(xml).not.toContain("controllable");
    });
  });

  it("knows when a report is worth repeating", () => {
    // While something moves every tick is worth sending; while nothing does,
    // only a change is - otherwise a box on a poster grid posts the same three
    // stopped lines forever.
    expect(isActive([stopped("video"), stopped("music")])).toBe(false);
    expect(isActive([stopped("video"), { type: "music", state: "playing" }])).toBe(true);
    expect(isActive([{ type: "video", state: "buffering" }])).toBe(true);
    expect(isActive([{ type: "video", state: "paused" }])).toBe(false);
  });
});
