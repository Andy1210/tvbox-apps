import { describe, it, expect } from "vitest";
import { act, render } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { setupRemote, flushFocus, getCurrentFocusKey, remote } from "../../_shared/test/remote";
import { TrackMenu } from "../TrackMenu";
import en from "../locales/en.json";
import hu from "../locales/hu.json";

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const at = (sel: number): TvboxTrack[] => [
  { type: "audio", id: 1, lang: "hu", title: "A", selected: sel === 1 },
  { type: "audio", id: 2, lang: "en", title: "B", selected: sel === 2 },
];

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 5));
  });
  await flushFocus();
}

describe("TrackMenu initial focus", () => {
  it("follows the fresh list that lands after the menu opens", async () => {
    const { rerender, unmount } = render(<TrackMenu tracks={at(1)} onClose={() => {}} />);
    await settle();
    expect(getCurrentFocusKey()).toBe("track-audio-1");
    rerender(<TrackMenu tracks={at(2)} onClose={() => {}} />);
    await settle();
    expect(getCurrentFocusKey()).toBe("track-audio-2");
    unmount();
  });

  it("leaves the cursor alone once a key was pressed", async () => {
    const { rerender, unmount } = render(<TrackMenu tracks={at(1)} onClose={() => {}} />);
    await settle();
    await remote.down();
    expect(getCurrentFocusKey()).toBe("track-audio-2");
    // A re-read that still says track 1 is selected must not pull the cursor back.
    rerender(<TrackMenu tracks={at(1)} onClose={() => {}} />);
    await settle();
    expect(getCurrentFocusKey()).toBe("track-audio-2");
    unmount();
  });
});
