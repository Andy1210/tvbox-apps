// The input channel's wire format.
//
// This is a fixed binary layout the server parses without negotiation, so every
// offset here is load-bearing and none of it is guessable - it is transcribed from
// the reference client (xbox-xcloud-player) and pinned by the tests next door.
//
// Header, 14 bytes, little-endian throughout:
//   u16  reportType   a bitmask of ReportType
//   u32  sequence     ours, incrementing, starts at 0
//   f64  timestamp    performance.now()
//
// Then, for each report type present, in this exact order: metadata, gamepad,
// pointer, mouse, keyboard. Each section starts with a u8 frame count.

export const ReportType = {
  None: 0,
  Metadata: 1,
  Gamepad: 2,
  Pointer: 4,
  ClientMetadata: 8,
  ServerMetadata: 16,
  Mouse: 32,
  Keyboard: 64,
  Vibration: 128,
  Sensor: 256,
} as const;

export const HEADER_BYTES = 14;
// 1 index + 2 buttons + 4x2 axes + 2x2 triggers + 4 physical + 4 virtual.
export const GAMEPAD_FRAME_BYTES = 23;
export const KEYBOARD_FRAME_BYTES = 3;

export interface GamepadFrame {
  index: number;
  // Buttons as 0/1 (the wire format is a bitmask, but a caller thinks in buttons).
  nexus: number;
  menu: number;
  view: number;
  a: number;
  b: number;
  x: number;
  y: number;
  dpadUp: number;
  dpadDown: number;
  dpadLeft: number;
  dpadRight: number;
  leftShoulder: number;
  rightShoulder: number;
  leftThumb: number;
  rightThumb: number;
  // Axes as -1..1, triggers as 0..1 - the Gamepad API's own ranges.
  leftThumbX: number;
  leftThumbY: number;
  rightThumbX: number;
  rightThumbY: number;
  leftTrigger: number;
  rightTrigger: number;
}

export interface KeyboardFrame {
  pressed: boolean;
  keyCode: number;
}

// Bit for each button. Bit 0 is unused by the protocol - the mask starts at 2.
const BUTTON_BITS: Array<[keyof GamepadFrame, number]> = [
  ["nexus", 2],
  ["menu", 4],
  ["view", 8],
  ["a", 16],
  ["b", 32],
  ["x", 64],
  ["y", 128],
  ["dpadUp", 256],
  ["dpadDown", 512],
  ["dpadLeft", 1024],
  ["dpadRight", 2048],
  ["leftShoulder", 4096],
  ["rightShoulder", 8192],
  ["leftThumb", 16384],
  ["rightThumb", 32768],
];

export function buttonMask(frame: GamepadFrame): number {
  let mask = 0;
  for (const [key, bit] of BUTTON_BITS) {
    if ((frame[key] as number) > 0) mask |= bit;
  }
  return mask;
}

// An axis is a signed 16-bit value clamped to ±32767 - NOT 32768, so the two
// directions are symmetric and a full-left stick is exactly the negative of a
// full-right one.
export function axisValue(v: number): number {
  const scaled = Math.trunc(v * 32767);
  return scaled > 32767 ? 32767 : scaled < -32767 ? -32767 : scaled;
}

// A trigger is unsigned 16-bit. A negative reading (some pads idle just below
// zero) is a released trigger, not a wrapped-around full pull.
export function triggerValue(v: number): number {
  if (!(v > 0)) return 0;
  const scaled = Math.trunc(v * 65535);
  return scaled > 65535 ? 65535 : scaled;
}

function writeHeader(view: DataView, reportType: number, sequence: number, now: number): void {
  view.setUint16(0, reportType, true);
  view.setUint32(2, sequence, true);
  view.setFloat64(6, now, true);
}

// The first packet on the channel. It declares how many touch points the client
// has; the server will not send input-related metadata before it arrives.
export function clientMetadataPacket(sequence: number, maxTouchPoints = 0, now = performance.now()): ArrayBuffer {
  const buf = new ArrayBuffer(HEADER_BYTES + 1);
  const view = new DataView(buf);
  writeHeader(view, ReportType.ClientMetadata, sequence, now);
  view.setUint8(HEADER_BYTES, maxTouchPoints);
  return buf;
}

export interface InputPacketInput {
  gamepads?: GamepadFrame[];
  keyboard?: KeyboardFrame[];
}

// One packet carrying whatever the caller has queued. Returns null when there is
// nothing to send - an empty packet is not a heartbeat, and sending one every tick
// is 60 pointless messages a second on the data channel.
export function inputPacket(sequence: number, input: InputPacketInput, now = performance.now()): ArrayBuffer | null {
  const gamepads = input.gamepads || [];
  const keyboard = input.keyboard || [];
  if (!gamepads.length && !keyboard.length) return null;

  let reportType = ReportType.None;
  let size = HEADER_BYTES;
  if (gamepads.length) {
    reportType |= ReportType.Gamepad;
    size += 1 + GAMEPAD_FRAME_BYTES * gamepads.length;
  }
  if (keyboard.length) {
    reportType |= ReportType.Keyboard;
    size += 1 + KEYBOARD_FRAME_BYTES * keyboard.length;
  }

  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  writeHeader(view, reportType, sequence, now);
  let offset = HEADER_BYTES;

  // Order matters: the server reads the sections in report-type order, so gamepad
  // before keyboard whatever order the caller queued them in.
  if (gamepads.length) {
    view.setUint8(offset, gamepads.length);
    offset++;
    for (const f of gamepads) {
      view.setUint8(offset, f.index);
      offset++;
      view.setUint16(offset, buttonMask(f), true);
      // The Y axes are INVERTED against the Gamepad API: a browser reports -1 for
      // up, the protocol expects +1. Sending it through unflipped is a stick that
      // works and is upside down, which reads as a broken pad rather than a bug.
      view.setInt16(offset + 2, axisValue(f.leftThumbX), true);
      view.setInt16(offset + 4, axisValue(-f.leftThumbY), true);
      view.setInt16(offset + 6, axisValue(f.rightThumbX), true);
      view.setInt16(offset + 8, axisValue(-f.rightThumbY), true);
      view.setUint16(offset + 10, triggerValue(f.leftTrigger), true);
      view.setUint16(offset + 12, triggerValue(f.rightTrigger), true);
      view.setUint32(offset + 14, 0, true); // physical physicality
      view.setUint32(offset + 18, 0, true); // virtual physicality
      offset += GAMEPAD_FRAME_BYTES - 1;
    }
  }

  if (keyboard.length) {
    view.setUint8(offset, keyboard.length);
    offset++;
    for (const k of keyboard) {
      view.setUint8(offset, 2); // 2 = VKey (1 = known, 3 = app command, 0 = unknown)
      view.setUint8(offset + 1, k.pressed ? 1 : 0);
      view.setUint8(offset + 2, k.keyCode & 0xff);
      offset += KEYBOARD_FRAME_BYTES;
    }
  }

  // A layout that does not fill its own buffer means an offset above is wrong, and
  // the server would read the next field from the wrong byte.
  if (offset !== size) throw new Error("input packet length mismatch: wrote " + offset + " of " + size);
  return buf;
}

export const emptyGamepadFrame = (index = 0): GamepadFrame => ({
  index,
  nexus: 0, menu: 0, view: 0,
  a: 0, b: 0, x: 0, y: 0,
  dpadUp: 0, dpadDown: 0, dpadLeft: 0, dpadRight: 0,
  leftShoulder: 0, rightShoulder: 0, leftThumb: 0, rightThumb: 0,
  leftThumbX: 0, leftThumbY: 0, rightThumbX: 0, rightThumbY: 0,
  leftTrigger: 0, rightTrigger: 0,
});
