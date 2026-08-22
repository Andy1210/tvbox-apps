// The words to the song on screen, from LRCLIB.
//
// LRCLIB is a free, no-key lyrics database looked up by track metadata - which
// is all a media server gives us, and is why it works for a library no lyrics
// service has ever catalogued. The Spotify app on this box asks the same service
// through its own host plugin; here the request goes straight out of the page,
// because this app already talks to a media server cross-origin and LRCLIB
// answers `Access-Control-Allow-Origin: *`. No headers are set on it for the
// same reason: a custom User-Agent would turn a simple GET into a preflight, and
// Chromium refuses to send that header anyway.

import { log } from "../redact";

export interface LyricLine {
  ms: number;
  text: string;
}

export interface Lyrics {
  /** Time-tagged lines, when the database has them - the karaoke view. */
  synced: LyricLine[];
  plain: string;
  instrumental: boolean;
}

export interface LyricsQuery {
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
}

const EMPTY: Lyrics = { synced: [], plain: "", instrumental: false };
/** A song's words do not change, so one answer per track lasts the evening. */
const cache = new Map<string, Lyrics>();
/** Bounded, because a long shuffle would otherwise hold every song it passed. */
const CACHE_MAX = 200;
/** LRCLIB is somebody else's free service; a slow answer is not worth a wait. */
const TIMEOUT_MS = 8000;
/**
 * How much of an answer is worth drawing.
 *
 * A song has a few dozen lines. These are the bounds on somebody else's server
 * having a bad day, or on a fork of it somebody points this at: `parseLrc` mints
 * one element per stamped line, and a page that tries to draw a hundred thousand
 * of them is a media app nobody can get out of.
 */
const MAX_LINES = 400;
const MAX_PLAIN_CHARS = 20000;
/** How far two lengths may differ and still be the same recording. */
const DURATION_SLACK_S = 7;

interface LrclibRow {
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

/**
 * `[mm:ss.xx] text`, with a line allowed to carry several stamps.
 *
 * Sorted at the end rather than trusted: a file that repeats a chorus lists its
 * stamps together, so the lines arrive out of order and the view walks them in
 * order to decide which one is current.
 */
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const line of String(lrc || "").split("\n")) {
    const text = line.replace(/\[\d+:\d+(?:\.\d+)?\]/g, "").trim();
    for (const stamp of line.match(/\[(\d+):(\d+(?:\.\d+)?)\]/g) ?? []) {
      const m = /\[(\d+):(\d+(?:\.\d+)?)\]/.exec(stamp);
      if (m) out.push({ ms: Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000), text });
    }
  }
  return out.sort((a, b) => a.ms - b.ms);
}

function toLyrics(row: LrclibRow | null): Lyrics {
  if (!row) return EMPTY;
  if (row.instrumental) return { synced: [], plain: "", instrumental: true };
  const synced = parseLrc(row.syncedLyrics ?? "").slice(0, MAX_LINES);
  const plain = String(row.plainLyrics ?? "")
    .slice(0, MAX_PLAIN_CHARS)
    .trim();
  if (!synced.length && !plain) return EMPTY;
  return { synced, plain, instrumental: false };
}

/** The answer came back and said no. Distinguished from "we could not ask". */
const NO_ROW = Symbol("no lyrics row");

async function getJson(url: string): Promise<unknown> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
  try {
    // No referrer: the default would tell LRCLIB which page asked, which is the
    // box's own address and none of their business. `no-store` so a song's words
    // are not left in the app's HTTP cache either.
    const r = await fetch(url, { signal: stop.signal, cache: "no-store", referrerPolicy: "no-referrer" });
    // A 404 is an ANSWER - this database does not have the song - and anything
    // else is the question failing. They must not be cached the same way: one
    // bad moment on the network would otherwise mean "no lyrics for this track"
    // for the rest of the evening, with no way to ask again from a remote.
    if (r.status === 404) return NO_ROW;
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    log.warn("lyrics lookup failed", e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Which of several search hits is this recording.
 *
 * Length first, because it is the only thing here that is a fact about the file
 * rather than about how somebody typed the title; then a preference for an entry
 * that carries timings, since a synced answer is the one worth having.
 */
function best(rows: LrclibRow[], wantSec: number): LrclibRow | null {
  let pick: LrclibRow | null = null;
  let pickScore = Infinity;
  for (const row of rows) {
    const closeEnough = wantSec > 0 && Math.abs((row.duration ?? 0) - wantSec) <= DURATION_SLACK_S;
    const score = (closeEnough ? 0 : 100) + (row.syncedLyrics ? 0 : 10);
    if (score < pickScore) {
      pick = row;
      pickScore = score;
    }
  }
  return pick;
}

/**
 * The words for one track, or nothing.
 *
 * Two questions, because `/api/get` is an EXACT match on all four fields and an
 * album string is the one a library and a lyrics database disagree about most
 * (a single against a soundtrack, a deluxe edition) - so a very well known song
 * misses on the strict lookup and is found by the loose one.
 *
 * Never throws: no lyrics is an ordinary answer here, and the screen says so.
 */
export async function fetchLyrics(q: LyricsQuery): Promise<Lyrics> {
  const title = (q.title ?? "").trim();
  const artist = (q.artist ?? "").trim();
  if (!title || !artist) return EMPTY;
  const durSec = Math.round((q.durationMs ?? 0) / 1000);
  const key = `${artist}|${title}|${durSec}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const exact = new URLSearchParams({ track_name: title, artist_name: artist });
  if (q.album) exact.set("album_name", q.album);
  if (durSec > 0) exact.set("duration", String(durSec));
  const strict = await getJson("https://lrclib.net/api/get?" + exact.toString());
  // `null` is the only value that means the question failed. A 404 on the exact
  // match is an ANSWER, but not a final one - it is why the loose search exists -
  // so the two are tracked separately. Treating a 404 as "we asked" was enough to
  // cache the miss even when the search that follows it never answered: measured
  // on the box, one bad moment gave "no lyrics for this song" for the rest of the
  // session, with no way to ask again from a remote.
  let answered = strict !== null && strict !== NO_ROW;
  let row = strict === NO_ROW ? null : (strict as LrclibRow | null);

  if (!row) {
    const loose = new URLSearchParams({ track_name: title, artist_name: artist });
    const list = await getJson("https://lrclib.net/api/search?" + loose.toString());
    answered = list !== null;
    row = Array.isArray(list) && list.length ? best(list as LrclibRow[], durSec) : null;
  }

  const out = toLyrics(row);
  // Only a real answer is remembered. A timeout or an offline box is not "this
  // song has no words", and caching it as one is permanent from the sofa.
  if (answered) {
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, out);
  }
  return out;
}

/** Forget everything. Tests only. */
export function __resetLyricsCache(): void {
  cache.clear();
}
