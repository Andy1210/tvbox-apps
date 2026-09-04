import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Profiles } from "../Profiles";
import { useApp } from "../state";
import { PlexBackend } from "../backends/plex/backend";
import {
  setupRemote,
  remote,
  setFocus,
  getCurrentFocusKey,
  flushFocus,
  place,
  focusBecomes,
  focusLands,
} from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { MediaBackend, Profile, Session } from "../backends/types";

// Who is watching, and the two ways this screen used to become a dead end.
//
// Both are focus problems rather than logic problems, so they cannot be seen by
// reading the component: the screen renders correctly and simply stops answering
// the remote. A household that hits either has to relaunch the app.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const people: Profile[] = [
  { id: "u1", name: "Anna", pinRequired: true },
  { id: "u2", name: "Bence", pinRequired: true },
];

function stubBackend(over: Partial<MediaBackend> = {}): MediaBackend {
  return {
    kind: "plex",
    listProfiles: async () => people,
    posterUrl: () => undefined,
    imageHeaders: () => ({}),
    ...over,
  } as unknown as MediaBackend;
}

beforeEach(async () => {
  useApp.setState({ backend: stubBackend(), screen: { name: "profiles" }, history: [], failure: null });
  await act(async () => setFocus(""));
});

async function settle2(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await flushFocus();
}

/**
 * Where the two faces are, side by side.
 *
 * Without this the whole screen measures 0x0 at the origin, so a sideways press
 * is decided by registration order rather than by position - deterministic, but
 * proving nothing about where anything is. Measured: with the rectangles taken
 * away the test still passes, and with the two positions swapped it fails,
 * which is the pair that says the assertion now rests on the layout.
 *
 * This is not what broke CI. That was a focus that had not landed yet, and it
 * is fixed by waiting rather than by geometry.
 */
function layOut(): void {
  const at = (key: string, x: number): void => {
    const node = document.querySelector(`[data-sfocus="${key}"]`);
    expect(node, `no element to place for ${key}`).toBeTruthy();
    place(node!, x, 400, 200, 220);
  };
  at("profile-u1", 200);
  at("profile-u2", 600);
}

describe("the who-is-watching screen", () => {
  it("answers the remote again after backing out of the PIN pad", async () => {
    render(<Profiles />);
    await waitFor(() => expect(screen.getByText("Anna")).toBeInTheDocument());
    await focusBecomes("profile-u1");

    // The SECOND face, deliberately. The cancel path aims at the face that was
    // opened while `useFocusFallback` aims at the first one, so opening the
    // first proves nothing about which of the two answered - a mutation that
    // sends the cancel to `profiles[0]` passes if this test opens Anna.
    await act(async () => setFocus("profile-u2"));

    // Open a face, then think better of it.
    await remote.ok();
    await focusBecomes("pin-1");

    await remote.back();

    // The pad's focusable is gone. Norigin's own recovery walks up to the root
    // and stops there, so without a fallback the cursor stays on a key that no
    // longer exists and every press after this is discarded.
    //
    // The face that was OPENED, not merely some face: `startsWith("profile-")`
    // accepted the recovery landing on the wrong one, which is a real failure
    // this test used to tolerate.
    await focusBecomes("profile-u2");

    // Placed here rather than at the start: the faces are remounted when the
    // PIN pad closes, and a rectangle belongs to a node rather than to a key.
    layOut();
    await remote.left();
    expect(getCurrentFocusKey()).toBe("profile-u1");
  });

  it("offers a way on when the household list cannot be fetched", async () => {
    // The list comes from plex.tv while everything else is asked of the server
    // on the LAN, so this is the box that is online locally but off the
    // internet. Stranding it here makes a working library unreachable.
    useApp.setState({
      backend: stubBackend({
        listProfiles: async () => {
          throw Object.assign(new Error("offline"), { status: 0 });
        },
      }),
    });
    render(<Profiles />);
    await waitFor(() => expect(screen.getByText(en.profiles.continue)).toBeInTheDocument());

    // Something is focused, so the screen answers the remote at all - that is
    // the half that was missing, since an unreachable failure produced no
    // buttons and Back from here quits the app.
    await focusLands();

    await act(async () => setFocus("msg-continue"));
    await remote.ok();
    expect(useApp.getState().screen.name).toBe("home");
  });
});

describe("a check that is still running when the pad is closed", () => {
  it("cannot write its answer onto the attempt that replaced it", async () => {
    // Back is deliberately not gated on the in-flight check: the switch carries
    // no timeout, so gating it would trap someone behind a request that can take
    // minutes on a bad connection. An answer arriving after its own pad has gone
    // is therefore ordinary - and it must not land on whatever is on screen by
    // then, or the second attempt shows the first one's wrong-PIN error and
    // stops accepting digits before anything has been typed into it.
    const pending: (() => void)[] = [];
    useApp.setState({
      chooseProfile: () => new Promise<void>((_, reject) => pending.push(() => reject(new Error("401")))),
    } as never);

    render(<Profiles />);
    await waitFor(() => expect(screen.getByText("Anna")).toBeInTheDocument());
    // The press below only opens the pad once the cursor is on a face, and that
    // landing is scheduled rather than immediate.
    await focusBecomes("profile-u1");

    const typeAPin = async (): Promise<void> => {
      for (const d of ["pin-1", "pin-2", "pin-3", "pin-4"]) {
        await act(async () => setFocus(d));
        await remote.ok();
      }
      await settle2();
    };

    await remote.ok(); // open the pad
    await focusBecomes("pin-1");
    await typeAPin(); // attempt 1 is now in flight
    expect(pending.length).toBe(1);

    await remote.back(); // abandon it
    await focusBecomes("profile-u1");

    await remote.ok(); // open the pad again
    await focusBecomes("pin-1");
    await typeAPin(); // attempt 2 in flight
    expect(pending.length).toBe(2);

    // Attempt 1 finally answers. It belongs to a pad that no longer exists.
    await act(async () => {
      pending[0]();
      await new Promise((r) => setTimeout(r, 0));
    });

    // Nothing typed into attempt 2 has been rejected, so it must show no error
    // and must still be waiting on its own answer.
    expect(screen.queryByText(en.profiles.wrongPin)).toBeNull();

    // And attempt 2's own answer still lands.
    await act(async () => {
      pending[1]();
      await new Promise((r) => setTimeout(r, 0));
    });
    await waitFor(() => expect(screen.getByText(en.profiles.wrongPin)).toBeInTheDocument());
  });
});

describe("switching more than once", () => {
  it("keeps the account token when the stored session predates it", async () => {
    // The stored blob is cast, not validated: an older build wrote no
    // accountToken, and that one token WAS the account's. If the switch does not
    // name it, the new session's only token is the profile's - and the NEXT
    // switch tries to list the household with that, which plex.tv does not
    // answer. One change of user, ever.
    const seen: { url: string; token: string | null }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, token: headers.get("X-Plex-Token") });
      return new Response(JSON.stringify({ authToken: `PROFILE-${seen.length}` }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const legacy = {
      profileId: "old",
      profileName: "Previous Person",
      token: "ACCOUNT",
      serverId: "s",
      serverName: "s",
      baseUrl: "http://127.0.0.1:32400",
      location: "lan",
    } as Session;
    expect(legacy.accountToken).toBeUndefined();

    // What boot() does with a session it did not write.
    if (!legacy.accountToken) legacy.accountToken = legacy.token;

    const backend = new PlexBackend(legacy, { clientId: "c", deviceName: "d" });
    const after = await backend.switchProfile("u1");
    expect(after.token).toBe("PROFILE-1");
    expect(after.accountToken).toBe("ACCOUNT");

    // The second switch is the one that used to fail.
    await backend.switchProfile("u2");
    expect(seen.map((r) => r.token)).toEqual(["ACCOUNT", "ACCOUNT"]);
    vi.unstubAllGlobals();
  });
});
