#!/usr/bin/env node
// Serve this repo as a registry a box can actually install from.
//
// The published site is built by build-index.mjs + stage-site.mjs, and a box
// fetches index.json and then the package files relative to it. That is the
// whole contract, so a static server over _site/ IS a registry: add its address
// in Settings -> Apps -> Store sources on a box and the apps in this checkout
// appear next to the official ones, without publishing anything.
//
//   npm run store:serve                 # build, stage, serve on 0.0.0.0:8790
//   npm run store:serve -- --watch      # rebuild the index when a manifest changes
//   npm run store:serve -- --port 9000
//
// It binds to every interface on purpose: the box has to reach it by LAN
// address, and the box refuses plain http to anything that is not a LAN address,
// which is exactly the line this stays on.
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync, watch } from "node:fs";
import { join, dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(root, "_site");

let port = 8790;
let doWatch = false;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--watch") doWatch = true;
  else if (a === "--port") {
    // A port that silently falls back to the default is worse than no port at
    // all: the address printed below is the one typed into a box, and it would
    // be the wrong one.
    const v = Number(process.argv[++i]);
    if (!Number.isInteger(v) || v < 1 || v > 65535) {
      console.error("--port needs a number between 1 and 65535");
      process.exit(1);
    }
    port = v;
  } else {
    console.error("unknown arg: " + a);
    process.exit(1);
  }
}

function build() {
  // The same two scripts CI runs, in the same order: what is served here is what
  // would be published, rather than a second idea of it.
  execFileSync(process.execPath, [join(root, "scripts", "build-index.mjs")], { stdio: "inherit" });
  execFileSync(process.execPath, [join(root, "scripts", "stage-site.mjs")], { stdio: "inherit" });
}

const TYPES = {
  ".json": "application/json",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function serveFile(res, path) {
  const body = readFileSync(path);
  res.writeHead(200, {
    "Content-Type": TYPES[extname(path)] || "application/octet-stream",
    "Content-Length": body.length,
    // A dev registry is edited constantly and its files are fetched by hash-free
    // URLs, so a cached index.json would serve yesterday's app list on the box.
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const server = createServer((req, res) => {
  // decodeURIComponent throws on a malformed escape (a bare "%" is enough), and
  // an exception here is thrown out of the request handler, which ends the
  // process. A dev registry that a stray request can kill is a dev registry that
  // is down when the box asks.
  let at;
  try {
    at = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch (e) {
    res.writeHead(400);
    return res.end("bad path");
  }
  // A path is checked as a REAL path against the site root: the served tree holds
  // whatever an app package ships, and "starts with the root string" would accept
  // a sibling directory that merely shares the prefix.
  const target = resolve(join(site, at === "/" ? "index.json" : at));
  if (target !== resolve(site) && !target.startsWith(resolve(site) + sep)) {
    res.writeHead(403);
    return res.end("no");
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404);
    return res.end("not found");
  }
  try {
    serveFile(res, target);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e.message || e));
  }
});

build();
server.listen(port, "0.0.0.0", () => {
  const addrs = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal)
    .map((n) => n.address);
  console.log("\nregistry served from " + site);
  console.log("add this in Settings -> Apps -> Store sources:\n");
  for (const a of addrs.length ? addrs : ["<this machine's LAN address>"]) {
    console.log("    http://" + a + ":" + port + "/index.json");
  }
  console.log("");
});

if (doWatch) {
  // Manifests only. An app's web/ UI is built by its own `npm run build:<id>`,
  // and running vite on every keystroke here would hide which build produced
  // what the box then installed.
  let timer = null;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        build();
        console.log("[serve-store] rebuilt");
      } catch (e) {
        console.error("[serve-store] build failed:", e.message);
      }
    }, 300);
  };
  // Recursive watching reached Linux in Node 20.13; before that it throws here
  // rather than quietly watching nothing, so the fallback is one watcher per
  // package directory. Either way a manifest change is seen.
  const appsDir = join(root, "apps");
  try {
    watch(appsDir, { recursive: true }, rebuild);
  } catch (e) {
    watch(appsDir, rebuild);
    for (const n of readdirSync(appsDir, { withFileTypes: true })) {
      if (n.isDirectory()) watch(join(appsDir, n.name), rebuild);
    }
  }
  console.log("[serve-store] watching apps/ for changes");
}
