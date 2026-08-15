import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { backendFor } from "../backends/factory";
import { normaliseAddress } from "../backends/jellyfin/address";
import { setupRemote, setFocus, remote, getCurrentFocusKey } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { Session } from "../backends/types";

// Which server a box is signed into, and how it gets asked.
//
// Two things are being defended here. A session written before there WAS a
// second backend carries no `kind`, and reading that as "unknown" would sign the
// household out of a Plex server that is working perfectly - so it reads as
// Plex, which is what it is.
//
// And a Jellyfin server has no account service to be found through: its address
// is the one thing on this screen that needs the keyboard, typed the way it is
// read off a router.

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

const store = new Map<string, string>();
vi.mock("../storage", () => ({
  readJson: async (key: string) => {
    const raw = store.get(key);
    return raw === undefined ? null : JSON.parse(raw);
  },
  writeJson: async (key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
    return { ok: true };
  },
  readRaw: async (key: string) => store.get(key) ?? null,
  removeRaw: async (key: string) => {
    store.delete(key);
    return { ok: true };
  },
}));

const identity = { clientId: "cid-1", host: "tvbox-livingroom", fresh: false };

function session(over: Partial<Session> = {}): Session {
  return {
    profileId: "p1",
    profileName: "Andy",
    token: "t",
    accountToken: "t",
    serverId: "s",
    serverName: "server",
    baseUrl: "http://192.168.1.19:8096",
    location: "lan",
    ...over,
  };
}

beforeEach(() => {
  store.clear();
  (globalThis as unknown as { tvbox: unknown }).tvbox = { panel: { width: 1920, height: 1080 } };
});

describe("the backend a session names", () => {
  it("reads a session with no kind as Plex, because that is what it is", () => {
    expect(backendFor(session(), identity).kind).toBe("plex");
  });

  it("opens a Jellyfin session with the Jellyfin backend", () => {
    expect(backendFor(session({ kind: "jellyfin" }), identity).kind).toBe("jellyfin");
  });

  it("gives Jellyfin a device id that survives a restart", async () => {
    // Jellyfin ties a session and its remembered state to the device id, so a
    // value minted per run would leave a trail of dead sessions on the server.
    //
    // Read off the WIRE, because the id is not otherwise observable - and the
    // first version of this test compared two `kind` literals, which is a
    // sentence that cannot fail.
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));
      return new Response(JSON.stringify({ Items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await backendFor(session({ kind: "jellyfin" }), identity).libraries();
    await backendFor(session({ kind: "jellyfin" }), identity).libraries();
    vi.unstubAllGlobals();

    expect(seen).toHaveLength(2);
    const id = (h: string): string => /DeviceId="([^"]*)"/.exec(h)?.[1] ?? "";
    expect(id(seen[0])).toBe(identity.clientId);
    expect(id(seen[1])).toBe(id(seen[0]));
  });
});

describe("choosing a server on the sign-in screen", () => {
  it("asks which one when nothing is remembered, and remembers the answer", async () => {
    const { Login } = await import("../Login");
    const { container } = render(<Login />);
    await waitFor(() => expect(container.textContent).toContain("Jellyfin"));

    await setFocus("login-jellyfin");
    await act(async () => {
      await remote.ok();
    });

    await waitFor(() => expect(store.get("server")).toBeTruthy());
    expect(JSON.parse(store.get("server")!).kind).toBe("jellyfin");
  });

  it("opens the keyboard for the address, because there is no account to find one through", async () => {
    const { Login } = await import("../Login");
    const { container } = render(<Login />);
    await waitFor(() => expect(container.textContent).toContain("Jellyfin"));
    await setFocus("login-jellyfin");
    await act(async () => {
      await remote.ok();
    });

    await waitFor(() => expect(container.textContent).toContain(en.login.address));
  });
});

describe("an address as somebody types it", () => {
  it("takes what is read off a router and makes it fetchable", () => {
    expect(normaliseAddress("192.168.1.19:8096")).toBe("http://192.168.1.19:8096");
    expect(normaliseAddress("  192.168.1.19:8096/  ")).toBe("http://192.168.1.19:8096");
    // A space is the easiest thing to leave in with a keyboard driven by a
    // D-pad, and it is invisible in the field.
    expect(normaliseAddress("192.168.1.19 :8096")).toBe("http://192.168.1.19:8096");
  });

  it("leaves a scheme somebody wrote alone", () => {
    expect(normaliseAddress("https://jellyfin.example.com")).toBe("https://jellyfin.example.com");
    expect(normaliseAddress("http://box.local:8096/")).toBe("http://box.local:8096");
  });

  it("keeps a path, because a server behind a proxy lives under one", () => {
    expect(normaliseAddress("example.com/jellyfin")).toBe("http://example.com/jellyfin");
  });

  it("answers with nothing for what is not an address at all", () => {
    expect(normaliseAddress("")).toBe("");
    expect(normaliseAddress("   ")).toBe("");
    expect(normaliseAddress("http://")).toBe("");
  });
});

describe("changing the server after a sign-out", () => {
  /** A Jellyfin server that answers everything the code screen asks for. */
  function stubServer(): void {
    vi.stubGlobal("fetch", async (url: string) => {
      const u = String(url);
      const body = u.includes("/QuickConnect/Enabled")
        ? "true"
        : u.includes("/QuickConnect/Initiate")
          ? JSON.stringify({ Authenticated: false, Secret: "s", Code: "123456" })
          : u.includes("/QuickConnect/Connect")
            ? JSON.stringify({ Authenticated: false, Secret: "s", Code: "123456" })
            : JSON.stringify({ ServerName: "Lucy", Version: "10.11.11", Id: "srv" });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    });
  }

  it("can be reached while the code is on screen, not only after it fails", async () => {
    // Signing out leaves the remembered server in place - which is right, a box
    // signs back into the same server nearly every time. But the way BACK was
    // only on the failure screen, so after a sign-out the code screen was a dead
    // end until the code expired: no way to pick the other server at all.
    store.set("server", JSON.stringify({ kind: "jellyfin", baseUrl: "http://192.168.1.19:8096" }));
    stubServer();

    const { Login } = await import("../Login");
    const { container } = render(<Login />);
    await waitFor(() => expect(container.textContent).toContain("123456"));

    // NOT setFocus("login-other") - that would hand the test the very thing it
    // is checking. The code screen has to point the remote at the way back by
    // itself, because it is the only thing on that screen a press can reach.
    await waitFor(() => expect(getCurrentFocusKey()).toBe("login-other"));
    await act(async () => {
      await remote.ok();
    });

    await waitFor(() => expect(container.textContent).toContain(en.login.chooseServer));

    // And the chooser has to be POINTED AT, not merely drawn. Spatial
    // navigation never focuses anything by itself, so a screen nothing has
    // focus on discards every press - the remote is dead and nothing errors.
    await waitFor(() => expect(getCurrentFocusKey()).toBe("login-plex"));
    await act(async () => {
      await remote.ok();
    });
    await waitFor(() => expect(JSON.parse(store.get("server")!).kind).toBe("plex"));
    vi.unstubAllGlobals();
  });
});

describe("the remote control protocol", () => {
  /** Every URL the app asks for while it is up. */
  function watchFetch(): string[] {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(String(url));
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    return seen;
  }

  async function runWith(kind: Session["kind"]): Promise<string[]> {
    const seen = watchFetch();
    const { MediaClient } = await import("../MediaClient");
    const { useApp } = await import("../state");
    const { render, act } = await import("@testing-library/react");
    useApp.setState({ session: session({ kind }), identity, screen: { name: "home" }, history: [], failure: null });
    render(<MediaClient onExit={() => {}} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    vi.unstubAllGlobals();
    return seen;
  }

  it("is not started against a Jellyfin server", async () => {
    // `player/proxy/poll` is a Plex route, and this loop reads a 401 as "signed
    // out" - so pointed at a Jellyfin server it polls a path that does not
    // exist forever, and the day that server answers 401 instead of 404 it
    // signs the household out of it.
    const seen = await runWith("jellyfin");
    expect(seen.some((u) => u.includes("/player/proxy/poll"))).toBe(false);
  });

  it("is started for a session written before there was a second backend", async () => {
    // No `kind` means Plex, and Plex is what this protocol is.
    const seen = await runWith(undefined);
    expect(seen.some((u) => u.includes("/player/proxy/poll"))).toBe(true);
  });
});
