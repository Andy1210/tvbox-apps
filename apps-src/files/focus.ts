import { useEffect, useRef } from "react";
import { doesFocusableExist, getCurrentFocusKey, setFocus } from "@noriginmedia/norigin-spatial-navigation";

// The cursor must never end up nowhere.
//
// A TV has no pointer and no tab key, so a lost focus is a dead screen: the only
// way out is Back, and on the first screen not even that. Two things here can take
// the focused row out from under the user - the source list polls (a stick pulled
// out, a share that dropped off the network) and a folder is replaced by the one
// inside it - and a focusable that unmounts while focused leaves the D-pad dead.
//
// So a press that arrives while the focus sits on something no longer on screen
// puts it back on the first row. Capture phase, because norigin's own key handler
// would otherwise act on the dead focus first.
const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"]);

export function useFocusFallback(firstKey: string | undefined) {
  const key = useRef(firstKey);
  key.current = firstKey;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!NAV_KEYS.has(e.key) || !key.current) return;
      const current = getCurrentFocusKey();
      if (current && doesFocusableExist(current)) return;
      setFocus(key.current);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
