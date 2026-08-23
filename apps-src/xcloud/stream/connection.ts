// The WebRTC half of a stream. Everything here is in the page because it has to
// be: Node has no RTCPeerConnection, and the video, the audio and the input
// channel all belong where the screen is.
//
// The order below is not arbitrary. The data channels are created BEFORE the
// offer, because a channel added afterwards needs a renegotiation the server does
// not do; and the transceivers are added in the reference client's order and
// direction (audio sendrecv for the microphone, video recvonly) because the
// server answers the m-lines it was offered, in the order it was offered them.
import * as api from "../api";
import { buttonMask, clientMetadataPacket, inputPacket } from "./inputPacket";
import { readGamepads } from "./gamepad";
import { authorizationRequest, gamepadChanged, handshake, isHandshakeAck, sessionConfig } from "./channels";
import { setBitrate, setStereo } from "./sdp";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

// Name, and the sub-protocol the server matches on. A channel opened with the
// wrong protocol string opens and is then ignored.
const CHANNELS: Array<[string, RTCDataChannelInit]> = [
  ["input", { ordered: true, protocol: "1.0" }],
  ["chat", { protocol: "chatV1" }],
  ["control", { protocol: "controlV1" }],
  ["message", { protocol: "messageV1" }],
];

const INPUT_HZ = 60;
// Long enough for a host candidate on a wired box, short enough that a network
// with no reachable STUN does not hold the screen. The offer is sent either way:
// the session's own settings ask for `useIceConnection: false`, so the server's
// address comes from the answer rather than from candidate pairing.
const ICE_GATHER_TIMEOUT_MS = 3000;

export type Phase = "offering" | "answered" | "connecting" | "playing" | "closed" | "failed";

export interface StreamHandle {
  close(): void;
  readonly pc: RTCPeerConnection;
}

export interface StreamCallbacks {
  onPhase(phase: Phase, detail?: string): void;
  onStream(stream: MediaStream, kind: "video" | "audio"): void;
}

export interface Quality {
  /** 0 for no cap: the stream negotiates whatever the link allows. */
  maxVideoKbps?: number;
  stereo?: boolean;
}

export async function connect(cb: StreamCallbacks, quality?: Quality): Promise<StreamHandle> {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channels = new Map<string, RTCDataChannel>();
  const candidates: RTCIceCandidate[] = [];
  let inputTimer: number | null = null;
  let sequence = 0;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    if (inputTimer !== null) clearInterval(inputTimer);
    inputTimer = null;
    for (const ch of channels.values()) {
      try {
        ch.close();
      } catch {
        /* already gone with the connection */
      }
    }
    pc.close();
    cb.onPhase("closed");
  };

  pc.addEventListener("track", (event) => {
    const kind = event.track.kind;
    // Logged with the stream id, because "are the two tracks in ONE stream" is the
    // question that decides whether one element can carry both - assuming they
    // were is what left the game silent.
    console.log("[xcloud] track:", kind, "stream", (event.streams[0] && event.streams[0].id) || "(none)");
    if (kind === "video" || kind === "audio") cb.onStream(event.streams[0], kind);
  });

  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate) candidates.push(event.candidate);
  });

  pc.addEventListener("connectionstatechange", () => {
    if (closed) return;
    const s = pc.connectionState;
    if (s === "connected") cb.onPhase("playing");
    else if (s === "failed" || s === "disconnected") cb.onPhase("failed", "connection " + s);
  });

  for (const [name, init] of CHANNELS) {
    const ch = pc.createDataChannel(name, init);
    ch.binaryType = "arraybuffer";
    channels.set(name, ch);
  }

  const input = channels.get("input")!;
  const control = channels.get("control")!;
  const message = channels.get("message")!;

  // Input is the one channel with no visible failure mode: a pad that does
  // nothing looks identical whether the channel never opened, the browser is
  // showing no pads, or the server was never told a pad exists. So each is
  // distinguished in the log, once rather than per frame - the shell forwards an
  // app's console into ~/.tvbox/shell.log, which is the only way to see this from
  // off the sofa.
  let sent = 0;
  let lastMask = "";
  let started = false;
  let knownPads = 0;
  for (const [name, ch] of channels) {
    ch.addEventListener("close", () => console.log("[xcloud] channel closed:", name));
    ch.addEventListener("error", (e) => console.warn("[xcloud] channel error:", name, String(e)));
  }

  // The handshake gates everything. Sending input before the acknowledgement is
  // what a correct-looking 60 Hz stream that the game ignores is made of.
  message.addEventListener("open", () => message.send(handshake()));
  message.addEventListener("message", (ev) => {
    if (!isHandshakeAck((ev as MessageEvent).data) || started) return;
    started = true;
    console.log("[xcloud] handshake acknowledged");

    for (const m of sessionConfig({ width: window.innerWidth || 1920, height: window.innerHeight || 1080 })) {
      message.send(m);
    }
    if (control.readyState === "open") control.send(authorizationRequest());
    startInput();
  });

  function announcePads(count: number): void {
    // The server acts on input for a pad it has been told about, and on nothing
    // else. Announced by INDEX, so a second pad appearing later gets its own.
    for (let i = knownPads; i < count; i++) {
      if (control.readyState === "open") control.send(gamepadChanged(i, true));
    }
    for (let i = count; i < knownPads; i++) {
      if (control.readyState === "open") control.send(gamepadChanged(i, false));
    }
    if (count !== knownPads) console.log("[xcloud] pads announced:", count);
    knownPads = count;
  }

  function startInput(): void {
    if (input.readyState !== "open") {
      input.addEventListener("open", startInput, { once: true });
      return;
    }
    // The server will not act on input reports before the client metadata packet,
    // so it is the first thing on the channel rather than part of the loop. The
    // touch-point count is the reference client's; there is no way to see it being
    // refused, so it is not a number to improvise on.
    input.send(clientMetadataPacket(sequence++, 2));
    announcePads(readGamepads().length);

    inputTimer = window.setInterval(() => {
      if (input.readyState !== "open") return;
      const frames = readGamepads();
      if (frames.length !== knownPads) announcePads(frames.length);

      // EVERY tick, not only when something changed.
      //
      // Sending on change looked like an obvious saving and is what stopped the
      // pad outright: measured on the box, exactly one packet went out for a whole
      // session. This is a continuous STATE stream - the server is told where the
      // sticks are sixty times a second, and a gap is not "unchanged", it is
      // nothing to interpolate from.
      if (!frames.length) return;
      const packet = inputPacket(sequence++, { gamepads: frames });
      if (!packet) return;
      input.send(packet);
      sent++;

      // The log reports PRESSES rather than packets: at 60 Hz a packet count says
      // only that the loop runs, while a change in the button mask says a press
      // reached the wire.
      const mask = frames.map((f) => buttonMask(f)).join(",");
      if (mask !== lastMask) {
        lastMask = mask;
        console.log("[xcloud] buttons:", mask, "after", sent, "packets");
      }
    }, Math.round(1000 / INPUT_HZ));
  }

  // Audio sendrecv is what makes the microphone possible later; the track is not
  // added now, so nothing is captured and no permission is asked for.
  pc.addTransceiver("audio", { direction: "sendrecv" });
  pc.addTransceiver("video", { direction: "recvonly" });

  cb.onPhase("offering");
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  if (offer.sdp) {
    // The only two levers over quality this client has: the account is told
    // `allowRegionSelection: false` and the offering lists no selectable server
    // types, so the region and the server are not ours to choose.
    offer.sdp = setStereo(offer.sdp, quality?.stereo !== false);
    offer.sdp = setBitrate(offer.sdp, "video", quality?.maxVideoKbps || 0);
  }
  await pc.setLocalDescription(offer);

  await waitForIce(pc, ICE_GATHER_TIMEOUT_MS);

  const { answer } = await api.exchangeSdp(pc.localDescription?.sdp || offer.sdp || "");
  if (!answer || !answer.sdp) throw new Error("the server answered the offer with no SDP");
  cb.onPhase("answered");
  await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });

  cb.onPhase("connecting");
  const { candidates: remote } = await api.exchangeIce(candidates.map((c) => c.toJSON()));
  for (const c of remote || []) {
    try {
      await pc.addIceCandidate(toCandidate(c));
    } catch {
      // One unusable candidate is not a failed connection: the server offers an
      // IPv6 address on a box that may have no route to it.
    }
  }

  return { close, pc };
}

// The server returns its candidates with the SDP attribute prefix still attached
// ("a=candidate:..."), which addIceCandidate rejects - the field is the attribute
// VALUE. The reference client passes them through unchanged.
function toCandidate(c: { candidate: string; sdpMid?: string; sdpMLineIndex?: number }): RTCIceCandidateInit {
  return {
    candidate: String(c.candidate || "").replace(/^a=/, "").trim(),
    sdpMid: c.sdpMid ?? "0",
    sdpMLineIndex: c.sdpMLineIndex ?? 0,
  };
}

// Gathering is bounded rather than awaited: a box behind a firewall that eats
// STUN would otherwise sit on this screen for the browser's own timeout.
function waitForIce(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", onChange);
  });
}
