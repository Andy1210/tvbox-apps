// A session is ended with the key its start handed back, by fetch and by beacon.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("stopping a session", () => {
  it("sends the start's key with the fetch and with the beacon", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        const body = url.endsWith("/session/start")
          ? { ok: true, id: "S", type: "cloud", stopKey: "k".repeat(32) }
          : { ok: true };
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const beacons: Array<{ url: string; data: Blob }> = [];
    vi.stubGlobal("navigator", {
      sendBeacon: (url: string, data: Blob) => {
        beacons.push({ url, data });
        return true;
      },
    });
    const api = await import("../api");
    await api.startSession("GAME", 1920, 1080, "en-US");
    await api.stopSession();
    expect(JSON.parse(bodies[1])).toEqual({ key: "k".repeat(32) });
    api.beaconStop();
    expect(beacons[0].url).toBe("/tvbox/api/xcloud/session/stop");
    expect(JSON.parse(await beacons[0].data.text())).toEqual({ key: "k".repeat(32) });
  });
});
