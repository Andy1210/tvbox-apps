import { describe, it, beforeEach, vi } from "vitest";
import { PlexBackend } from "../backends/plex/backend";
import type { Session } from "../backends/types";

const BASE = process.env.PLEX_URL;
const TOKEN = process.env.PLEX_TOKEN;

const session: Session = {
  profileId: "probe",
  profileName: "probe",
  token: TOKEN ?? "",
  serverId: "probe",
  serverName: "probe",
  baseUrl: BASE ?? "",
  location: "lan",
};
const id = { clientId: "mediaclient-probe", deviceName: "probe" };

describe.skipIf(!BASE || !TOKEN)("probe", () => {
  beforeEach(() => vi.unstubAllGlobals());
  const backend = (): PlexBackend => new PlexBackend(session, id);

  it("labels every multi-version item", async () => {
    const b = backend();
    const ids = (process.env.PROBE_IDS ?? "").split(",").filter(Boolean);
    const dupes: string[] = [];
    for (const rk of ids) {
      const d = await b.item(rk);
      const labels = d.versions.map((v) => v.label);
      const uniq = new Set(labels).size === labels.length;
      const empty = labels.some((l) => !l || l === "?");
      const flag = !uniq ? "DUP " : empty ? "BAD " : "    ";
      console.log(`${flag}${rk} ${d.title} :: ${labels.map((l) => JSON.stringify(l)).join(" | ")}`);
      console.log(
        `      parts=${d.versions.map((v) => v.partId).join(",")} sizes=${d.versions.map((v) => v.sizeBytes).join(",")} dur=${d.versions.map((v) => v.durationMs).join(",")}`,
      );
      if (!uniq || empty) dupes.push(`${rk} ${d.title}: ${labels.join(" / ")}`);
    }
    console.log("PROBLEM LABELS:\n" + dupes.join("\n"));
  }, 600_000);

  it("checks mediaIndex picks the nth version", async () => {
    const b = backend();
    const ids = (process.env.PROBE_STREAM_IDS ?? "").split(",").filter(Boolean);
    for (const rk of ids) {
      const d = await b.item(rk);
      console.log(`--- ${rk} ${d.title} versions=${d.versions.length}`);
      for (let n = 0; n < d.versions.length; n++) {
        const s = `probe-${rk}-${n}-${Date.now()}`;
        try {
          const dec = await b.resolveStream(rk, { session: s, version: n });
          console.log(`  v${n} transcoded=${dec.transcoded} url=${dec.url.slice(0, 160).replace(/X-Plex-Token=[^&]*/, "X-Plex-Token=REDACTED")}`);
        } catch (e) {
          console.log(`  v${n} FAILED ${(e as Error).message}`);
        } finally {
          await b.endSession(s).catch(() => {});
        }
      }
    }
  }, 600_000);
});
