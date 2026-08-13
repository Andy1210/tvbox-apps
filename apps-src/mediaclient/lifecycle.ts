// Releasing server-side state when the app stops being visible.
//
// THE SHELL SENDS NO TEARDOWN SIGNAL. Leaving an app via Home calls the shell's
// own stopMpv, which removes mpv's exit listeners first precisely so its kill is
// not reported as `finished` - so no player event reaches this page. And app
// windows are hidden rather than destroyed, so the page keeps living with its
// timers merely throttled. There is no onExit hook to hang cleanup on.
//
// That matters because several things we own live OUTSIDE this page and do not
// expire on their own: a media server's transcode session stays open (measured:
// still alive a minute after the last keepalive, and only an explicit stop
// clears it), the server's session list keeps reporting us as playing, and the
// retained now-playing we published stays "playing" - which also holds the box's
// auto-update idle gate open.
//
// So cleanup hangs on the page lifecycle events that DO fire when a window is
// hidden. `visibilitychange` is the normal path; `pagehide` covers a teardown
// that skips it. Both may fire, so handlers must be idempotent.
//
// A hidden window can still be killed outright, and nothing runs then. Anything
// that must not leak therefore ALSO needs a reconciliation pass at startup -
// see `onResume` consumers, which re-check server-side state rather than trust
// that release() ran.

export type ReleaseFn = (reason: ReleaseReason) => void;
export type ReleaseReason = "hidden" | "pagehide";

const releasers = new Set<ReleaseFn>();
const resumers = new Set<() => void>();
let releasedFor: ReleaseReason | null = null;

/**
 * Register work that must happen when the app stops being visible: flushing a
 * final progress report, stopping a transcode session, publishing an idle
 * now-playing. Handlers must be synchronous-ish and idempotent - the page may be
 * frozen immediately after, so a promise chain is not guaranteed to continue.
 *
 * Returns an unregister function.
 */
export function onRelease(fn: ReleaseFn): () => void {
  releasers.add(fn);
  return () => releasers.delete(fn);
}

/**
 * Register work for when the app becomes visible again. This is where state that
 * may have leaked (because the window was killed while hidden) gets reconciled
 * against the server, rather than assumed clean.
 */
export function onResume(fn: () => void): () => void {
  resumers.add(fn);
  return () => resumers.delete(fn);
}

function release(reason: ReleaseReason): void {
  if (releasedFor) return; // already torn down; both events can fire
  releasedFor = reason;
  for (const fn of releasers) {
    try {
      fn(reason);
    } catch {
      // One failing releaser must not strand the others - a leaked transcode
      // session is worse than a lost progress report.
    }
  }
}

function resume(): void {
  if (!releasedFor) return;
  releasedFor = null;
  for (const fn of resumers) {
    try {
      fn();
    } catch {
      /* a failed reconcile retries on the next resume */
    }
  }
}

/** Wire the page lifecycle events. Idempotent; safe to call once from main. */
export function installLifecycle(): void {
  if (typeof document === "undefined") return;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") release("hidden");
    else resume();
  });
  window.addEventListener("pagehide", () => release("pagehide"));
}

/** Test seam: drive the transitions without dispatching real events. */
export const __lifecycle = {
  release,
  resume,
  reset(): void {
    releasers.clear();
    resumers.clear();
    releasedFor = null;
  },
  get released(): ReleaseReason | null {
    return releasedFor;
  },
};
