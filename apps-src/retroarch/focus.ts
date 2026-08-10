import { doesFocusableExist, getCurrentFocusKey, setFocus } from "@noriginmedia/norigin-spatial-navigation";

// The focus keys the views hand each other, and the one helper that makes handing
// over safe.
//
// Spatial navigation is geometric, and this layout gives it nothing to work with: the
// tabs sit far to the right of the first cover, the search button is a lone control
// above a wall of tiles, and the letter rail is a column of 27 tiny targets beside a
// grid. So the edges are wired explicitly. Every hop goes through `jump`, because a
// setFocus at a key that is not mounted right now leaves focus where it was - which on
// a TV means a dead button, and is exactly how the tabs became a one-way street.
export const RAIL = "rail"; // the console list on the left
export const TILES = "tiles"; // the cover grid
export const ALPHA = "alpha"; // the A-Z rail on the right
export const SEARCH = "search";
export const EMPTY_ACTION = "empty-action"; // the only thing in the view when the library is empty
export const TABS = "tab-games";
export const CONSOLES_PAGE = "consoles-page";
export const ART_PAGE = "art-page";
export const SCAN_PAGE = "scan-page";
export const FOLDERS_PAGE = "folders-page";
export const SAVES_PAGE = "saves-page";

// Is anything actually focused right now? A focus key can outlive the element it named
// (a list emptied, a view swapped), and then every arrow press goes nowhere - which on a
// TV is a dead remote, with no way to reach even the tabs.
export function focusLost(): boolean {
  const key = getCurrentFocusKey();
  return !key || !doesFocusableExist(key);
}

// Focus the first of these keys that exists. Returns what it landed on, or "" - a
// caller can then let the arrow through instead of swallowing it.
export function jump(...keys: string[]): string {
  for (const key of keys) {
    if (!key || !doesFocusableExist(key)) continue;
    setFocus(key);
    return key;
  }
  return "";
}
