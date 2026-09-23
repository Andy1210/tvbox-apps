// Parsing an XMLTV guide: no I/O and no state, so it can run on a worker thread
// (epg-worker.js) as well as inline.

function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

// Standard XMLTV datetime -> epoch SECONDS. Format is "YYYYMMDDHHMMSS ±HHMM"
// (the trailing timezone offset is optional; absent = UTC), e.g.
// "20240101060000 +0100". Returns 0 if unparseable. The wall-clock is
// interpreted in the stated offset: epoch = UTC(wall) - offset.
function parseXmltvTime(s) {
  const m = /^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/.exec(String(s || ""));
  if (!m) return 0;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  if (!m[7]) return Math.floor(wall); // no offset -> treat as UTC
  const offset = (Number(m[8]) * 60 + Number(m[9])) * 60 * (m[7] === "-" ? -1 : 1);
  return Math.floor(wall - offset);
}

// { channelId: [{ title, start, stop }, ...] } sorted by start, for programmes
// overlapping [lo, hi] (epoch seconds). Keyed by the channel's epg id (tvg-id /
// epg_channel_id).
function parse(xml, lo, hi) {
  const progs = {};
  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const chm = /channel="([^"]*)"/.exec(attrs);
    if (!chm || !chm[1]) continue;
    // Two guide shapes: Xtream's xmltv.php extension (start_timestamp/stop_timestamp
    // as epoch seconds) and standard XMLTV (start="YYYYMMDDHHMMSS ±HHMM"). Prefer
    // the Xtream epoch when present, else parse the standard datetime form.
    let start = Number((/start_timestamp="(\d+)"/.exec(attrs) || [])[1] || 0);
    let stop = Number((/stop_timestamp="(\d+)"/.exec(attrs) || [])[1] || 0);
    if (!start) start = parseXmltvTime((/\bstart="([^"]+)"/.exec(attrs) || [])[1] || "");
    if (!stop) stop = parseXmltvTime((/\bstop="([^"]+)"/.exec(attrs) || [])[1] || "");
    if (!start || !stop || stop < lo || start > hi) continue;
    const tm = /<title[^>]*>([\s\S]*?)<\/title>/.exec(m[2]);
    const title = tm ? decodeEntities(tm[1]).trim() : "";
    (progs[chm[1]] || (progs[chm[1]] = [])).push({ title, start, stop });
  }
  for (const ch in progs) progs[ch].sort((a, b) => a.start - b.start);
  return progs;
}

module.exports = { parse, parseXmltvTime, decodeEntities };
