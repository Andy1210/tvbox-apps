// Boxart for the games in RetroArch's playlists, fetched by the box.
//
// Why the box does it: RetroArch shows artwork ONLY for playlist entries (never in
// the file browser), and it looks for it at exactly
//
//   thumbnails/<playlist name>/Named_Boxarts/<entry label>.png
//
// with nothing of its own to put there. Its own "Download thumbnails" belongs to
// the same Online Updater machinery whose Core Downloader starts no network request
// at all in this build, so a console added from the box (lib/cores.js) would give a
// list of names and no pictures. libretro publishes the images at
// thumbnails.libretro.com, so this walks each playlist and puts them in place.
//
// The server has a plain directory index per system, which is what makes this cheap
// and exact: ONE request lists every boxart that exists for a console, so a label
// with no artwork upstream is known to be absent instead of being discovered as a
// 404 on every pass. That listing is also what lets a label be matched loosely -
// see matcher() - which is the difference between artwork for a No-Intro library
// and artwork for anyone's library.
//
// A pass skips what is already on disk, so it is resumable and re-running it is
// nearly free; the index for a system is re-listed only when its playlist changed
// or the last look is old (RECHECK_MS), so a box that is up to date does no
// network at all.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const FLATPAK_REF = "org.libretro.RetroArch";
const RA_DIR = path.join(os.homedir(), ".var", "app", FLATPAK_REF, "config", "retroarch");
const PLAYLISTS_DIR = path.join(RA_DIR, "playlists");
const THUMBS_DIR = path.join(RA_DIR, "thumbnails");
// What has been listed and when. Only bookkeeping: the images on disk are the
// truth, so losing this file costs one extra listing per console.
const STATE_FILE = path.join(os.homedir(), ".tvbox", "retroarch-art.json");
const BASE_URL = "https://thumbnails.libretro.com/";
// Boxart only. Snaps and title screens are the same size again each, and the box
// shows a cover - in RetroArch (menu_thumbnails) and, later, in its own grid.
const KIND = "Named_Boxarts";
const RECHECK_MS = 14 * 24 * 3600 * 1000; // how stale a listing may get before a re-look
const INDEX_TIMEOUT_MS = 90000; // the biggest listing is a few MB of HTML
const DOWNLOAD_TIMEOUT_MS = 120000; // per batch, not per file
const BATCH = 12; // files per curl process: one connection, kept alive
const PARALLEL = 4; // ... of which this many at a time
const MAX_NAME_LEN = 200;
const PART_SUFFIX = ".part";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// RetroArch's own rule for turning an entry label into a file name
// (gfx_thumbnail_path.c): these characters become an underscore. The name we save
// under has to be scrubbed identically or RetroArch will not find the file - and
// the server stores its files the same way, verified against its listing (a label
// with "&" is stored with "_").
const SCRUB = /[&*/:`"<>?\\|]/g;
function scrubLabel(label) {
  return typeof label === "string" ? label.replace(SCRUB, "_") : "";
}

// A console name is a directory, an entry label is a file name in it. Both come
// out of a playlist file, so both are checked rather than trusted.
function nameOk(s) {
  if (typeof s !== "string" || !s || s.length > MAX_NAME_LEN) return false;
  if (s.startsWith(".") || s.endsWith(PART_SUFFIX)) return false;
  return !/[/\\]/.test(s) && !s.includes("..");
}

// Cleanup that must not be able to take the pass with it. Both callers run inside
// an execFile callback, where a throw does NOT reject the promise it sits in - it
// escapes as an uncaught exception in the shell's own process and leaves the pass
// waiting on a promise nothing will ever resolve.
function rmQuiet(target, opts) {
  try {
    fs.rmSync(target, opts);
  } catch (e) {
    /* best-effort: a leftover temp file is not worth a wedged sweep */
  }
}

function boxartDir(system) {
  return path.join(THUMBS_DIR, system, KIND);
}
function boxartPath(system, scrubbed) {
  if (!nameOk(system) || !nameOk(scrubbed)) return "";
  const dir = boxartDir(system);
  const p = path.join(dir, scrubbed + ".png");
  return p.startsWith(dir + path.sep) ? p : "";
}

// ---- what the box has ----

// Every playlist, as console -> the labels in it. An entry's `db_name` wins over
// the file it sits in: that is the console RetroArch itself resolves artwork
// against, so the favourites and history playlists contribute their games to the
// right console instead of to a playlist of their own.
function playlists() {
  let files = [];
  try {
    files = fs.readdirSync(PLAYLISTS_DIR).filter((f) => f.endsWith(".lpl"));
  } catch (e) {
    return []; // RetroArch has never run, or has no playlists yet
  }
  const bySystem = new Map();
  for (const f of files.sort()) {
    let doc = null;
    let mtimeMs = 0;
    try {
      const p = path.join(PLAYLISTS_DIR, f);
      mtimeMs = fs.statSync(p).mtimeMs;
      doc = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      continue; // unparsable or half-written playlist: skipped, not fatal
    }
    if (!doc || !Array.isArray(doc.items)) continue;
    const fallback = f.slice(0, -4);
    for (const item of doc.items) {
      const system = String(item && item.db_name ? item.db_name : fallback).replace(/\.lpl$/, "");
      // RetroArch's own playlists (content_history, content_favorites, ...) name no
      // console, so an entry that carries no db_name in one of them has nothing to
      // look artwork up under.
      if (!nameOk(system) || system.startsWith("content_")) continue;
      const label = scrubLabel(item && item.label);
      if (!nameOk(label)) continue;
      if (!bySystem.has(system)) bySystem.set(system, { labels: new Set(), mtimeMs: 0 });
      const entry = bySystem.get(system);
      entry.labels.add(label);
      entry.mtimeMs = Math.max(entry.mtimeMs, mtimeMs);
    }
  }
  const out = [...bySystem.entries()].map(([system, e]) => ({
    system,
    labels: [...e.labels].sort(),
    mtimeMs: e.mtimeMs,
  }));
  return out.sort((a, b) => a.system.localeCompare(b.system));
}

// The boxarts already on disk for one console. Read as a directory listing rather
// than a stat per game: a console has hundreds of entries and this is called
// whenever the phone page refreshes.
function localNames(system) {
  const out = new Set();
  let files = [];
  try {
    files = fs.readdirSync(boxartDir(system));
  } catch (e) {
    return out;
  }
  for (const f of files) if (f.endsWith(".png")) out.add(f.slice(0, -4));
  return out;
}

// Per console: how many games it has and how many of them have a cover. Purely
// local - the phone page polls this while a pass runs.
function status() {
  const state = readState();
  return playlists().map(({ system, labels }) => {
    const have = localNames(system);
    const missing = labels.filter((l) => !have.has(l));
    const st = state.systems[system] || {};
    return {
      system,
      total: labels.length,
      have: labels.length - missing.length,
      missing: missing.length,
      // Of the missing ones, how many the server simply has no cover for. Only
      // known after a listing, so null until then.
      unavailable: typeof st.unavailable === "number" ? st.unavailable : null,
      checkedAt: st.checkedAt || null,
    };
  });
}

// ---- matching a playlist label to a file on the server ----

// Everything outside (brackets), reduced to letters and digits: the comparison key
// for a loose match. It absorbs the differences between ROM naming conventions -
// a publisher group the server does not use ("Zelda II ... (Nintendo) (USA)"), a
// missing region tag, and spacing or punctuation ("WildSnake" / "Wild Snake").
function titleKey(s) {
  return String(s)
    .replace(/[([][^)\]]*[)\]]/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}
// The bracketed tokens: region, languages, publisher, revision.
function tagsOf(s) {
  const out = new Set();
  for (const m of String(s).matchAll(/[([]([^)\]]*)[)\]]/g)) {
    for (const part of m[1].split(",")) {
      const v = part.trim().toLowerCase();
      if (v) out.add(v);
    }
  }
  return out;
}

// A lookup over one console's listing: label -> the file name on the server, or
// null. Three steps, in order of how much they assume:
//
//   1. the same name (a No-Intro library, which is the common case)
//   2. the same name in different case ("SEGA Smash Pack" / "Sega Smash Pack")
//   3. the same TITLE, best variant (see titleKey) - the step that covers a
//      library named by another convention
//
// Step 3 picks between the variants of one game rather than between games, so the
// risk it carries is the wrong region's cover, not the wrong cover: prefer the
// variant sharing the most tags with the label, then a clean No-Intro name over a
// [hacked]/[bad dump] one, then the fewest tags, then the name itself so the choice
// is stable.
function matcher(names) {
  const exact = new Set(names);
  const ci = new Map();
  const byTitle = new Map();
  for (const n of names) {
    const lower = n.toLowerCase();
    if (!ci.has(lower)) ci.set(lower, n);
    const key = titleKey(n);
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(n);
  }
  return (label) => {
    if (exact.has(label)) return label;
    const hit = ci.get(label.toLowerCase());
    if (hit) return hit;
    const cands = byTitle.get(titleKey(label));
    if (!cands || !cands.length) return null;
    const want = tagsOf(label);
    let best = null;
    for (const n of cands) {
      const tags = tagsOf(n);
      let shared = 0;
      for (const t of tags) if (want.has(t)) shared++;
      const score = shared * 10 - (n.match(/\[/g) || []).length * 5 - tags.size;
      if (!best || score > best.score || (score === best.score && n < best.name)) best = { name: n, score };
    }
    return best.name;
  };
}

// ---- the server ----

function systemUrl(system) {
  return BASE_URL + encodeURIComponent(system) + "/" + KIND + "/";
}

// The file names in one console's directory listing. Apache writes one <a href>
// per file, URL-encoded, plus its own sort links (which carry a query and are
// skipped).
function parseIndex(html) {
  const out = [];
  for (const m of String(html).matchAll(/<a href="([^"?][^"]*)">/g)) {
    let name;
    try {
      name = decodeURIComponent(m[1]);
    } catch (e) {
      continue; // not a name we could ask for again
    }
    if (!name.endsWith(".png")) continue;
    name = name.slice(0, -4);
    if (nameOk(name)) out.push(name);
  }
  return out;
}

// List one console. Resolves { ok, names } or { ok: false, error }, telling apart a
// console the server does not carry (`not_found` - remembered, so it is not asked
// for again on the next pass) from no network (`offline` - worth retrying).
function fetchIndex(system, env) {
  return new Promise((resolve) => {
    if (!nameOk(system)) return resolve({ ok: false, error: "bad_system" });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tvbox-art-"));
    const tmp = path.join(dir, "index.html");
    execFile(
      "curl",
      [
        "-sSL",
        "--proto",
        "=https",
        "--max-time",
        String(Math.round(INDEX_TIMEOUT_MS / 1000)),
        "-o",
        tmp,
        "-w",
        "%{http_code}",
        systemUrl(system),
      ],
      { env, timeout: INDEX_TIMEOUT_MS },
      (err, stdout) => {
        const code = String(stdout || "").trim();
        let html = "";
        try {
          html = fs.readFileSync(tmp, "utf8");
        } catch (e) {
          /* nothing arrived */
        }
        rmQuiet(dir, { recursive: true, force: true });
        if (err && code !== "200") return resolve({ ok: false, error: "offline" });
        if (code === "404") return resolve({ ok: false, error: "not_found" });
        if (code !== "200") return resolve({ ok: false, error: "offline" });
        const names = parseIndex(html);
        // A 200 that lists nothing is a page we did not understand, not an empty
        // console: treating it as "no artwork exists" would write that down.
        if (!names.length) return resolve({ ok: false, error: "empty_index" });
        resolve({ ok: true, names });
      },
    );
  });
}

// Only a real PNG lands. The server answering something else (a proxy's error
// page, a truncated body) would otherwise become a file RetroArch tries to draw.
function isPng(p) {
  let fd = null;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(PNG_MAGIC.length);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return n === buf.length && buf.equals(PNG_MAGIC);
  } catch (e) {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (e) {
        /* already gone */
      }
    }
  }
}

// Fetch a handful of covers in one curl process: one TLS connection for the batch,
// a few transfers at a time. Each file is written next to its destination as
// `<name>.png.part` and renamed only once it is a PNG, so an interrupted pass
// leaves nothing RetroArch would pick up.
function downloadBatch(system, jobs, env) {
  return new Promise((resolve) => {
    const args = ["-sS", "-f", "-L", "--proto", "=https", "-Z", "--parallel-max", String(PARALLEL)];
    const staged = [];
    for (const job of jobs) {
      const dst = boxartPath(system, job.saveAs);
      if (!dst) continue;
      staged.push({ dst, part: dst + PART_SUFFIX, saveAs: job.saveAs });
      args.push(
        "-o",
        dst + PART_SUFFIX,
        BASE_URL + encodeURIComponent(system) + "/" + KIND + "/" + encodeURIComponent(job.remote) + ".png",
      );
    }
    if (!staged.length) return resolve({ saved: 0, failed: 0 });
    try {
      fs.mkdirSync(boxartDir(system), { recursive: true });
    } catch (e) {
      return resolve({ saved: 0, failed: staged.length, error: "write_failed" });
    }
    // curl's exit status covers the whole batch, so it is not what decides: each
    // file is judged on its own, and one bad name in a batch costs only that name.
    execFile("curl", args, { env, timeout: DOWNLOAD_TIMEOUT_MS }, () => {
      let saved = 0;
      let failed = 0;
      for (const s of staged) {
        if (isPng(s.part)) {
          try {
            fs.renameSync(s.part, s.dst);
            saved++;
            continue;
          } catch (e) {
            /* falls through to the cleanup below */
          }
        }
        failed++;
        rmQuiet(s.part, { force: true });
      }
      resolve({ saved, failed });
    });
  });
}

// ---- bookkeeping ----

function readState() {
  try {
    const doc = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (doc && typeof doc === "object" && doc.systems && typeof doc.systems === "object") return doc;
  } catch (e) {
    /* no state yet, or unreadable: start over */
  }
  return { systems: {} };
}
function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    return true;
  } catch (e) {
    return false;
  }
}

// Which failure to list a console is an ANSWER about that console, and which is
// only a failure to ask. Remembering the second kind would read as "no covers exist
// here" for a fortnight because a listing arrived truncated once.
function listingIsAnswer(error) {
  return error === "not_found"; // the server carries nothing for this console
}

// Whether a console with missing covers is worth listing again. Without this a
// library whose last few games simply have no artwork upstream would re-download
// the whole listing on every pass, forever.
function dueForListing(st, mtimeMs, now) {
  if (!st || !st.checkedAt) return true;
  if (mtimeMs > st.checkedAt) return true; // the playlist changed: new games
  return now - st.checkedAt > RECHECK_MS; // artwork is added upstream over time
}

// ---- a pass ----

// Walk every console and fetch what is missing.
//
// `force` is the phone's "download now": it lists even a console that was looked at
// recently, and keeps going while the box is busy. An automatic pass does neither -
// it stops the moment something else needs the box, and picks up where it left off
// on the next one (nothing is written down mid-console because the files on disk
// already are the progress).
async function sweep({ env, force, idle, log, onProgress, stopped } = {}) {
  const say = typeof log === "function" ? log : () => {};
  const busy = () => (typeof stopped === "function" && stopped()) || (!force && typeof idle === "function" && !idle());
  const state = readState();
  const now = Date.now();
  const systems = playlists();
  const result = { systems: 0, saved: 0, failed: 0, unavailable: 0, stopped: false, offline: false };
  const progress = (extra) => {
    if (typeof onProgress === "function") onProgress({ ...result, ...extra });
  };

  for (const { system, labels, mtimeMs } of systems) {
    if (busy()) {
      result.stopped = true;
      break;
    }
    const have = localNames(system);
    const missing = labels.filter((l) => !have.has(l));
    if (!missing.length) continue;
    const st = state.systems[system];
    if (!dueForListing(st, mtimeMs, now)) continue;
    progress({ system, listing: true });
    const index = await fetchIndex(system, env);
    if (!index.ok) {
      if (index.error === "offline") {
        // No network: the rest of the consoles would fail the same way.
        result.offline = true;
        say("artwork: no network, stopping");
        break;
      }
      say("artwork: " + system + ": " + index.error);
      // Only an answer is remembered; a listing we could not read leaves the console
      // unchecked, so the next pass asks again.
      if (listingIsAnswer(index.error)) {
        state.systems[system] = { checkedAt: now, unavailable: missing.length };
        writeState(state);
      }
      continue;
    }
    const match = matcher(index.names);
    const jobs = [];
    for (const label of missing) {
      const remote = match(label);
      if (remote) jobs.push({ remote, saveAs: label });
    }
    const unavailable = missing.length - jobs.length;
    result.systems++;
    result.unavailable += unavailable;
    say("artwork: " + system + ": " + jobs.length + " to fetch, " + unavailable + " with no cover upstream");
    let done = 0;
    let failed = 0;
    let interrupted = false;
    for (let i = 0; i < jobs.length; i += BATCH) {
      if (busy()) {
        result.stopped = true;
        interrupted = true;
        break;
      }
      const batch = jobs.slice(i, i + BATCH);
      const r = await downloadBatch(system, batch, env);
      result.saved += r.saved;
      result.failed += r.failed;
      failed += r.failed;
      done += batch.length;
      progress({ system, done, todo: jobs.length });
    }
    if (interrupted) break;
    // A console counts as checked only when it was walked to the end AND nothing
    // failed on the way: writing it down is what stops the next pass from listing
    // it, and a cover lost to one bad transfer should come back on the next pass
    // rather than in a fortnight when the listing goes stale by itself.
    if (failed) {
      say("artwork: " + system + ": " + failed + " did not arrive, will try again");
      continue;
    }
    state.systems[system] = { checkedAt: now, unavailable };
    writeState(state);
  }
  progress({ system: null, done: 0, todo: 0 });
  return result;
}

module.exports = {
  PLAYLISTS_DIR,
  THUMBS_DIR,
  STATE_FILE,
  KIND,
  RECHECK_MS,
  BATCH,
  scrubLabel,
  nameOk,
  boxartDir,
  boxartPath,
  playlists,
  localNames,
  status,
  titleKey,
  tagsOf,
  matcher,
  systemUrl,
  parseIndex,
  fetchIndex,
  isPng,
  downloadBatch,
  readState,
  writeState,
  listingIsAnswer,
  dueForListing,
  sweep,
};
