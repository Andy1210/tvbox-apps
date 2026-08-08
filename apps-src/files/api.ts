// What the box can play from itself, over the shell's browse API
// (tvbox shell/browse.js + shell/removable.js). The shell decides WHICH roots
// exist and refuses anything outside them; everything below is presentation.
//
// The routes are newer than some shells in the field, so every call reports
// `unsupported` rather than an error when they answer 404: an app that a box
// cannot serve has to say so on the TV, not show an empty folder list.

export interface Source {
  id: string;
  kind: "folder" | "removable" | "network";
  name: string;
  path: string | null; // null for a stick that is plugged in but not mounted
  mounted: boolean;
  device?: string; // removable only: what to mount
  fstype?: string;
  size?: number;
}

export interface SourceList {
  sources: Source[];
  removable: { supported: boolean; error: string | null };
  unsupported?: boolean; // the shell has no browse API at all
}

export interface Entry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
}

export interface Listing {
  ok: boolean;
  error?: string;
  path: string;
  name: string;
  parent: string | null;
  root: { id: string; kind: string; name: string; path: string };
  entries: Entry[];
  truncated: boolean;
}

// A shell that does not have these routes answers 404, and that is the only
// answer that means "this box cannot do this". Anything else - a 500, a socket
// that went away - is a failure to report as one, or the app tells someone their
// software is too old every time something hiccups.
const EMPTY_SOURCES: SourceList = { sources: [], removable: { supported: false, error: null }, unsupported: true };
const FAILED_SOURCES: SourceList = { sources: [], removable: { supported: false, error: "failed" } };

export async function fetchSources(): Promise<SourceList> {
  try {
    const res = await fetch("/tvbox/api/browse/sources", { cache: "no-store" });
    if (res.status === 404) return EMPTY_SOURCES;
    if (!res.ok) return FAILED_SOURCES;
    const d = await res.json();
    return { sources: d.sources || [], removable: d.removable || { supported: false, error: null } };
  } catch {
    return FAILED_SOURCES;
  }
}

export async function fetchList(path: string): Promise<Listing> {
  const empty = { path, name: "", parent: null, root: { id: "", kind: "", name: "", path: "" }, entries: [] };
  try {
    const res = await fetch("/tvbox/api/browse/list?path=" + encodeURIComponent(path), { cache: "no-store" });
    if (res.status === 404) return { ok: false, error: "unsupported", truncated: false, ...empty };
    if (!res.ok) return { ok: false, error: "failed", truncated: false, ...empty };
    return await res.json();
  } catch {
    return { ok: false, error: "unreachable", truncated: false, ...empty };
  }
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; error?: string; mountpoint?: string }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // The shell answers a refusal as JSON with its own reason (not_authorized,
    // busy, …), and that reason is what the screen should say.
    if (res.status === 404) return { ok: false, error: "unsupported" };
    try {
      return await res.json();
    } catch {
      return { ok: false, error: "failed" };
    }
  } catch {
    return { ok: false, error: "unreachable" };
  }
}

export const mountDevice = (device: string) => post("/tvbox/api/browse/mount", { device });
export const unmountDevice = (device: string) => post("/tvbox/api/browse/unmount", { device });

// One photo, as the grid and the viewer want it. Both screens work on this rather
// than on an Entry, because the two places a photo can come from - a folder on the
// box and a phone casting at it - are served by different routes and only agree on
// this shape.
export interface Photo {
  key: string;
  label: string;
  thumb: string;
  image: (width: number) => string;
}

export const photoOf = (e: Entry): Photo => ({
  key: e.path,
  label: baseName(e.name),
  thumb: thumbUrl(e),
  image: (w) => imageUrl(e, w),
});

// ------------------------------------------------- photos cast from a phone
//
// A session on the box that the phone fills and this app empties again. It is not
// a folder: it never appears among the sources, and the shell clears whatever a
// switched-off TV leaves behind. See shell/photoshare.js.

export interface Cast {
  names: string[];
  unsupported?: boolean;
}

export async function fetchCast(): Promise<Cast> {
  try {
    const res = await fetch("/tvbox/api/photoshare", { cache: "no-store" });
    if (res.status === 404) return { names: [], unsupported: true };
    if (!res.ok) return { names: [] };
    const d = await res.json();
    // Filtered to strings at the boundary rather than trusted: every one of these
    // is put through `String.replace` to build a label, and a single non-string in
    // the list would throw there instead of here.
    const names = Array.isArray(d.names) ? d.names.filter((n: unknown) => typeof n === "string") : [];
    return { names };
  } catch {
    return { names: [] };
  }
}

export const clearCast = () => post("/tvbox/api/photoshare/clear", {});

// A cast photo's name is unique within its session and its bytes never change, so
// unlike a file on disk it needs no stamp to be safely cached.
export const castThumbUrl = (name: string) => "/tvbox/api/photoshare/thumb?name=" + encodeURIComponent(name);
export const castImageUrl = (name: string, width: number) =>
  "/tvbox/api/photoshare/image?name=" + encodeURIComponent(name) + "&w=" + width;

// The four-digit prefix is the box's ordering, not a name anyone chose - what the
// person sent is what should be under the photo.
export const castPhotoOf = (name: string): Photo => ({
  key: name,
  label: baseName(name.replace(/^\d{4}-/, "")),
  thumb: castThumbUrl(name),
  image: (w) => castImageUrl(name, w),
});

export interface PairingInfo {
  url: string;
  shortUrl: string;
  code: string;
}

// The phone page the QR points at. Starting it opens a small server on the LAN,
// and MINTS A NEW CODE each time - so this belongs to the whole casting session
// and not to the screen showing the QR. Restarting it while someone's phone still
// has the page open would leave them holding a code the box no longer accepts.
// The locale is whatever the launcher is running; the pairing server defaults to
// English on its own when it is given nothing.
export const startPairing = (locale: string | null) =>
  fetch("/tvbox/api/pairing/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locale, kind: "photoshare" }),
  }).then((r) => r.json());
export const stopPairing = () => fetch("/tvbox/api/pairing/stop", { method: "POST" }).catch(() => {});

// What this app will hand to mpv. Kept as extensions rather than probing the file:
// the box has no `ffprobe` (not in the platform baseline) and a TV list has to
// appear instantly. mpv plays more than this; the list is what it is worth
// OFFERING, so a folder of subtitles and cover art reads as a folder of films.
const VIDEO = [
  "mkv",
  "mp4",
  "m4v",
  "avi",
  "mov",
  "wmv",
  "flv",
  "webm",
  "mpg",
  "mpeg",
  "m2ts",
  "ts",
  "vob",
  "ogv",
  "3gp",
  "divx",
  "iso",
];
const AUDIO = ["mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "wma", "alac", "aiff", "ape", "mka"];

// What the viewer can open. HEIC and HEIF are deliberately absent even though a
// phone folder is full of them: neither the box's ffmpeg nor its Chromium has a
// decoder, so offering them would be offering a black screen. The same list is
// enforced on the shell side (images.js) - this one decides what the UI counts.
const IMAGE = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];

export type MediaKind = "video" | "audio" | "image" | "other";

export function mediaKind(name: string): MediaKind {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "other";
  const ext = name.slice(dot + 1).toLowerCase();
  if (VIDEO.includes(ext)) return "video";
  if (AUDIO.includes(ext)) return "audio";
  if (IMAGE.includes(ext)) return "image";
  return "other";
}

// Playable is what goes to mpv, which is not the same question as viewable: a
// photo is neither played nor part of the "next episode" chain a finished film
// follows.
export const isPlayable = (e: Entry) => !e.dir && (mediaKind(e.name) === "video" || mediaKind(e.name) === "audio");
export const isViewable = (e: Entry) => !e.dir && mediaKind(e.name) === "image";

// A photo, at one of the two sizes the shell offers. `v` is the entry's mtime and
// nothing on the server reads it: it is what makes each URL's answer immutable, so
// a grid scrolling back over a tile takes it from Chromium's cache instead of
// asking the box to find it again.
const stamp = (e: Entry) => "&v=" + e.mtime;
export const thumbUrl = (e: Entry) => "/tvbox/api/browse/thumb?path=" + encodeURIComponent(e.path) + stamp(e);
export const imageUrl = (e: Entry, width: number) =>
  "/tvbox/api/browse/image?path=" + encodeURIComponent(e.path) + "&w=" + width + stamp(e);

// The name without its extension: on a 10-foot list "Film.2019.1080p" is already
// long enough without ".mkv" on the end of every row.
export function baseName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function formatSize(bytes: number): string {
  if (!bytes) return "";
  const units = ["B", "kB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)) + " " + units[i];
}

// h:mm:ss, or m:ss under an hour - what a progress bar under a film reads like.
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? h + ":" + pad(m) + ":" + pad(r) : m + ":" + pad(r);
}
