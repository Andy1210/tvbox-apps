// What the box can play from itself, over the shell's browse API
// (tvbox shell/browse.js + shell/removable.js). The shell decides WHICH roots
// exist and refuses anything outside them; everything below is presentation.
//
// The routes are newer than some shells in the field, so every call reports
// `unsupported` rather than an error when they answer 404: an app that a box
// cannot serve has to say so on the TV, not show an empty folder list.

export interface Source {
  id: string;
  kind: "folder" | "removable";
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

const EMPTY_SOURCES: SourceList = { sources: [], removable: { supported: false, error: null }, unsupported: true };

export async function fetchSources(): Promise<SourceList> {
  try {
    const res = await fetch("/tvbox/api/browse/sources", { cache: "no-store" });
    if (!res.ok) return EMPTY_SOURCES;
    const d = await res.json();
    return { sources: d.sources || [], removable: d.removable || { supported: false, error: null } };
  } catch {
    return EMPTY_SOURCES;
  }
}

export async function fetchList(path: string): Promise<Listing> {
  const empty = { path, name: "", parent: null, root: { id: "", kind: "", name: "", path: "" }, entries: [] };
  try {
    const res = await fetch("/tvbox/api/browse/list?path=" + encodeURIComponent(path), { cache: "no-store" });
    if (!res.ok) return { ok: false, error: "unsupported", truncated: false, ...empty };
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
    if (!res.ok) return { ok: false, error: "unsupported" };
    return await res.json();
  } catch {
    return { ok: false, error: "unreachable" };
  }
}

export const mountDevice = (device: string) => post("/tvbox/api/browse/mount", { device });
export const unmountDevice = (device: string) => post("/tvbox/api/browse/unmount", { device });

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

export type MediaKind = "video" | "audio" | "other";

export function mediaKind(name: string): MediaKind {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "other";
  const ext = name.slice(dot + 1).toLowerCase();
  if (VIDEO.includes(ext)) return "video";
  if (AUDIO.includes(ext)) return "audio";
  return "other";
}

export const isPlayable = (e: Entry) => !e.dir && mediaKind(e.name) !== "other";

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
