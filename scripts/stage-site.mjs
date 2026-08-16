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
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `--root <dir>`: stage a registry that lives outside this repo. See
// build-index.mjs, which takes the same option and has to be given the same one.
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = rootArg(process.argv, "usage: stage-site.mjs [--root DIR]") ?? repo;
const site = join(root, "_site");
const indexPath = join(root, "index.json");

// `--root` in both spellings, and nothing else. An ignored typo would stage the
// wrong registry - and, below, delete a directory in it.
function rootArg(argv, usage) {
  let out = null;
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
    out = resolve(v);
  }
  return out;
}

if (!existsSync(indexPath)) {
  console.error("index.json is missing - run scripts/build-index.mjs first");
  process.exit(1);
}
const index = JSON.parse(readFileSync(indexPath, "utf8"));

// `_site` is about to be deleted whole, and `_site` is also what Jekyll and
// friends call their output. Since --root points anywhere an operator types,
// "there is SOME json here" is not enough to have earned that: the file has to
// be a registry index. Measured before this - a directory holding an unrelated
// index.json lost its _site tree and the script reported success.
if (index.registryVersion !== 1 || !Array.isArray(index.apps)) {
  console.error(`${indexPath} is not a registry index (registryVersion 1 + apps[]) - refusing to stage ${site}`);
  process.exit(1);
}

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
    // copyFileSync FOLLOWS a symlink, so a link inside a package would publish
    // whatever it points at - a file from outside the repo, under an app's name.
    // build-index.mjs refuses to list one; this is the second lock on the same
    // door, because this script is what actually writes the site.
    if (lstatSync(from).isSymbolicLink()) {
      errors.push(`${id}/${f.path}: is a symlink, which is never published`);
      continue;
    }
    // The sha256 in the index is what the box verifies after downloading. If it
    // disagrees with the bytes here, the box would reject the file - better to
    // find that now than to publish a package nobody can install.
    const sha = createHash("sha256").update(readFileSync(from)).digest("hex");
    if (sha !== f.sha256) {
      // Not copied. The staging fails either way, but a half-written _site is
      // still being SERVED by a running store, and a file that disagrees with
      // the index beside it is the one state the box cannot make sense of.
      errors.push(`${id}/${f.path}: sha256 in index.json does not match the file`);
      continue;
    }
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
