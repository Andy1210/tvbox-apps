// Which button index a pad's Guide/Home button has - read from the device, not
// assumed.
//
// RetroArch's udev joypad driver numbers a pad's buttons by ascending evdev code
// starting at BTN_MISC, so the index of any one button depends on the WHOLE key set
// the kernel reports for that device. That is where the Xbox pads on this box part
// ways: a pad the gamepad shim re-emits reports the eleven keys an Xbox layout
// actually has, and BTN_MODE lands on index 8 - which is what every Xbox profile in
// the flatpak binds the menu toggle to. The official controller over Bluetooth is
// driven by hid-microsoft, which reports the FULL gamepad key set including four
// buttons the hardware has not got (BTN_C, BTN_Z, BTN_TL2, BTN_TR2 - its triggers
// are axes), and those four shift BTN_MODE to index 12.
//
// libretro's own profile for that device (Xbox One S Wireless Controller.cfg,
// matched by vendor+product) shifts every other bind accordingly - select 10, start
// 11, thumbs 13/14 - and leaves `input_menu_toggle_btn = "8"`, i.e. pointing at a
// button that does not exist. That is the whole reason the Guide button does nothing
// on that pad while it works on the other one.
//
// The key set comes from sysfs rather than a libevdev binding: the shell has no
// native modules and the bitmask is two lines of parsing.

const fs = require("fs");
const path = require("path");

const INPUT_CLASS = "/sys/class/input";

// evdev codes we care about (linux/input-event-codes.h).
const BTN_MISC = 0x100; // where RetroArch starts counting buttons
const BTN_MODE = 0x13c; // Guide / Home / PS button
const BTN_SOUTH = 0x130;

// sysfs prints a capability bitmask as 64-bit words, HIGHEST word first, so the
// last word holds bits 0..63.
function keyBits(text) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const bits = new Set();
  for (let w = 0; w < words.length; w++) {
    const value = BigInt("0x" + words[words.length - 1 - w]);
    for (let b = 0; b < 64; b++) if ((value >> BigInt(b)) & 1n) bits.add(w * 64 + b);
  }
  return bits;
}

// The index RetroArch's udev driver gives one key: its position among the device's
// keys from BTN_MISC up. Returns null when the device does not report it at all.
function buttonIndex(bits, code) {
  if (!bits.has(code)) return null;
  let i = 0;
  for (const bit of [...bits].sort((a, b) => a - b)) {
    if (bit < BTN_MISC) continue;
    if (bit === code) return i;
    i++;
  }
  return null;
}

function read(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch (e) {
    return "";
  }
}

// Every joypad the kernel currently reports: the identity RetroArch matches a
// profile by, plus where this device's Guide button sits. A pad is anything with a
// south face button; a keyboard or a remote has none.
function pads() {
  let entries = [];
  try {
    entries = fs.readdirSync(INPUT_CLASS).filter((e) => /^event\d+$/.test(e));
  } catch (e) {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const dev = path.join(INPUT_CLASS, entry, "device");
    const bits = keyBits(read(path.join(dev, "capabilities", "key")));
    if (!bits.has(BTN_SOUTH)) continue;
    const vendor = read(path.join(dev, "id", "vendor")).toLowerCase();
    const product = read(path.join(dev, "id", "product")).toLowerCase();
    if (!/^[0-9a-f]{4}$/.test(vendor) || !/^[0-9a-f]{4}$/.test(product)) continue;
    out.push({
      event: entry,
      name: read(path.join(dev, "name")),
      // The decimal form is what an autoconfig profile carries.
      vendor: parseInt(vendor, 16),
      product: parseInt(product, 16),
      guide: buttonIndex(bits, BTN_MODE),
      buttons: [...bits].filter((b) => b >= BTN_MISC).length,
    });
  }
  return out;
}

module.exports = { keyBits, buttonIndex, pads, BTN_MODE, BTN_MISC };
