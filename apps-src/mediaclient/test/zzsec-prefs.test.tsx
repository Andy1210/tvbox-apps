import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlexBackend } from "../backends/plex/backend";
import type { Session } from "../backends/types";
import { usePrefs, applySubtitleStyle, DEFAULTS } from "../prefs";
import { LibraryFilters } from "../LibraryFilters";
import { useApp } from "../state";

const TOKEN = "s3cr3t-account-token";
const session: Session = {
  profileId: "p",
  profileName: "p",
  token: TOKEN,
  accountToken: TOKEN,
  serverId: "s",
  serverName: "s",
  baseUrl: "http://192.168.1.10:32400",
  location: "lan",
};
const backend = (): PlexBackend => new PlexBackend(session, { clientId: "c", deviceName: "d" });

// The shell's real allowlist, required straight out of the shell repo so this
// probe cannot drift from what actually runs.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const playeropts = require("/home/andy1210/assistant-stack/tvbox/shell/playeropts.js") as {
  propValue(name: string, value: unknown): unknown;
};

describe("PROBE: prefs round trip", () => {
  beforeEach(() => {
    usePrefs.setState({ ...DEFAULTS });
  });

  it("a tampered stored blob is loaded with no validation", async () => {
    const store = new Map<string, string>([
      [
        "prefs",
        JSON.stringify({
          subScale: 1e9,
          subPos: -5,
          subColor: "#zzzzzz'; drop",
          autoSkip: "yes-please",
          extra: { nested: true },
        }),
      ],
    ]);
    const sent: { name: string; value: unknown }[] = [];
    vi.stubGlobal("window", {
      ...globalThis.window,
      tvbox: {
        storage: {
          get: async (k: string) => store.get(k) ?? null,
          set: async () => ({ ok: true }),
          remove: async () => ({ ok: true }),
        },
        setPlayerProp: (name: string, value: unknown) => {
          sent.push({ name, value });
          return Promise.resolve({ ok: true });
        },
      },
    });

    await usePrefs.getState().load();
    const s = usePrefs.getState();
    console.log("loaded prefs ->", JSON.stringify({ subScale: s.subScale, subPos: s.subPos, subColor: s.subColor, autoSkip: s.autoSkip }));

    applySubtitleStyle();
    console.log("sent to setPlayerProp ->", JSON.stringify(sent));
    for (const { name, value } of sent) {
      console.log(`  shell propValue(${name}) ->`, playeropts.propValue(name, value));
    }

    // autoSkip is a string, which is truthy: the effect that acts on it does not
    // check the type.
    console.log("autoSkip truthy? ->", Boolean(s.autoSkip), "typeof", typeof s.autoSkip);
  });

  it("Settings' cycle recovers from an out-of-list value", () => {
    // steps.findIndex returns -1 for an unknown value; (-1 + 1) % n === 0.
    const steps = [0.8, 1, 1.25, 1.5, 2];
    expect(steps[(steps.findIndex((v) => v === 1e9) + 1) % steps.length]).toBe(0.8);
  });
});

describe("PROBE: server strings rendered as labels", () => {
  it("markup in a filter title is escaped, not injected", async () => {
    const evil = '<img src=x onerror="globalThis.__pwned=1">';
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const s = String(url);
        const body = s.includes("/sorts")
          ? { MediaContainer: { Directory: [{ key: "titleSort", title: evil }] } }
          : { MediaContainer: { Directory: [{ filter: "genre", title: evil, filterType: "string" }] } };
        return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
      }),
    );
    useApp.setState({ backend: backend() });

    render(
      <LibraryFilters
        libraryId="1"
        view={{ sort: "titleSort", desc: false, filters: {}, labels: {} }}
        onApply={() => {}}
        onClose={() => {}}
      />,
    );
    await screen.findAllByText(evil);
    console.log("__pwned ->", (globalThis as Record<string, unknown>).__pwned);
    console.log("img tags in DOM ->", document.querySelectorAll("img").length);
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });
});

describe("PROBE: letterOffset int32 overflow", () => {
  it("finds the totalSize at which the binary search stops terminating", async () => {
    for (const total of [1_000_000, 1_000_000_000, 1_500_000_000, 2_000_000_000]) {
      let n = 0;
      let blew = false;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          n += 1;
          if (n > 200) {
            blew = true;
            throw new Error("runaway");
          }
          const s = String(url);
          const body = s.includes("firstCharacter")
            ? {
                MediaContainer: {
                  Directory: [
                    { key: "A", title: "A", size: 1 },
                    { key: "Z", title: "Z", size: 1 },
                  ],
                },
              }
            : { MediaContainer: { Metadata: [{ ratingKey: "1", title: "A", type: "movie" }], totalSize: total } };
          return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
        }),
      );
      await backend()
        .letterOffset("1", "Z", {})
        .catch(() => {});
      console.log(`totalSize=${total} -> requests=${n} runaway=${blew}`);
    }
  });
});

describe("PROBE: setWatched", () => {
  it("what a scrobble request looks like", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
      }),
    );
    await backend().setWatched("../../evil?x=1", true);
    await backend().setWatched("123", false);
    console.log("setWatched urls ->", JSON.stringify(calls, null, 1));
  });
});
