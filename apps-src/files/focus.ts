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

// `owns` says which keys belong to the screen that is up. "Does it still exist"
// is not enough on its own: a focusable can be registered and yet be nowhere -
// a hook that must run unconditionally while its element is only rendered
// sometimes leaves a 0x0 target at the top left of the screen, which the D-pad
// will happily land on.
export function useFocusFallback(firstKey: string | undefined, owns: (key: string) => boolean) {
  // Written after the commit, never during render: a render React replays or
  // throws away would otherwise publish the screen state of a UI that never
  // existed, and the listener below reads these long after the fact.
  const key = useRef(firstKey);
  const mine = useRef(owns);
  useEffect(() => {
    key.current = firstKey;
    mine.current = owns;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!NAV_KEYS.has(e.key) || !key.current) return;
      const current = getCurrentFocusKey();
      if (current && mine.current(current) && doesFocusableExist(current)) return;
      setFocus(key.current);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
