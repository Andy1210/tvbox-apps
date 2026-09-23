#!/usr/bin/env node
// The synchronous halves of a scan, as their own process.
//
// Walking a folder and rewriting playlists is unavoidably synchronous, and a
// plugin runs inside the shell's Electron main process, where a synchronous read
// blocks the UI and every other route with it. The folder is often a network
// share, so in the main process a walk that takes seconds, or a share that stops
// answering, takes the whole box with it. So both run out here and answer on
// stdout. Usage:
//   <node> scan-cli.js inspect <folder>
//   <node> scan-cli.js finish <folder> [system]
const scan = require("./scan");

function run(argv) {
  const [cmd, folder, system] = argv;
  if (cmd === "inspect") return scan.inspect(folder || "");
  if (cmd === "finish") {
    const dir = scan.resolveFolder(folder || "");
    if (!dir) return { error: "bad_folder" };
    const opts = { system: system || "" };
    const mine = scan.addMissing(dir, opts);
    scan.foldVariants(opts);
    return mine;
  }
  return { error: "bad_command" };
}

try {
  process.stdout.write(JSON.stringify(run(process.argv.slice(2))));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: "failed", detail: String((e && e.message) || e) }));
}
