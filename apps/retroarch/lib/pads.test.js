// Tests for the pad-button numbering. The bitmask below is what this box's own Xbox
// Wireless Controller reports in sysfs, and the index it yields (12) is the one that
// was verified to open RetroArch's menu on that pad - so this is the regression test
// for the whole reason lib/autoconfig.js exists.
const test = require("node:test");
const assert = require("node:assert");

const pads = require("./pads");

test("the sysfs bitmask is read with the highest word FIRST", () => {
  // Real reading from the box: 15 gamepad buttons (0x130-0x13e) plus KEY_RECORD (167).
  const bits = pads.keyBits("7fff000000000000 0 8000000000 0 0");
  assert.ok(bits.has(0x130), "BTN_SOUTH");
  assert.ok(bits.has(0x13e), "BTN_THUMBR");
  assert.ok(bits.has(167), "KEY_RECORD");
  assert.strictEqual(bits.has(0x12f), false, "nothing below the gamepad range");
  assert.strictEqual([...bits].filter((b) => b >= pads.BTN_MISC).length, 15);
});

test("the Guide button is index 12 on a pad reporting the full gamepad key set", () => {
  const bits = pads.keyBits("7fff000000000000 0 8000000000 0 0");
  assert.strictEqual(pads.buttonIndex(bits, pads.BTN_MODE), 12);
  // Keys below BTN_MISC are not buttons and must not shift the numbering - the Share
  // button (KEY_RECORD) sits there.
  assert.strictEqual(pads.buttonIndex(bits, 0x130), 0);
});

test("the same button is index 8 on a pad reporting only the keys an Xbox layout has", () => {
  // What the gamepad shim's re-emitted pad looks like, and what every Xbox profile in
  // the flatpak was written against: no BTN_C/BTN_Z/BTN_TL2/BTN_TR2.
  const trimmed = new Set([0x130, 0x131, 0x133, 0x134, 0x136, 0x137, 0x13a, 0x13b, 0x13c, 0x13d, 0x13e]);
  assert.strictEqual(pads.buttonIndex(trimmed, pads.BTN_MODE), 8);
});

test("a button the device does not report has no index", () => {
  const bits = pads.keyBits("0 0 0 0 0");
  assert.strictEqual(pads.buttonIndex(bits, pads.BTN_MODE), null);
  assert.deepStrictEqual([...pads.keyBits("")], []);
  assert.deepStrictEqual([...pads.keyBits(undefined)], []);
});

test("reading the real input class does not throw and reports whole pads", () => {
  // Whatever this machine has (probably nothing), the shape must hold - the plugin
  // calls this on every launch.
  for (const pad of pads.pads()) {
    assert.strictEqual(typeof pad.name, "string");
    assert.ok(Number.isInteger(pad.vendor) && Number.isInteger(pad.product));
    assert.ok(pad.guide === null || Number.isInteger(pad.guide));
  }
});
