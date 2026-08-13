import { doesFocusableExist, getCurrentFocusKey, setFocus } from "@noriginmedia/norigin-spatial-navigation";

// The focus keys the browser's parts hand each other, and the one helper that
// makes handing over safe.
//
// Spatial navigation is geometric, and a long list gives it nothing to work with
// sideways: the rows are one column, the index rail is a column of small targets
// beside them, and the tools sit alone above a wall of rows. So those edges are
// wired explicitly. Every hop goes through `jump`, because a setFocus at a key
// that is not mounted right now leaves focus where it was - and on a TV that is a
// dead remote. With a windowed list that is not a rare case: most of the rows are
// deliberately not mounted at any moment.
export const TABS = "br-tabs"; // liked / playlists / search
export const TOOLS = "br-tools"; // search + sort, above the list
export const ROWS = "br-rows"; // the track rows
export const RAIL = "br-rail"; // the index rail on the right

// Is anything actually focused right now? A focus key can outlive the element it
// named, and then every arrow press goes nowhere, which on a TV is a dead remote.
// A windowed list makes this a live concern rather than a corner case: most of its
// rows are deliberately not mounted, and a search that matches nothing unmounts
// the row container outright.
export function focusLost(): boolean {
  const key = getCurrentFocusKey();
  return !key || !doesFocusableExist(key);
}

// Focus the first of these keys that exists. Returns what it landed on, or "" -
// the caller can then let the arrow through instead of swallowing it.
export function jump(...keys: string[]): string {
  for (const key of keys) {
    if (!key || !doesFocusableExist(key)) continue;
    setFocus(key);
    return key;
  }
  return "";
}
