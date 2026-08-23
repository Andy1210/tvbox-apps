// Reading the pads into the protocol's frame.
//
// The mapping is Chromium's "standard" layout, which is what the box's pads
// present: the DualSense natively, and the Nacon through the tvbox-gamepad shim
// that republishes it as an Xbox 360 pad. A pad that reports a different mapping
// is still read, because the standard order is the common case and a wrong button
// is better than no pad.
import { GamepadFrame, emptyGamepadFrame } from "./inputPacket";

// Below this a stick is treated as centred. Not for the hardware's sake but for
// the channel's: a stick resting at 0.003 changes value every poll, so every tick
// becomes a packet even when nobody is touching the pad.
const AXIS_DEADZONE = 0.02;
const TRIGGER_DEADZONE = 0.02;

const btn = (pad: Gamepad, i: number): number => (pad.buttons[i] ? (pad.buttons[i].pressed ? 1 : 0) : 0);
const analog = (pad: Gamepad, i: number): number => (pad.buttons[i] ? pad.buttons[i].value : 0);
const axis = (pad: Gamepad, i: number): number => {
  const v = pad.axes[i] ?? 0;
  return Math.abs(v) < AXIS_DEADZONE ? 0 : v;
};
const trigger = (v: number): number => (v < TRIGGER_DEADZONE ? 0 : v);

export function readGamepad(pad: Gamepad, index: number): GamepadFrame {
  return {
    ...emptyGamepadFrame(index),
    a: btn(pad, 0),
    b: btn(pad, 1),
    x: btn(pad, 2),
    y: btn(pad, 3),
    leftShoulder: btn(pad, 4),
    rightShoulder: btn(pad, 5),
    view: btn(pad, 8),
    menu: btn(pad, 9),
    leftThumb: btn(pad, 10),
    rightThumb: btn(pad, 11),
    dpadUp: btn(pad, 12),
    dpadDown: btn(pad, 13),
    dpadLeft: btn(pad, 14),
    dpadRight: btn(pad, 15),
    // The Xbox button goes THROUGH to the server, which answers it with xCloud's
    // own guide overlay. Catching it here to leave the stream was wrong twice
    // over: it took away the menu the button exists for, and the way out was
    // already the remote's Back key, which reaches the page as a keypress and
    // never touches the pad.
    nexus: btn(pad, 16),
    leftThumbX: axis(pad, 0),
    leftThumbY: axis(pad, 1),
    rightThumbX: axis(pad, 2),
    rightThumbY: axis(pad, 3),
    leftTrigger: trigger(analog(pad, 6)),
    rightTrigger: trigger(analog(pad, 7)),
  };
}

// Every connected pad, in the order the browser hands them over. Chromium only
// exposes a pad after its first button press, so an empty list on the first poll
// is normal and not a missing pad.
export function readGamepads(): GamepadFrame[] {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const out: GamepadFrame[] = [];
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (pad && pad.connected) out.push(readGamepad(pad, out.length));
  }
  return out;
}
