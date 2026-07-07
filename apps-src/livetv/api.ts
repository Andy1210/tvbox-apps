// Live TV data — served by the shell from ~/.tvbox/iptv.conf (Xtream API, with
// M3U fallback). The launcher only consumes these endpoints.
export interface Channel {
  id: string;
  name: string;
  logo: string;
  group: string;
  url: string;
  epgId?: string;
  order?: number;
}

export interface EpgEntry {
  title: string;
  description: string;
  start: string;
  end: string;
}

export interface ChannelGroup {
  group: string;
  channels: Channel[];
}

export async function fetchChannels(): Promise<{ channels: Channel[]; error?: string }> {
  try {
    const res = await fetch("/tvbox/api/livetv/channels", { cache: "no-store" });
    const data = await res.json();
    return { channels: data.channels || [], error: data.error };
  } catch (e) {
    return { channels: [], error: String(e) };
  }
}

export async function fetchEpg(id: string): Promise<EpgEntry[]> {
  try {
    const res = await fetch("/tvbox/api/livetv/epg?id=" + encodeURIComponent(id), { cache: "no-store" });
    const data = await res.json();
    return data.epg || [];
  } catch {
    return [];
  }
}

// Group channels by category, preserving first-seen order.
export function groupChannels(channels: Channel[]): ChannelGroup[] {
  const order: string[] = [];
  const map = new Map<string, Channel[]>();
  for (const c of channels) {
    let list = map.get(c.group);
    if (!list) {
      list = [];
      map.set(c.group, list);
      order.push(c.group);
    }
    list.push(c);
  }
  return order.map((g) => ({ group: g, channels: map.get(g)! }));
}

// "HH:MM" from an Xtream "YYYY-MM-DD HH:MM:SS" timestamp.
export function hhmm(ts: string): string {
  const m = /\d{4}-\d{2}-\d{2} (\d{2}:\d{2})/.exec(ts || "");
  return m ? m[1] : "";
}

// ---- now/next for all channels (XMLTV-derived; epoch seconds) ----
export interface NowNextEntry {
  title: string;
  start: number;
  stop: number;
}
export interface NowNext {
  now: NowNextEntry | null;
  next: NowNextEntry | null;
}

export async function fetchNowNext(): Promise<Record<string, NowNext>> {
  try {
    const res = await fetch("/tvbox/api/livetv/nownext", { cache: "no-store" });
    const data = await res.json();
    return data.nownext || {};
  } catch {
    return {};
  }
}

// Fraction [0..1] of how far the current programme has progressed.
export function progress(now?: NowNextEntry | null): number {
  if (!now || !now.start || !now.stop || now.stop <= now.start) return 0;
  const t = Date.now() / 1000;
  return Math.max(0, Math.min(1, (t - now.start) / (now.stop - now.start)));
}

// "HH:MM" from an epoch-seconds timestamp, in the given locale.
export function hhmmEpoch(sec: number, tag: string): string {
  if (!sec) return "";
  return new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" }).format(new Date(sec * 1000));
}

// ---- EPG guide grid (programmes per channel epg id, within [from,to)) ----
export interface GuideProg {
  title: string;
  start: number;
  stop: number;
}
export interface Guide {
  guide: Record<string, GuideProg[]>;
  from: number;
  to: number;
  now: number;
}

export async function fetchGuide(): Promise<Guide> {
  const now = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch("/tvbox/api/livetv/guide", { cache: "no-store" });
    return (await res.json()) as Guide;
  } catch {
    return { guide: {}, from: now - 1800, to: now + 6 * 3600, now };
  }
}
