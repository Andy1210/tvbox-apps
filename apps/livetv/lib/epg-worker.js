// Runs epg.parse off the shell's main thread; see provider.js.
const { parentPort, workerData } = require("worker_threads");
const epg = require("./epg");

parentPort.postMessage(epg.parse(workerData.xml, workerData.lo, workerData.hi));
