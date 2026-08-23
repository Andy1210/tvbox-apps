// The handful of things this client can actually decide.
//
// Deliberately short, because most of what a settings screen would like to offer
// is not ours: the account is told `allowRegionSelection: false` and the offering
// lists no selectable server types, so region and server are Microsoft's choice.
// What is left is what WE put in the offer and in the session request.
//
// Every value is validated on the way in rather than on the way out: this is an
// unauthenticated loopback API, the numbers travel to Microsoft in a session
// request, and a settings write is the one place a bad one can enter.
const fs = require("fs");
const os = require("os");
const path = require("path");

const FILE = process.env.TVBOX_XCLOUD_SETTINGS || path.join(os.homedir(), ".tvbox", "xcloud-settings.json");

// 0 means "no cap": the stream negotiates whatever the link allows, which is the
// right default and the only one that cannot make things worse.
const DEFAULTS = {
  maxVideoKbps: 0,
  stereo: true,
  // "" follows the box's own language. A game's language is chosen at session
  // start and cannot be changed once it is running.
  gameLocale: "",
  // 0 means the screen's own height. Capping it is the lever for a weak link that
  // a bitrate cap alone does not give: the server renders smaller rather than
  // compressing 1080p harder.
  maxHeight: 0,
};

// What the UI may offer, and therefore what a write may contain. A value outside
// these is not clamped into range - it is refused, because a settings screen that
// silently stores something else is worse than one that says no.
const ALLOWED = {
  maxVideoKbps: [0, 5000, 10000, 20000, 30000],
  maxHeight: [0, 720, 1080],
  gameLocale: ["", "en-US", "en-GB", "hu-HU", "de-DE", "fr-FR", "es-ES", "it-IT", "pl-PL"],
};

let cache = null;

function load() {
  if (cache) return cache;
  cache = { ...DEFAULTS };
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    for (const key of Object.keys(DEFAULTS)) {
      if (raw[key] !== undefined && valid(key, raw[key])) cache[key] = raw[key];
    }
  } catch {
    /* nothing saved yet, or a file we cannot read - the defaults are the answer */
  }
  return cache;
}

function valid(key, value) {
  if (key === "stereo") return typeof value === "boolean";
  const allowed = ALLOWED[key];
  return !!allowed && allowed.includes(value);
}

function get() {
  return { ...load() };
}

// Returns the settings as they now stand, or throws with the offending key - the
// screen names it rather than reporting a generic failure.
function set(patch) {
  const next = { ...load() };
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in DEFAULTS)) throw new Error("unknown setting: " + key);
    if (!valid(key, value)) throw new Error("bad value for " + key + ": " + JSON.stringify(value));
    next[key] = value;
  }
  cache = next;
  save();
  return { ...cache };
}

function save() {
  const tmp = FILE + ".tmp";
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    // A setting that cannot be written is still in effect for this session, so
    // the write failing must not fail the request.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    console.warn("[xcloud] settings write failed:", e.message);
  }
}

function reset() {
  cache = { ...DEFAULTS };
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* already gone */
  }
  return { ...cache };
}

// Test seam: the plugin never calls this.
const _reload = () => (cache = null);

module.exports = { FILE, DEFAULTS, ALLOWED, get, set, reset, _reload };
