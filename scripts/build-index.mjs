#!/usr/bin/env node
// tvbox-apps index builder: validates every apps/*.json against the registry
// trust rules + basic manifest sanity, then writes index.json (the single
// file boxes fetch). No dependencies — full JSON Schema validation runs in CI
// with ajv against the schema in the main tvbox repo.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appsDir = join(root, "apps");

const errors = [];
const err = (f, msg) => errors.push(`${f}: ${msg}`);

const apps = [];
for (const f of readdirSync(appsDir).sort()) {
  if (!f.endsWith(".json")) continue;
  let m;
  try {
    m = JSON.parse(readFileSync(join(appsDir, f), "utf8"));
  } catch (e) {
    err(f, "invalid JSON: " + e.message);
    continue;
  }

  // basic manifest sanity (mirror of the shell's validateManifest)
  if (typeof m.id !== "string" || !/^[a-z0-9_-]+$/.test(m.id)) err(f, "id must match [a-z0-9_-]+");
  if (m.id !== basename(f, ".json")) err(f, "filename must equal id");
  if ((m.manifestVersion ?? 1) !== 1) err(f, "manifestVersion must be 1");
  if (m.status !== "ready" && m.status !== "coming_soon") err(f, "status must be ready|coming_soon");
  if (!m.name) err(f, "missing name");
  if (m.accent && !/^#[0-9a-fA-F]{3,8}$/.test(m.accent)) err(f, "accent must be a hex color");
  const serve = m.runtime && m.runtime.serve;
  if (!["static", "remote"].includes(serve)) err(f, "runtime.serve must be static|remote");
  if (serve === "remote" && !m.runtime.url && !m.runtime.urlConfig)
    err(f, "remote app needs runtime.url or runtime.urlConfig");
  if (m.icon && /<script|href=|xlink|url\(/i.test(m.icon)) err(f, "icon SVG must not reference external content");

  // trust rules — the store distributes MANIFEST-ONLY apps (see README)
  if (m.type !== "webclient") err(f, "store apps must be type webclient");
  if (m.service) err(f, "store apps must not declare a service plugin");
  if (m.requires && m.requires.aptRepo) err(f, "store apps must not add apt repos");

  apps.push(m);
}

if (errors.length) {
  console.error("FAILED:\n  " + errors.join("\n  "));
  process.exit(1);
}

// No timestamp field: index.json must be byte-stable so CI's "committed and
// current" diff only fires on real content changes (a wall-clock generatedAt
// made every run look stale). git history already records when it changed, and
// the box ignores everything but registryVersion + apps.
const index = { registryVersion: 1, apps };
writeFileSync(join(root, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.log(`index.json: ${apps.length} app(s) — ${apps.map((a) => a.id).join(", ")}`);
