#!/usr/bin/env node
// `scan.inspect` for one folder, as its own process.
//
// The inspection is unavoidably synchronous - it walks the folder and reads
// every playlist - and a plugin runs inside the SHELL'S Electron main process,
// where a synchronous read blocks the UI and every other route with it. The
// screen asks for this on each folder the cursor lands on, and the folder is
// often a network share, so in the main process a walk that takes seconds takes
// the whole box with it for those seconds.
//
// So it runs out here instead and answers on stdout. Usage:
//   <node> inspect-cli.js <folder>
const scan = require("./scan");

try {
  process.stdout.write(JSON.stringify(scan.inspect(process.argv[2] || "")));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: "inspect_failed", detail: String((e && e.message) || e) }));
}
