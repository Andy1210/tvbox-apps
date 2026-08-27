import { describe, it, expect } from "vitest";
import { reportedPosition } from "../playback/player";

// What the SERVER is told, which is not always what is on screen. Three
// separate reasons this is not `positionMs`, and each of them was a bug:
// a committed scrub the box has not reported back yet, a target that is out of
// range and therefore never settles, and an item that never said how long it is.

describe("the position reported to the server", () => {
  it("prefers a committed seek to the position the box last reported", () => {
    // The box answers a seek a moment later, and a report can land in between:
    // scrub twenty minutes on, press Back, and the resume point was the place
    // the film had been before the scrub.
    expect(reportedPosition({ positionMs: 600_000, seekTargetMs: 1_800_000, durationMs: 3_600_000 })).toBe(1_800_000);
    expect(reportedPosition({ positionMs: 600_000, seekTargetMs: null, durationMs: 3_600_000 })).toBe(600_000);
  });

  it("clamps, because the target is a number a caller can hand in", () => {
    // `seekTo` does not clamp the way `seekBy` and `commitScrub` do, and the
    // Plex Companion door passes on whatever offset it was sent. Out of range it
    // never satisfies the settle test, so it sticks - and reported far enough on,
    // the server marks the item watched and drops it out of Continue Watching.
    expect(reportedPosition({ positionMs: 10_000, seekTargetMs: 9_999_999_999, durationMs: 3_600_000 })).toBe(
      3_600_000,
    );
    expect(reportedPosition({ positionMs: 10_000, seekTargetMs: -5_000, durationMs: 3_600_000 })).toBe(0);
    expect(reportedPosition({ positionMs: -1, seekTargetMs: null, durationMs: 3_600_000 })).toBe(0);
  });

  it("still reports when the item never said how long it is", () => {
    // Nothing to clamp against, and refusing to report would lose the resume
    // point this exists to keep. Live TV and a direct file both arrive this way.
    expect(reportedPosition({ positionMs: 90_000, seekTargetMs: null, durationMs: 0 })).toBe(90_000);
    expect(reportedPosition({ positionMs: 90_000, seekTargetMs: 120_000, durationMs: 0 })).toBe(120_000);
    expect(reportedPosition({ positionMs: Number.NaN, seekTargetMs: null, durationMs: 0 })).toBe(0);
  });
});
