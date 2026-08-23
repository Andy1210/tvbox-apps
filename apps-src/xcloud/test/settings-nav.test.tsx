import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { configureI18n, initSpatialNavigation } from "@sdk";
import { getCurrentFocusKey, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { Settings, SETTINGS_ROWS } from "../Settings";
import * as api from "../api";
import hu from "../locales/hu.json";
import en from "../locales/en.json";

// Up and Down in the settings panel move row by row, because geometry does not:
// the rows hold 5, 3, 2 and 5 chips and nothing lines them up, so norigin picked
// the nearest below by distance and regularly skipped a whole setting. Measured
// before this: Down from the 5th quality chip landed in "Game language", past
// Resolution and Sound.
const VALUES: api.SettingsValues = { maxVideoKbps: 0, maxHeight: 0, stereo: true, gameLocale: "" };

// Dispatched at the focused ELEMENT, not at `window`, because that is where a real
// key event starts and the phases are what this depends on: norigin listens on
// window in the BUBBLE phase, the panel's own handler in CAPTURE, so on a real
// event the panel runs first and stops norigin from moving by geometry. Dispatched
// at window they are both "at target" and run in registration order, which is the
// opposite - a test artefact that would have proved nothing.
//
// And awaited, because norigin's `setFocus` is scheduled rather than synchronous.
async function press(key: string, lands: string) {
  await act(async () => {
    const target: EventTarget =
      document.querySelector("[data-sfocus].focused") || document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  // WAITED for, not assumed: norigin's `setFocus` is scheduled, so how many
  // microtasks it takes depends on what else the runner is doing - which is why
  // this passed alone and failed inside the full suite.
  await waitFor(() => expect(getCurrentFocusKey()).toBe(lands));
}

// The same wait, for the focus a test SETS itself.
async function focus(key: string) {
  await act(async () => {
    setFocus(key);
  });
  await waitFor(() => expect(getCurrentFocusKey()).toBe(key));
}

beforeEach(() => {
  configureI18n({ hu, en }, { fallback: "en" });
  initSpatialNavigation({ debug: false, visualDebug: false });
  vi.spyOn(api, "getSettings").mockResolvedValue({ settings: VALUES, allowed: {} });
});
afterEach(() => vi.restoreAllMocks());

async function openPanel() {
  render(<Settings status={null} onClose={() => {}} onSignedOut={() => {}} onRefreshed={() => {}} />);
  await waitFor(() => expect(screen.getByText("Automatic")).toBeInTheDocument());
  await focus("set-quality-0");
}

describe("the settings panel walks its rows", () => {
  it("renders exactly the focus keys the row table names", async () => {
    // The table is hand-written beside the markup, so it can drift from it - and a
    // key that is in one and not the other is a row the D-pad silently cannot
    // reach, or a jump to something that is not there.
    await openPanel();
    const rendered = [...document.querySelectorAll("[data-sfocus]")].map((el) => el.getAttribute("data-sfocus"));
    expect([...rendered].sort()).toEqual([...SETTINGS_ROWS.flat()].sort());
  });

  it("Down from the END of a long row reaches the NEXT row, not the one after", async () => {
    await openPanel();
    await focus("set-quality-4");
    // Clamped to the shorter row rather than skipping it.
    await press("ArrowDown", "set-height-2");
    await press("ArrowDown", "set-sound-1");
    await press("ArrowDown", "set-lang-1");
    // Column 1 of the button row. The column is carried, not reset.
    await press("ArrowDown", "set-signout");
  });

  it("Up walks back the same way, and the ends stay put", async () => {
    await openPanel();
    await press("ArrowUp", "set-quality-0"); // the top does not wrap
    await focus("set-close");
    await press("ArrowUp", "set-lang-2");
    await press("ArrowDown", "set-close");
    await press("ArrowDown", "set-close"); // the bottom does not wrap either
  });

  it("leaves a key that is not one of the panel's own alone", async () => {
    // The notice screens - settings still loading, or the read failed - render one
    // button of their own, which is in no row. The handler is on `window`, so it
    // sees those presses too and must not act on them.
    vi.spyOn(api, "getSettings").mockRejectedValue(Object.assign(new Error("nope"), { code: "gssv_failed" }));
    render(<Settings status={null} onClose={() => {}} onSignedOut={() => {}} onRefreshed={() => {}} />);
    await waitFor(() => expect(screen.getByText("Done")).toBeInTheDocument());
    await focus("set-notice-close");
    await press("ArrowDown", "set-notice-close");
  });
});
