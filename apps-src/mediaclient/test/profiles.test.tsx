import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Profiles } from "../Profiles";
import { useApp } from "../state";
import { PlexBackend } from "../backends/plex/backend";
import { setupRemote, remote, setFocus, getCurrentFocusKey, flushFocus } from "./remote";
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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  await flushFocus();
}

describe("the who-is-watching screen", () => {
  it("answers the remote again after backing out of the PIN pad", async () => {
    render(<Profiles />);
    await waitFor(() => expect(screen.getByText("Anna")).toBeInTheDocument());
    await settle();
    expect(getCurrentFocusKey()).toBe("profile-u1");

    // Open a face, then think better of it.
    await remote.ok();
    await settle();
    expect(getCurrentFocusKey()).toBe("pin-1");

    await remote.back();
    await settle();

    // The pad's focusable is gone. Norigin's own recovery walks up to the root
    // and stops there, so without a fallback the cursor stays on a key that no
    // longer exists and every press after this is discarded.
    const landed = getCurrentFocusKey();
    expect(landed).toBeDefined();
    expect(landed?.startsWith("profile-")).toBe(true);

    await remote.right();
    expect(getCurrentFocusKey()).toBe("profile-u2");
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
    await settle();

    // Something is focused, so the screen answers the remote at all - that is
    // the half that was missing, since an unreachable failure produced no
    // buttons and Back from here quits the app.
    expect(getCurrentFocusKey()).toBeTruthy();

    await act(async () => setFocus("msg-continue"));
    await remote.ok();
    expect(useApp.getState().screen.name).toBe("home");
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
