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
import { clientMetadataPacket, inputPacket } from "./inputPacket";
import { frameChanged, readGamepads } from "./gamepad";
import type { GamepadFrame } from "./inputPacket";

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
  // The Xbox button is not forwarded: on a television it is the only way out of a
  // running stream, so the app decides what it means.
  onNexus?(): void;
}

export async function connect(cb: StreamCallbacks): Promise<StreamHandle> {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channels = new Map<string, RTCDataChannel>();
  const candidates: RTCIceCandidate[] = [];
  let inputTimer: number | null = null;
  let sequence = 0;
  let lastFrames: GamepadFrame[] = [];
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
  input.addEventListener("open", () => {
    // The server will not act on input reports before the client metadata packet,
    // so it is the first thing on the channel rather than part of the loop.
    input.send(clientMetadataPacket(sequence++));
    inputTimer = window.setInterval(() => {
      if (input.readyState !== "open") return;
      const frames = readGamepads();

      if (cb.onNexus && frames.some((f) => f.nexus > 0)) cb.onNexus();
      // Held, not forwarded - see onNexus.
      for (const f of frames) f.nexus = 0;

      // Only what changed. An idle pad at 60 Hz is otherwise 60 identical
      // messages a second on a channel shared with the video's metadata.
      const changed = frames.filter((f, i) => frameChanged(lastFrames[i], f));
      lastFrames = frames;
      if (!changed.length) return;

      const packet = inputPacket(sequence++, { gamepads: changed });
      if (packet) input.send(packet);
    }, Math.round(1000 / INPUT_HZ));
  });

  // Audio sendrecv is what makes the microphone possible later; the track is not
  // added now, so nothing is captured and no permission is asked for.
  pc.addTransceiver("audio", { direction: "sendrecv" });
  pc.addTransceiver("video", { direction: "recvonly" });

  cb.onPhase("offering");
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  // Stereo: the server's Opus offer says `useinbandfec=1` and nothing about
  // channels, and the default is mono.
  if (offer.sdp) offer.sdp = offer.sdp.replace("useinbandfec=1", "useinbandfec=1; stereo=1");
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
