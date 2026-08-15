import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { startCompanion, type CompanionCommand } from "../backends/plex/companion";

/**
 * Being a player something else can drive.
 *
 * The whole contract here was measured against the live server, because every
 * part of it fails silently: the server answers a poll it does not like with a
 * bare 400 and names the missing piece only in its OWN log, and a client that
 * retries forever looks exactly like a box nobody has chosen.
 */

const ID = { clientId: "cid-1", deviceName: "tvbox-livingroom" };

let calls: { url: string; init?: RequestInit }[] = [];

function xml(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "application/xml" } });
}

/**
 * A poll the server holds open, as the real one is.
 *
 * It has to honour the abort signal: the loop is stopped by aborting the
 * in-flight poll, and a stub that ignores that leaves the loop awaiting a
 * promise that never settles - which hangs the worker rather than failing.
 */
function held(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    signal.addEventListener("abort", () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      reject(e);
    });
  });
}

beforeEach(() => {
  calls = [];
  (globalThis as { document?: unknown }).document = globalThis.document;
});

afterEach(() => vi.unstubAllGlobals());

describe("the companion poll", () => {
  it("carries what the server refuses to work without", async () => {
    // Measured: without X-Plex-Platform-Version, or without deviceClass, or
    // without protocolCapabilities, the answer is 400 and the reason is only in
    // the server's log. `X-Plex-Provides` is what makes this a player at all.
    let polls = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      polls += 1;
      return polls > 1 ? held(init) : xml('<MediaContainer size="0" />');
    });
    const stop = startCompanion({
      baseUrl: "http://s:32400",
      token: "t",
      id: ID,
      onCommand: () => ({ ok: true as const }),
    });
    await new Promise((r) => setTimeout(r, 10));
    stop();

    const first = calls[0];
    expect(first, "it polls at once rather than on a timer").toBeTruthy();
    const u = new URL(first.url);
    expect(u.pathname).toBe("/player/proxy/poll");
    expect(u.searchParams.get("deviceClass")).toBeTruthy();
    expect(u.searchParams.get("protocolCapabilities")).toContain("playback");
    expect(u.searchParams.get("commandID")).toBe("0");

    const h = first.init!.headers as Record<string, string>;
    expect(h["X-Plex-Provides"]).toBe("player");
    expect(h["X-Plex-Platform-Version"], "the header the 400 is about").toBeTruthy();
    expect(h["X-Plex-Client-Identifier"]).toBe("cid-1");
  });

  it("runs a command and answers it", async () => {
    // The answer is not bookkeeping: it is what releases the controller. Without
    // it the phone's press - or the assistant's playMedia - hangs until its own
    // timeout, which reads as the box having ignored a command it has already
    // carried out.
    const seen: CompanionCommand[] = [];
    let polls = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/proxy/poll")) {
        polls += 1;
        if (polls > 1) return held(init); // the long poll, held open
        return xml(
          '<MediaContainer size="1"><Command path="/player/playback/pause" queryType="video" commandID="7" /></MediaContainer>',
        );
      }
      return xml("");
    });

    const stop = startCompanion({
      baseUrl: "http://s:32400",
      token: "t",
      id: ID,
      onCommand: (c) => {
        seen.push(c);
        return { ok: true as const };
      },
    });
    // Past the floor the loop keeps between polls, so the SECOND one has gone
    // out - that is where the acknowledged command id is visible.
    await new Promise((r) => setTimeout(r, 400));
    stop();

    expect(seen.map((c) => c.path)).toEqual(["/player/playback/pause"]);
    const answer = calls.find((c) => c.url.includes("/proxy/response"));
    expect(answer, "the controller must be released").toBeTruthy();
    expect(new URL(answer!.url).searchParams.get("commandID")).toBe("7");
    expect(answer!.init!.method).toBe("POST");

    // The next poll carries the number, but only as bookkeeping: measured, the
    // server DISCARDS the poll's commandID, keeps its own per-controller
    // sequence and never resends an unacknowledged command. So this asserts
    // what the client does, not a property of the server - the earlier comment
    // here claimed the server would resend, and it does not.
    const second = calls.filter((c) => c.url.includes("/proxy/poll"))[1];
    expect(new URL(second.url).searchParams.get("commandID")).toBe("7");
  });

  it("answers a command that threw, rather than leaving the controller hanging", async () => {
    let polls = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/proxy/poll")) {
        polls += 1;
        if (polls > 1) return held(init);
        return xml('<MediaContainer size="1"><Command path="/player/playback/stop" commandID="3" /></MediaContainer>');
      }
      return xml("");
    });

    const stop = startCompanion({
      baseUrl: "http://s:32400",
      token: "t",
      id: ID,
      onCommand: () => {
        throw new Error("player is not ready");
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    stop();

    expect(
      calls.some((c) => c.url.includes("/proxy/response")),
      "a failure is still an answer",
    ).toBe(true);
  });

  it("stops polling when it is told to", async () => {
    // It is started from an effect and torn down with the session. A loop that
    // outlived sign-out would keep answering for an account that has left.
    let polls = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      polls += 1;
      return polls > 1 ? held(init) : xml('<MediaContainer size="0" />');
    });
    const stop = startCompanion({
      baseUrl: "http://s:32400",
      token: "t",
      id: ID,
      onCommand: () => ({ ok: true as const }),
    });
    await new Promise((r) => setTimeout(r, 10));
    stop();
    const after = calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length, "no poll after the stop").toBe(after);
  });
});
