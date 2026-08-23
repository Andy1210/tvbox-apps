// The input wire format, byte by byte.
//
// Worth this much detail because nothing downstream reports a mistake: the server
// parses a fixed layout with no negotiation and no error channel, so a wrong
// offset is a pad that half works. The values below are read back out of the
// buffer rather than compared to a golden blob, so a failure says WHICH field
// moved.
import { describe, expect, it } from "vitest";
import {
  GAMEPAD_FRAME_BYTES,
  HEADER_BYTES,
  ReportType,
  axisValue,
  buttonMask,
  clientMetadataPacket,
  emptyGamepadFrame,
  inputPacket,
  triggerValue,
} from "../stream/inputPacket";

const header = (buf: ArrayBuffer) => {
  const v = new DataView(buf);
  return { reportType: v.getUint16(0, true), sequence: v.getUint32(2, true), timestamp: v.getFloat64(6, true) };
};

describe("the header", () => {
  it("is 14 bytes of little-endian type, sequence and clock", () => {
    const buf = clientMetadataPacket(7, 0, 1234.5);
    expect(buf.byteLength).toBe(HEADER_BYTES + 1);
    expect(header(buf)).toEqual({ reportType: ReportType.ClientMetadata, sequence: 7, timestamp: 1234.5 });
    // The touch-point count is the whole body of the first packet.
    expect(new DataView(buf).getUint8(HEADER_BYTES)).toBe(0);
  });

  it("carries the touch-point count it is given", () => {
    expect(new DataView(clientMetadataPacket(0, 2)).getUint8(HEADER_BYTES)).toBe(2);
  });
});

describe("the gamepad frame", () => {
  const frame = (over: Partial<ReturnType<typeof emptyGamepadFrame>> = {}) => ({ ...emptyGamepadFrame(), ...over });

  it("is 23 bytes after a one-byte count", () => {
    const buf = inputPacket(1, { gamepads: [frame()] })!;
    expect(buf.byteLength).toBe(HEADER_BYTES + 1 + GAMEPAD_FRAME_BYTES);
    expect(header(buf).reportType).toBe(ReportType.Gamepad);
    expect(new DataView(buf).getUint8(HEADER_BYTES)).toBe(1);
  });

  it("puts each button on its own bit, starting at 2", () => {
    // Bit 0 is unused by the protocol; a mask built from bit 0 shifts every
    // button by one and the server reads A as B.
    expect(buttonMask(frame({ nexus: 1 }))).toBe(2);
    expect(buttonMask(frame({ a: 1 }))).toBe(16);
    expect(buttonMask(frame({ rightThumb: 1 }))).toBe(32768);
    expect(buttonMask(frame({ a: 1, b: 1, dpadUp: 1 }))).toBe(16 | 32 | 256);
    expect(buttonMask(frame())).toBe(0);
  });

  it("INVERTS the Y axes, because the browser and the protocol disagree", () => {
    // navigator.getGamepads() reports -1 for up; the protocol wants +1. Passing
    // it through unflipped is a stick that works upside down, which reads as a
    // broken pad rather than a bug.
    const buf = inputPacket(0, { gamepads: [frame({ leftThumbY: -1, rightThumbY: 1 })] })!;
    const v = new DataView(buf);
    const at = HEADER_BYTES + 2; // past the count and the index
    expect(v.getInt16(at + 4, true)).toBe(32767); // left stick up
    expect(v.getInt16(at + 8, true)).toBe(-32767); // right stick down
  });

  it("keeps the two axis directions symmetric", () => {
    // 32767 rather than 32768, so full-left is exactly minus full-right.
    expect(axisValue(1)).toBe(32767);
    expect(axisValue(-1)).toBe(-32767);
    expect(axisValue(0)).toBe(0);
    // A pad reading slightly past the rails must not wrap.
    expect(axisValue(1.5)).toBe(32767);
    expect(axisValue(-1.5)).toBe(-32767);
  });

  it("treats a negative trigger as released, not as fully pulled", () => {
    // Some pads idle a hair below zero; an unsigned cast of that is 65535.
    expect(triggerValue(-0.01)).toBe(0);
    expect(triggerValue(0)).toBe(0);
    expect(triggerValue(1)).toBe(65535);
    expect(triggerValue(2)).toBe(65535);
    expect(triggerValue(0.5)).toBe(32767);
  });

  it("writes the fields at the offsets the server reads them from", () => {
    const buf = inputPacket(0, {
      gamepads: [frame({ a: 1, leftThumbX: 1, leftTrigger: 1, rightTrigger: 0.5, index: 3 })],
    })!;
    const v = new DataView(buf);
    let o = HEADER_BYTES + 1;
    expect(v.getUint8(o)).toBe(3); // gamepad index
    o++;
    expect(v.getUint16(o, true)).toBe(16); // A
    expect(v.getInt16(o + 2, true)).toBe(32767); // left X
    expect(v.getInt16(o + 4, true)).toBe(0);
    expect(v.getUint16(o + 10, true)).toBe(65535); // left trigger
    expect(v.getUint16(o + 12, true)).toBe(32767); // right trigger
    expect(v.getUint32(o + 14, true)).toBe(0);
    expect(v.getUint32(o + 18, true)).toBe(0);
  });

  it("packs several pads back to back", () => {
    const buf = inputPacket(0, { gamepads: [frame({ a: 1 }), frame({ index: 1, b: 1 })] })!;
    expect(buf.byteLength).toBe(HEADER_BYTES + 1 + GAMEPAD_FRAME_BYTES * 2);
    const v = new DataView(buf);
    expect(v.getUint8(HEADER_BYTES)).toBe(2);
    expect(v.getUint16(HEADER_BYTES + 2, true)).toBe(16);
    expect(v.getUint8(HEADER_BYTES + 1 + GAMEPAD_FRAME_BYTES)).toBe(1); // second pad's index
    expect(v.getUint16(HEADER_BYTES + 1 + GAMEPAD_FRAME_BYTES + 1, true)).toBe(32);
  });
});

describe("the keyboard frame", () => {
  it("is a kind, a state and a code", () => {
    const buf = inputPacket(0, { keyboard: [{ pressed: true, keyCode: 65 }] })!;
    expect(header(buf).reportType).toBe(ReportType.Keyboard);
    const v = new DataView(buf);
    expect(v.getUint8(HEADER_BYTES)).toBe(1); // count
    expect(v.getUint8(HEADER_BYTES + 1)).toBe(2); // 2 = VKey
    expect(v.getUint8(HEADER_BYTES + 2)).toBe(1); // pressed
    expect(v.getUint8(HEADER_BYTES + 3)).toBe(65);
  });
});

describe("a packet with both", () => {
  it("puts the gamepad section first, whatever order the caller queued", () => {
    const buf = inputPacket(0, {
      keyboard: [{ pressed: false, keyCode: 27 }],
      gamepads: [{ ...emptyGamepadFrame(), a: 1 }],
    })!;
    expect(header(buf).reportType).toBe(ReportType.Gamepad | ReportType.Keyboard);
    const v = new DataView(buf);
    // Gamepad count, then its frame, then the keyboard count.
    expect(v.getUint8(HEADER_BYTES)).toBe(1);
    expect(v.getUint8(HEADER_BYTES + 1 + GAMEPAD_FRAME_BYTES)).toBe(1);
    expect(v.getUint8(HEADER_BYTES + 1 + GAMEPAD_FRAME_BYTES + 1)).toBe(2); // VKey
  });
});

describe("nothing to send", () => {
  it("is null rather than an empty packet", () => {
    // An empty packet is not a heartbeat; sending one per tick is 60 pointless
    // messages a second on the channel.
    expect(inputPacket(0, {})).toBeNull();
    expect(inputPacket(0, { gamepads: [], keyboard: [] })).toBeNull();
  });
});
