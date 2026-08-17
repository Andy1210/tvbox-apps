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
  it("does not read an answer bigger than it will parse", async () => {
    // The cap used to be a slice on an already-read body, which bounds parsing
    // and nothing else: measured against a probe server, an 8 MB answer
    // materialised in full behind a 64 KB limit. This app signs into servers it
    // does not own and talks to them over plain HTTP, so the size of an answer
    // is not something to assume.
    let read = 0;
    const huge = "<MediaContainer>" + "<!--" + "x".repeat(200_000) + "-->" + "</MediaContainer>";
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (!String(url).includes("/proxy/poll")) return xml("");
      if (calls.filter((c) => c.url.includes("/proxy/poll")).length > 1) return held(init);
      // A body delivered in chunks, counting what the client actually pulls.
      // `pull`, not `start`: a stream that enqueues everything up front counts
      // what the SERVER sent, and the whole question is what the client asked
      // for.
      let sent = 0;
      const chunk = new TextEncoder().encode(huge.slice(0, 40_000));
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 12) return controller.close();
          sent += 1;
          read += chunk.byteLength;
          controller.enqueue(chunk);
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "application/xml" } });
    });

    const stop = startCompanion({ baseUrl: "http://s:32400", token: "t", id: ID, onCommand: () => ({ ok: true }) });
    await new Promise((r) => setTimeout(r, 400));
    stop();

    // Under the 64 KB cap plus one chunk: it stops pulling, rather than pulling
    // 480 KB and then slicing.
    expect(read).toBeLessThan(64 * 1024 + 2 * 40_000);
  });

  it("keeps a refusal from carrying anything private to the controller", async () => {
    // The server hands this answer to the controller byte for byte - verified
    // against the live one - and the reason is an error message from anywhere
    // in the command path. It is the only string this app sends to a third
    // party that the redactor never saw.
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/proxy/poll")) {
        if (calls.filter((c) => c.url.includes("/proxy/poll")).length > 1) return held(init);
        return xml('<MediaContainer size="1"><Command path="/player/playback/pause" commandID="3" /></MediaContainer>');
      }
      return xml("");
    });

    const stop = startCompanion({
      baseUrl: "http://s:32400",
      token: "t",
      id: ID,
      onCommand: () => ({ ok: false as const, reason: "failed at http://s:32400/x?X-Plex-Token=SECRET-abc123" }),
    });
    await new Promise((r) => setTimeout(r, 400));
    stop();

    const answer = calls.find((c) => c.url.includes("/proxy/response"));
    expect(answer).toBeTruthy();
    expect(String(answer!.init!.body)).not.toContain("SECRET-abc123");
  });

  it("sends no answer once it has been stopped", async () => {
    // `stop()` aborts what is in flight, but a response created AFTER it was
    // never in that set - so an acknowledgement went out under the old token
    // however long the command had taken. There is nothing left to release
    // either: the loop is gone.
    let release: () => void = () => {};
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/proxy/poll")) {
        if (calls.filter((c) => c.url.includes("/proxy/poll")).length > 1) return held(init);
        return xml('<MediaContainer size="1"><Command path="/player/playback/pause" commandID="5" /></MediaContainer>');
      }
      return xml("");
    });

    const stop = startCompanion({
      baseUrl: "http://s:32400",
      token: "t",
      id: ID,
      // A command still running when the person signs out.
      onCommand: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true as const });
        }),
    });
    await new Promise((r) => setTimeout(r, 100));
    stop();
    release();
    await new Promise((r) => setTimeout(r, 100));

    expect(calls.some((c) => c.url.includes("/proxy/response"))).toBe(false);
  });
  it("does not put a control character inside the answer's XML", async () => {
    // Measured against the live server: it forwards the attribute verbatim, and
    // a NUL cannot be represented in XML 1.0 at all - not even as a character
    // reference - so the controller is handed a document nothing on the other
    // end has to accept.
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/proxy/poll")) {
        if (calls.filter((c) => c.url.includes("/proxy/poll")).length > 1) return held(init);
        return xml('<MediaContainer size="1"><Command path="/player/playback/pause" commandID="9" /></MediaContainer>');
      }
      return xml("");
    });

    const stop = startCompanion({
      baseUrl: "http://s:32400",
      token: "t",
      id: ID,
      onCommand: () => ({ ok: false as const, reason: "before\u0000\u0008\u001b after" }),
    });
    await new Promise((r) => setTimeout(r, 400));
    stop();

    const answer = calls.find((c) => c.url.includes("/proxy/response"));
    expect(answer).toBeTruthy();
    const body = String(answer!.init!.body);
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body), "no C0 control in the answer").toBe(false);
    expect(body).toContain("before");
    expect(body).toContain("after");
  });

  it("registers as a player the server proxies, and stops being one on the way out", async () => {
    // Polling is enough to BE commandable and not enough to be OFFERED.
    // Measured on the live account: with the app polling, PMS lists the box in
    // /clients, announces it over GDM, and plex.tv shows provides="player" - and
    // no phone offers it. The old Plex HTPC client, which IS castable, differs
    // in one field: provides="client,player". Its own code says why, and this is
    // the call it makes.
    const calls: { url: string; method: string; provides: string | null }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/devices/")) {
        const headers = new Headers(init?.headers);
        calls.push({ url, method, provides: headers.get("X-Plex-Provides") });
        return new Response("", { status: 200 });
      }
      // The poll: hang, so the loop does not spin while this test looks.
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const stop = startCompanion({
      baseUrl: "http://server",
      token: "tok",
      serverId: "MACHINE-ID",
      id: { clientId: "CLIENT-ID", deviceName: "tvbox-test" },
      onCommand: () => ({ ok: true }),
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.length, "it registers on start").toBe(1);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain("/devices/CLIENT-ID");
    // The whole point of the call: a phone may cast to a "player", not to a
    // bare "client".
    expect(calls[0].provides).toBe("client,player");
    // And it names the server that will relay to it.
    expect(calls[0].url).toContain("proxiedBy=MACHINE-ID");

    stop();
    await Promise.resolve();

    expect(calls.length, "and it stands down on the way out").toBe(2);
    expect(calls[1].provides, "no longer a player").toBe("client");
  });

  it("does not register when there is no server to be proxied by", async () => {
    // Without a machine identifier the registration would name nobody, and a
    // player nothing relays to is worse than one that was never offered.
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/devices/")) calls.push(url);
        return new Promise<Response>(() => {});
      }),
    );

    const stop = startCompanion({
      baseUrl: "http://server",
      token: "tok",
      id: { clientId: "CLIENT-ID", deviceName: "tvbox-test" },
      onCommand: () => ({ ok: true }),
    });
    await Promise.resolve();
    await Promise.resolve();
    stop();

    expect(calls).toEqual([]);
  });
});
