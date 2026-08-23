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
import { buttonMask, clientMetadataPacket, emptyGamepadFrame, inputPacket } from "./inputPacket";
import { readGamepads } from "./gamepad";
import {
  authorizationRequest,
  gamepadChanged,
  handshake,
  isHandshakeAck,
  parseDialog,
  sessionConfig,
  transactionComplete,
  type ServerDialog,
} from "./channels";
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

// How often to ask the connection whether frames are still arriving, and how long
// a gap has to be before the stream counts as over.
//
// This is the only signal that actually fires when someone quits from the Xbox
// guide. Measured: the session stays `Provisioned` on the server, no data channel
// closes, and the control channel says nothing - the media simply stops, and the
// next thing to notice is WebRTC's own ICE timeout half a minute later.
//
// A static game screen still sends frames, so a gap of seconds is not a quiet
// picture; it is no picture.
//
// Eight seconds rather than four, and the difference is who pays for being wrong:
// too short takes a game away from somebody over a wifi hiccup, too long is the
// frozen picture this exists to shorten. Eight is well inside the ~30 s it used
// to take and long enough that a glitch has recovered - and a recovery is logged,
// so whether that ever happens here is a measurement rather than a guess.
const FRAME_WATCH_MS = 1000;
const FRAME_GAP_MS = 8000;
// How long the FIRST frame may take. A stream that has been running and stops is
// a different thing from one that has not started: measured on the box, a session
// negotiated, opened its channels and had the server talking on them, and no
// frame was ever decoded - and because `framesDecoded` is 0 rather than absent
// while that happens, the eight-second gap timer had already armed and killed it.
// The server's own no-connection timeout is 300 s; this is the shortest wait that
// is unambiguously a failure rather than a slow start.
const FIRST_FRAME_MS = 45000;

export type Phase = "offering" | "answered" | "connecting" | "playing" | "closed" | "failed";

export interface StreamHandle {
  close(): void;
  /** Which button was pressed, by index. */
  answerDialog(id: string, index: number): void;
  /**
   * Stop or resume sending the pad to the game.
   *
   * Off while a dialog of ours is on screen: the pad has to drive that, and a pad
   * that drives both moves a menu and the game with the same press.
   */
  setInputEnabled(on: boolean): void;
  readonly pc: RTCPeerConnection;
}

export interface StreamCallbacks {
  onPhase(phase: Phase, detail?: string): void;
  onStream(stream: MediaStream, kind: "video" | "audio"): void;
  /**
   * The server is asking a question and expects THIS client to draw it - the
   * "quit the game?" confirmation from the Xbox guide is one. Answer it through
   * the handle's `answerDialog`.
   */
  onDialog?(dialog: ServerDialog): void;
  /**
   * The session is over - normally, because somebody quit from the Xbox guide.
   *
   * The channels closing is the FAST signal: WebRTC's own connection state does
   * get there, but only after its ICE timeout, which is the half minute of frozen
   * picture this exists to avoid.
   */
  onEnded?(why: string): void;
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
  let frameTimer: number | null = null;
  let sequence = 0;
  let closed = false;
  let inputEnabled = true;
  let resumeTimer: number | null = null;

  // A send on a channel that has closed throws an InvalidStateError, and it did -
  // the teardown races the last few messages. Every send goes through here.
  const send = (ch: RTCDataChannel, data: string | ArrayBuffer): boolean => {
    if (closed || ch.readyState !== "open") return false;
    try {
      ch.send(data as string);
      return true;
    } catch (e) {
      console.warn("[xcloud] send on", ch.label, "failed:", String(e));
      return false;
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (inputTimer !== null) clearInterval(inputTimer);
    inputTimer = null;
    if (frameTimer !== null) clearInterval(frameTimer);
    frameTimer = null;
    if (resumeTimer !== null) clearTimeout(resumeTimer);
    resumeTimer = null;
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
    // `disconnected` is WebRTC saying its connectivity checks have stopped
    // succeeding, and it returns to `connected` on its own - so it is not a
    // failure to put on the screen. Nothing clears an error once shown, so a
    // short hiccup used to replace a stream that recovers with a permanent error
    // screen. That also contradicted the frame watchdog above, whose eight
    // seconds exist precisely so a hiccup does not take a game away.
    if (s === "connected") cb.onPhase("playing");
    else if (s === "disconnected") console.warn("[xcloud] connection disconnected - waiting to see if it returns");
    else if (s === "failed") cb.onPhase("failed", "connection failed");
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
    ch.addEventListener("close", () => {
      console.log("[xcloud] channel closed:", name);
      // The input channel closing means the session is gone. The chat channel
      // closes by itself on a session with no microphone, so it says nothing.
      if (!closed && (name === "input" || name === "control")) cb.onEnded?.("channel " + name + " closed");
    });
    ch.addEventListener("error", (e) => console.warn("[xcloud] channel error:", name, String(e)));
  }

  // What the server says on the control channel. Logged rather than acted on:
  // there may be a cleaner "session ending" message in here than a closing
  // channel, and this is how it gets found.
  control.addEventListener("message", (ev) =>
    console.log("[xcloud] control:", String((ev as MessageEvent).data).slice(0, 200)),
  );

  // The handshake gates everything. Sending input before the acknowledgement is
  // what a correct-looking 60 Hz stream that the game ignores is made of.
  message.addEventListener("open", () => send(message, handshake()));
  message.addEventListener("message", (ev) => {
    const raw = String((ev as MessageEvent).data);
    // Everything the server sends here, because one of these is the dialog it
    // expects US to draw. `systemUis` in the handshake declares that this client
    // can show a message dialog (19 = ShowMessageDialog), so a "quit the game?"
    // confirmation is handed over rather than drawn by the server - and a client
    // that shows nothing leaves the session waiting for an answer that never
    // comes. That is the freeze after a quit from the guide.
    if (!isHandshakeAck(raw)) {
      const dialog = parseDialog(raw);
      if (dialog) {
        // Already capped by parseDialog, but the log line is capped everywhere
        // else on this channel and there is no reason for this one to differ.
        console.log(
          "[xcloud] dialog:",
          dialog.title.slice(0, 120),
          "|",
          dialog.buttons
            .map((b) => b.index + ":" + b.label)
            .join(" / ")
            .slice(0, 120),
        );
        cb.onDialog?.(dialog);
        return;
      }
      // A payload that LOOKS like a dialog and was not recognised is logged
      // whole: the last time this was wrong, the log had been truncated before
      // the fields the parser needed, and the fix was built on a guess about what
      // came after the cut.
      console.log("[xcloud] message:", raw.slice(0, raw.includes("TitleText") ? 900 : 300));
    }
    if (!isHandshakeAck(raw) || started) return;
    started = true;
    console.log("[xcloud] handshake acknowledged");

    for (const m of sessionConfig({ width: window.innerWidth || 1920, height: window.innerHeight || 1080 })) {
      send(message, m);
    }
    send(control, authorizationRequest());
    startInput();
  });

  function announcePads(count: number): void {
    // The server acts on input for a pad it has been told about, and on nothing
    // else. Announced by INDEX, so a second pad appearing later gets its own.
    for (let i = knownPads; i < count; i++) send(control, gamepadChanged(i, true));
    for (let i = count; i < knownPads; i++) send(control, gamepadChanged(i, false));
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
    send(input, clientMetadataPacket(sequence++, 2));
    announcePads(readGamepads().length);

    inputTimer = window.setInterval(() => {
      if (input.readyState !== "open" || !inputEnabled) return;
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
      if (!packet || !send(input, packet)) return;
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

  // Everything from here can reject, and until `connect` returns there is no
  // handle for a caller to close - so the peer connection, four data channels and
  // the 60 Hz input timer would be left running behind an error screen, with the
  // video and audio elements still receiving tracks.
  try {
    return await negotiate();
  } catch (e) {
    close();
    throw e;
  }

  async function negotiate(): Promise<StreamHandle> {
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

  watchFrames();
  return {
    close,
    answerDialog: (id, index) => {
      console.log("[xcloud] dialog answered:", index);
      send(message, transactionComplete(id, index));
    },
    setInputEnabled: (on) => {
      if (on) {
        // Not until every button is up. The press that answered the dialog is
        // still held when it closes, and resuming there hands the game a press
        // nobody meant for it - the same replay, in the other direction, that
        // made a launched game flash and vanish.
        if (resumeTimer !== null) clearTimeout(resumeTimer);
        const arm = () => {
          resumeTimer = null;
          if (closed) return;
          if (readGamepads().some((f) => buttonMask(f) !== 0)) {
            resumeTimer = window.setTimeout(arm, 50);
            return;
          }
          inputEnabled = true;
        };
        arm();
        return;
      }
      if (resumeTimer !== null) clearTimeout(resumeTimer);
      resumeTimer = null;
      inputEnabled = false;
      // Release everything on the way out, or the game keeps whatever was held
      // when the dialog opened - a stick pushed, a trigger down - for as long as
      // it is up.
      const idle = readGamepads().map((f) => ({ ...emptyGamepadFrame(f.index) }));
      if (idle.length) {
        const packet = inputPacket(sequence++, { gamepads: idle });
        if (packet) send(input, packet);
      }
    },
    pc,
  };
  }

  function watchFrames(): void {
    let lastFrames = -1;
    let lastMoved = 0;
    // Not `lastMoved`: `framesDecoded` reads 0 before the first frame, so
    // "something moved" and "something exists" are not the same question, and
    // conflating them armed the running-stream timer against a stream that had
    // never started.
    let everMoved = false;
    const startedAt = Date.now();
    frameTimer = window.setInterval(async () => {
      if (closed) return;
      let frames = -1;
      try {
        const stats = await pc.getStats();
        stats.forEach((r) => {
          const s = r as RTCInboundRtpStreamStats & { framesDecoded?: number };
          if (s.type === "inbound-rtp" && s.kind === "video" && typeof s.framesDecoded === "number") {
            frames = s.framesDecoded;
          }
        });
      } catch {
        return; // a stats read that failed says nothing about the stream
      }
      // Again AFTER the await: `close()` can land while `getStats` is out, and a
      // tick that started before the teardown must not report the stream ended.
      if (closed) return;
      const now = Date.now();
      // Nothing has decoded yet - no stats row at all, or a row still reading 0.
      if (frames <= 0) {
        if (!everMoved && now - startedAt > FIRST_FRAME_MS) {
          console.log("[xcloud] no first frame after", Math.round((now - startedAt) / 1000) + "s");
          stopWatching();
          cb.onEnded?.("no_first_frame");
        }
        return;
      }

      if (frames !== lastFrames) {
        if (everMoved && now - lastMoved > 2000) {
          console.log("[xcloud] frames resumed after", Math.round((now - lastMoved) / 1000) + "s");
        }
        lastFrames = frames;
        lastMoved = now;
        everMoved = true;
        return;
      }
      // Only once frames HAVE been arriving: a gap before the first one is the
      // stream starting, and FIRST_FRAME_MS is what bounds that.
      if (everMoved && now - lastMoved > FRAME_GAP_MS) {
        console.log("[xcloud] no frames for", Math.round((now - lastMoved) / 1000) + "s - the stream has stopped");
        stopWatching();
        cb.onEnded?.("no_frames");
      }
    }, FRAME_WATCH_MS);

    function stopWatching() {
      if (frameTimer !== null) clearInterval(frameTimer);
      frameTimer = null;
    }
  }
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
