import { useCallback, useEffect, useRef, type RefObject } from "react";
import { doesFocusableExist, getCurrentFocusKey, setFocus } from "@noriginmedia/norigin-spatial-navigation";

// The cursor must never end up nowhere.
//
// Spatial navigation only registers focusables; it never focuses one by itself.
// With nothing focused its key handler has no origin to navigate from and
// discards the press, and Enter does nothing either - so a screen full of
// posters simply does not respond to the remote. A connected mouse still works,
// which is exactly why this passes at a desk and fails on a sofa.
//
// Two helpers, because there are two ways to end up nowhere: nothing was ever
// focused (a screen that just finished loading), and the focused thing went away
// (a row replaced by the folder inside it, a grid cleared to reload).

/**
 * Focus `key` once, after the elements have registered.
 *
 * The timeout is not a guess: `useFocusable` registers during its own effect,
 * so a `setFocus` in a sibling effect of the same commit can run first and find
 * nothing there. `ready` gates it on the screen's data having arrived, since
 * before that the target does not exist.
 */
export function useInitialFocus(key: string | undefined, ready: boolean): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !ready || !key) return;
    done.current = true;
    const t = setTimeout(() => setFocus(key), 0);
    return () => clearTimeout(t);
  }, [key, ready]);
}

const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"]);

/**
 * Put focus back when a press arrives and the focused thing is gone.
 *
 * `owns` says which keys belong to the screen that is up: "does it still exist"
 * is not enough on its own, because a focusable can be registered and still be
 * nowhere on screen.
 *
 * Capture phase, ahead of the library's own handler, which would otherwise act
 * on the dead focus first.
 */
export function useFocusFallback(
  firstKey: string | undefined,
  owns: (key: string) => boolean,
  /** Off while another surface owns the screen. A hidden screen's fallback is
   *  still a live window listener, and it will happily pull focus back onto a
   *  button nobody can see - measured, one OK press then both paused the film
   *  and pressed the detail page's Play button behind it. */
  enabled = true,
): void {
  const key = useRef(firstKey);
  const mine = useRef(owns);
  const on = useRef(enabled);
  useEffect(() => {
    key.current = firstKey;
    mine.current = owns;
    on.current = enabled;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!on.current || !NAV_KEYS.has(e.key) || !key.current) return;
      const current = getCurrentFocusKey();
      if (current && mine.current(current) && doesFocusableExist(current)) return;
      // A key that has not mounted YET is fine to name: the library re-focuses a
      // preset key the moment that component registers (focusOnPresetKey, on by
      // default), so the cursor lands there on its own and only this one press
      // is lost. A key that will NEVER mount is the dead remote - every later
      // press aborts inside smartNavigate, silently, with only Back escaping.
      // Telling those apart needs to know whether the thing is still coming, so
      // it belongs to the caller; refusing the park here loses the recovery as
      // well as the failure.
      setFocus(key.current);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

/**
 * Bring a page's own top back into view.
 *
 * scrollIntoView can only reveal the focused element, and on a detail page
 * everything above the first focusable - the title art, the synopsis, the
 * scores - is not focusable at all. So once someone has scrolled down through
 * the cast, there is nothing to navigate back UP to: the page ends at its first
 * button. Reaching that button scrolls the whole way instead.
 */
export function useScrollToTopOnFirst(scroller: RefObject<HTMLElement | null>): () => void {
  return useCallback(() => {
    scroller.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [scroller]);
}
