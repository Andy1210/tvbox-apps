// Where each film was left off.
//
// One key in the app's own store (the `storage` capability, 256 kB and 200 keys
// per app), holding a map of path -> position: a key per film would spend the key
// budget on the first USB stick full of episodes. Pruned by age, so it cannot grow
// into the quota either.
//
// A position is only worth keeping in the middle of something. The first minute is
// where someone decided against a film, and the last few percent are the credits -
// offering to resume either would be worse than starting over.

const KEY = "resume";
const MIN_POSITION = 60; // seconds in: under this, "resume" means nothing
const MIN_REMAINING = 90; // seconds left: under this, it has effectively been watched
const MAX_ENTRIES = 300;

export interface ResumePoint {
  pos: number;
  dur: number;
  at: number; // epoch ms, for pruning
}

type Store = Record<string, ResumePoint>;

// The PROMISE is cached, not the value: two writes that overlap (a film ends while
// the next one is already loading) would otherwise both read the store before
// either had written, and the second would drop the first's entry.
let loading: Promise<Store> | null = null;

function load(): Promise<Store> {
  if (!loading) {
    loading = (async () => {
      try {
        const raw = await window.tvbox?.storage?.get(KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === "object" ? (parsed as Store) : {};
      } catch {
        return {}; // no store, or something else wrote nonsense into it
      }
    })();
  }
  return loading;
}

async function persist(store: Store): Promise<void> {
  const next = Promise.resolve(store);
  loading = next; // subsequent readers see this write without going back to disk
  try {
    const r = (await window.tvbox?.storage?.set(KEY, JSON.stringify(store))) as { ok?: boolean } | undefined;
    // A refused write (the app's quota) must not leave a cache that disagrees with
    // what is stored - the next read goes back to disk instead.
    if (r && r.ok === false) loading = null;
  } catch {
    loading = null;
  }
}

export async function resumePoint(path: string): Promise<ResumePoint | null> {
  const store = await load();
  const point = store[path];
  return point && typeof point.pos === "number" ? point : null;
}

// Called as playback ends (or is left): remember, or forget a film that ran out.
export async function remember(path: string, pos: number, dur: number): Promise<void> {
  try {
    const store = { ...(await load()) };
    const worth = pos >= MIN_POSITION && (!dur || dur - pos >= MIN_REMAINING);
    if (!worth) {
      if (!store[path]) return;
      delete store[path];
      return await persist(store);
    }
    store[path] = { pos: Math.floor(pos), dur: Math.floor(dur || 0), at: Date.now() };
    const keys = Object.keys(store);
    if (keys.length > MAX_ENTRIES) {
      keys
        .sort((a, b) => (store[b]?.at || 0) - (store[a]?.at || 0))
        .slice(MAX_ENTRIES)
        .forEach((k) => delete store[k]);
    }
    await persist(store);
  } catch {
    /* where a film got to is not worth failing anything else over */
  }
}
