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
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, basename, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = join(root, "apps");

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
  const serve = m.runtime && m.runtime.serve;
  if (!["static", "remote", "local"].includes(serve)) err(f, "runtime.serve must be static|remote|local");
  if (serve === "remote" && !m.runtime.url && !m.runtime.urlConfig)
    err(f, "remote app needs runtime.url or runtime.urlConfig");
  if (m.icon && /<script|href=|xlink|url\(/i.test(m.icon)) err(f, "icon SVG must not reference external content");
  if (m.type !== "webclient") err(f, "type must be webclient");
  // Trust model: CURATED repo — every app is merge-reviewed, so it may carry a
  // `service` plugin (host-side code) or a `builtin` view. The only hard line is
  // `aptRepo`: a third-party root apt source is risky and avoidable (ship
  // binaries as no-root `requires.download`).
  if (m.requires && m.requires.aptRepo) err(f, "no aptRepo — use requires.download for binaries");
}

// Recursively list a package dir as sorted relative paths (POSIX separators, so
// the index is byte-stable and the URL joins cleanly), each with its sha256.
function packageFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
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
    const files = packageFiles(full);
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
