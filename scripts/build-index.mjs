#!/usr/bin/env node
// tvbox-apps index builder. Two kinds of app live under apps/:
//   • a single manifest file  apps/<id>.json         — a manifest-only app
//     (remote webclient, or a bundle fetched by its own install recipe)
//   • a package directory      apps/<id>/manifest.json — a PACKAGE app that ships
//     its own code/UI (plugin.js + web/… + pairing/…), the Kodi model
// It validates every manifest against the registry trust rules + basic sanity,
// then writes index.json: `apps` (all manifests, for the catalog) plus
// `packages` (per package-app: the file list + sha256 the box fetches +
// verifies on install). No deps — full JSON Schema validation runs in CI (ajv).
import { readFileSync, writeFileSync, readdirSync, statSync, lstatSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, basename, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// `--root <dir>` builds a registry that is NOT this repo: same layout (apps/ +
// index.json), somewhere the published site never sees. That is what keeps a
// retired app installable on a box without it standing in the official store.
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = rootArg(process.argv, "usage: build-index.mjs [--root DIR]") ?? repo;
const appsDir = join(root, "apps");

// `--root` in both spellings, and nothing else. An unrecognised flag used to be
// ignored, which meant `--root=DIR` - and any typo - quietly built THIS repo and
// exited 0: the one silent-wrong-registry outcome the option exists to prevent.
function rootArg(argv, usage) {
  let root = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    let v = null;
    if (a === "--root") v = argv[++i];
    else if (a.startsWith("--root=")) v = a.slice("--root=".length);
    else {
      console.error(`unknown arg: ${a}\n${usage}`);
      process.exit(1);
    }
    if (!v || v.startsWith("--")) {
      console.error("--root needs a directory");
      process.exit(1);
    }
    root = resolve(v);
  }
  return root;
}

// A registry with no apps/ is a mistyped --root far more often than it is an
// empty registry, and the raw ENOENT this used to throw reads as a crash.
if (!existsSync(appsDir)) {
  console.error(`no apps/ directory in ${root} - is that the registry you meant?`);
  process.exit(1);
}

const errors = [];
const err = (f, msg) => errors.push(`${f}: ${msg}`);

// Mirror of the shell's validateManifest + the registry trust rules.
function validate(m, f, id) {
  if (typeof m.id !== "string" || !/^[a-z0-9_-]+$/.test(m.id)) err(f, "id must match [a-z0-9_-]+");
  if (m.id !== id) err(f, "manifest id must equal the file/dir name");
  if ((m.manifestVersion ?? 1) !== 1) err(f, "manifestVersion must be 1");
  if (m.status !== "ready" && m.status !== "coming_soon") err(f, "status must be ready|coming_soon");
  if (!m.name) err(f, "missing name");
  if (m.accent && !/^#[0-9a-fA-F]{3,8}$/.test(m.accent)) err(f, "accent must be a hex color");
  if (m.type !== "webclient" && m.type !== "native") err(f, "type must be webclient|native");
  if (m.type === "native") {
    // A native app has no web bundle to serve; it declares how to launch its own
    // full-screen client instead. The values reach argv, so they are held to the
    // same shape the shell enforces at load and launch time.
    // Checked by TYPE, not by truthiness: `{ "bin": {} }` is truthy and would
    // otherwise sail through, and a non-array requires.flatpak would make the
    // includes() below throw instead of reporting a bad manifest.
    const nat = m.runtime && typeof m.runtime.native === "object" ? m.runtime.native : null;
    if (!nat) err(f, "type native needs a runtime.native object");
    else {
      const ref = typeof nat.flatpak === "string" ? nat.flatpak : null;
      const bin = typeof nat.bin === "string" ? nat.bin : null;
      if (nat.flatpak !== undefined && !ref) err(f, "runtime.native.flatpak must be a string");
      if (nat.bin !== undefined && !bin) err(f, "runtime.native.bin must be a string");
      if (!ref && !bin) err(f, "runtime.native needs flatpak or bin");
      if (ref && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ref)) err(f, "bad runtime.native.flatpak ref");
      if (bin && !/^(\/[\w.-]+)+$|^[\w.-]+$/.test(bin)) err(f, "bad runtime.native.bin");
      if (nat.args !== undefined && (!Array.isArray(nat.args) || nat.args.some((a) => typeof a !== "string")))
        err(f, "runtime.native.args must be an array of strings");
      const declared = m.requires && m.requires.flatpak;
      if (declared !== undefined && !Array.isArray(declared)) err(f, "requires.flatpak must be an array");
      if (ref && !(Array.isArray(declared) && declared.includes(ref)))
        err(f, "runtime.native.flatpak must also be listed in requires.flatpak (so the tile greys out until installed)");
    }
  } else {
    const serve = m.runtime && m.runtime.serve;
    if (!["static", "remote", "local"].includes(serve)) err(f, "runtime.serve must be static|remote|local");
    if (serve === "remote" && !m.runtime.url && !m.runtime.urlConfig)
      err(f, "remote app needs runtime.url or runtime.urlConfig");
  }
  if (m.icon && /<script|href=|xlink|url\(/i.test(m.icon)) err(f, "icon SVG must not reference external content");
  // Renderer bridge: always "./file.js" shipped by the package - the shell has
  // no bridges of its own. The file has to BE in the package, or a box would
  // install a manifest pointing at a bridge that never arrives.
  const bridge = m.runtime && m.runtime.bridge;
  if (bridge !== undefined) {
    if (typeof bridge !== "string" || !/^\.\/[a-z0-9_-]+\.js$/.test(bridge))
      err(f, "runtime.bridge must be ./<file>.js shipped by the package");
    else if (!existsSync(join(appsDir, id, bridge.slice(2))))
      err(f, `runtime.bridge ${bridge} is not in the package`);
  }
  if (m.pairing !== undefined) {
    // A pairing entry only makes sense with a plugin to register the provider.
    if (!Array.isArray(m.pairing) || m.pairing.length > 4) err(f, "pairing must be an array of at most 4");
    else
      for (const p of m.pairing) {
        if (!p || !/^[a-z0-9_-]{1,32}$/.test(String(p.kind || ""))) err(f, "bad pairing[].kind");
        if (!p || !p.label) err(f, "pairing[] needs a label");
      }
    if (!m.service) err(f, "pairing needs a `service` plugin to register the provider");
  }
  // Trust model: CURATED repo, every app is merge-reviewed, so it may carry a
  // `service` plugin (host-side code) or a `builtin` view. The only hard line is
  // `aptRepo`: a third-party root apt source is risky and avoidable (ship
  // binaries as no-root `requires.download`).
  if (m.requires && m.requires.aptRepo) err(f, "no aptRepo — use requires.download for binaries");
}

// What a package ships to a box, versus what only exists for development here.
// Tests never run on a box, so shipping them is pure download weight.
const NOT_SHIPPED = (name) => /\.test\.(js|cjs|mjs|ts)$/.test(name);

// Recursively list a package dir as sorted relative paths (POSIX separators, so
// the index is byte-stable and the URL joins cleanly), each with its sha256.
function packageFiles(dir, onError) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      // lstat, and a symlink is refused rather than followed. Everything listed
      // here gets copied to the published site and hashed as if it belonged to
      // the package, so a link is a way to put a file from OUTSIDE the repo (the
      // CI runner's home, say) into the registry under an app's name. A package
      // has no legitimate use for one.
      if (lstatSync(full).isSymbolicLink()) {
        onError(`${relative(appsDir, full)}: symlinks are not shipped`);
        continue;
      }
      if (statSync(full).isDirectory()) walk(full);
      else if (NOT_SHIPPED(name)) continue;
      else {
        const rel = relative(dir, full).split(sep).join("/");
        const sha256 = createHash("sha256").update(readFileSync(full)).digest("hex");
        out.push({ path: rel, sha256 });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

const apps = [];
const packages = {};
for (const entry of readdirSync(appsDir).sort()) {
  const full = join(appsDir, entry);
  // The app itself, before anything inside it. `statSync` follows a link, so a
  // symlinked package directory used to be walked, hashed and published under
  // that app's name - carrying whatever else lived beside its manifest. The
  // refusal further down only ever inspects entries INSIDE a package it has
  // already entered. Keeping a registry in sync by linking a directory is the
  // obvious thing to do with an off-git one, so this is the likely way in.
  if (lstatSync(full).isSymbolicLink()) {
    err(entry, "an app must not be a symlink");
    continue;
  }
  if (statSync(full).isDirectory()) {
    // package app: apps/<id>/manifest.json + its files
    const manifestPath = join(full, "manifest.json");
    let m;
    try {
      m = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (e) {
      err(entry + "/manifest.json", "missing or invalid JSON: " + e.message);
      continue;
    }
    validate(m, entry + "/manifest.json", entry);
    const files = packageFiles(full, (msg) => err(entry, msg));
    if (!files.some((x) => x.path === "manifest.json")) err(entry, "package must contain manifest.json");
    packages[m.id] = { files };
    apps.push(m);
  } else if (entry.endsWith(".json")) {
    // manifest-only app: apps/<id>.json
    let m;
    try {
      m = JSON.parse(readFileSync(full, "utf8"));
    } catch (e) {
      err(entry, "invalid JSON: " + e.message);
      continue;
    }
    validate(m, entry, basename(entry, ".json"));
    apps.push(m);
  }
}

if (errors.length) {
  console.error("FAILED:\n  " + errors.join("\n  "));
  process.exit(1);
}

apps.sort((a, b) => a.id.localeCompare(b.id));

// No timestamp field: index.json must be byte-stable so CI's "committed and
// current" diff only fires on real content changes. git history records when it
// changed; the box reads registryVersion + apps (+ packages for package apps).
const index = { registryVersion: 1, apps };
if (Object.keys(packages).length) index.packages = packages;
writeFileSync(join(root, "index.json"), JSON.stringify(index, null, 2) + "\n");
const pkgIds = Object.keys(packages);
console.log(
  `index.json: ${apps.length} app(s) — ${apps.map((a) => a.id).join(", ")}` +
    (pkgIds.length ? `; packages: ${pkgIds.join(", ")}` : ""),
);
