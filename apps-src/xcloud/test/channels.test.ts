// The JSON handshake, asserted as a shape.
//
// Worth pinning because skipping it looks like everything working: the video
// plays, the channels open, input packets go out at 60 Hz - and the game ignores
// every one of them, because the server does not act on input for a pad it was
// never told about. Measured on the box: 3500 packets, button masks changing as
// buttons were pressed, and nothing moved.
import { describe, expect, it } from "vitest";
import {
  authorizationRequest,
  gamepadChanged,
  handshake,
  isHandshakeAck,
  keyframeRequest,
  sessionConfig,
  streamingMessage,
} from "../stream/channels";

const parse = (s: string) => JSON.parse(s);

describe("the handshake", () => {
  it("names the message protocol version the channel was opened with", () => {
    // The data channel is created with protocol "messageV1"; a handshake naming
    // anything else is refused silently.
    const h = parse(handshake());
    expect(h.type).toBe("Handshake");
    expect(h.version).toBe("messageV1");
    expect(h.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.cv).toBe("");
  });

  it("recognises only the acknowledgement", () => {
    expect(isHandshakeAck(JSON.stringify({ type: "HandshakeAck" }))).toBe(true);
    expect(isHandshakeAck(JSON.stringify({ type: "Message" }))).toBe(false);
    // Anything unparseable is not an acknowledgement rather than a crash: this
    // runs on every message the server sends.
    expect(isHandshakeAck("not json")).toBe(false);
    expect(isHandshakeAck(undefined)).toBe(false);
    expect(isHandshakeAck(new ArrayBuffer(4))).toBe(false);
  });
});

describe("a streaming message", () => {
  it("carries its payload as a JSON STRING, not a nested object", () => {
    const m = parse(streamingMessage("/streaming/test", { a: 1 }));
    expect(m.type).toBe("Message");
    expect(m.target).toBe("/streaming/test");
    expect(typeof m.content).toBe("string");
    expect(JSON.parse(m.content)).toEqual({ a: 1 });
  });
});

describe("the session configuration", () => {
  const targets = (w = 1920, h = 1080) => sessionConfig({ width: w, height: h }).map((m) => parse(m).target);

  it("covers every characteristic the reference client sends", () => {
    expect(targets()).toEqual([
      "/streaming/systemUi/configuration",
      "/streaming/properties/clientappinstallidchanged",
      "/streaming/characteristics/orientationchanged",
      "/streaming/characteristics/touchinputenabledchanged",
      "/streaming/characteristics/clientdevicecapabilities",
      "/streaming/characteristics/dimensionschanged",
    ]);
  });

  it("reports the real screen, with the safe area as the whole of it", () => {
    const dims = JSON.parse(parse(sessionConfig({ width: 1280, height: 720 })[5]).content);
    expect(dims).toMatchObject({
      horizontal: 1280,
      vertical: 720,
      preferredWidth: 1280,
      preferredHeight: 720,
      // A television's overscan is the set's business; cropping here would
      // letterbox the game a second time.
      safeAreaLeft: 0,
      safeAreaTop: 0,
      safeAreaRight: 1280,
      safeAreaBottom: 720,
      supportsCustomResolution: true,
    });
  });

  it("never sends a zero or fractional dimension", () => {
    const dims = JSON.parse(parse(sessionConfig({ width: 0, height: 1080.6 })[5]).content);
    expect(dims.horizontal).toBe(1);
    expect(dims.vertical).toBe(1081);
  });

  it("declares touch off unless it is asked for", () => {
    const off = JSON.parse(parse(sessionConfig({ width: 1920, height: 1080 })[3]).content);
    expect(off.touchInputEnabled).toBe(false);
    const on = JSON.parse(parse(sessionConfig({ width: 1920, height: 1080, touch: true })[3]).content);
    expect(on.touchInputEnabled).toBe(true);
  });
});

describe("the control channel", () => {
  it("authorises with the client access key", () => {
    const a = parse(authorizationRequest());
    expect(a.message).toBe("authorizationRequest");
    expect(a.accessKey).toMatch(/^[0-9A-F-]{36}$/);
  });

  it("announces a pad by index, and its removal too", () => {
    // This is the message whose absence leaves a correct input stream ignored.
    expect(parse(gamepadChanged(0, true))).toEqual({ message: "gamepadChanged", gamepadIndex: 0, wasAdded: true });
    expect(parse(gamepadChanged(1, false))).toEqual({ message: "gamepadChanged", gamepadIndex: 1, wasAdded: false });
  });

  it("can ask for a keyframe", () => {
    expect(parse(keyframeRequest())).toEqual({ message: "videoKeyframeRequested", ifrRequested: true });
  });
});
