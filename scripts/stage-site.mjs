#!/usr/bin/env node
// Assemble what the registry actually SERVES, into _site/ for GitHub Pages.
//
// The box fetches index.json and then, for a package app, each file the index
// names, relative to the index's own URL (`new URL("apps/<id>/", registryUrl)`
// in the shell's store.js). So the site is exactly: index.json at the root, plus
// the listed files under apps/<id>/.
//
// It copies the FILE LIST out of the index rather than the apps/ directory
// wholesale, which makes "what is published" and "what the index promises"
// the same thing by construction - a stray file cannot appear on the site
// unlisted, and a listed file that is missing fails the build here instead of
// on someone's TV. Manifest-only apps need nothing copied: their manifests
// travel inside index.json.
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(root, "_site");
const indexPath = join(root, "index.json");

if (!existsSync(indexPath)) {
  console.error("index.json is missing - run scripts/build-index.mjs first");
  process.exit(1);
}
const index = JSON.parse(readFileSync(indexPath, "utf8"));

rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });
copyFileSync(indexPath, join(site, "index.json"));

let copied = 0;
const errors = [];
for (const [id, pkg] of Object.entries(index.packages || {})) {
  for (const f of pkg.files || []) {
    const from = join(root, "apps", id, f.path);
    const to = join(site, "apps", id, f.path);
    if (!existsSync(from)) {
      errors.push(`${id}/${f.path}: listed in index.json but not on disk`);
      continue;
    }
    // The sha256 in the index is what the box verifies after downloading. If it
    // disagrees with the bytes here, the box would reject the file - better to
    // find that now than to publish a package nobody can install.
    const sha = createHash("sha256").update(readFileSync(from)).digest("hex");
    if (sha !== f.sha256) errors.push(`${id}/${f.path}: sha256 in index.json does not match the file`);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied++;
  }
}

// Pages serves this as a plain static site; nothing here is a Jekyll source, and
// a leading-underscore path would otherwise be dropped.
writeFileSync(join(site, ".nojekyll"), "");

if (errors.length) {
  console.error("cannot stage the site:\n  " + errors.join("\n  "));
  process.exit(1);
}
console.log(`_site: index.json + ${copied} package file(s) across ${Object.keys(index.packages || {}).length} package(s)`);
