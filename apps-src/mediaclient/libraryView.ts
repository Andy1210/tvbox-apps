import type { LibraryView } from "./LibraryFilters";

/**
 * How each library was left.
 *
 * The library screen is unmounted whenever something is opened from it - a
 * film, an episode, a collection - because `MediaClient` renders one screen at
 * a time. So an order somebody chose lived only until they opened anything, and
 * Back returned them to an alphabetical list at the top. Measured from the
 * sofa: films by release date, open a collection, Back, and the grid is
 * alphabetical again with the button reading nothing.
 *
 * Kept in a module rather than in the app store because it is screen state, not
 * session state - but it is CLEARED with the session, since a filter label
 * carries a genre or an age rating and the next person to sign in is not
 * necessarily the same person.
 */
const kept = new Map<string, LibraryState>();

export interface LibraryState {
  view: LibraryView;
  mode: "items" | "collections";
  /** The film view, if the library was left inside its collections. */
  saved: LibraryView | null;
}

export function recallLibraryView(libraryId: string): LibraryState | undefined {
  return kept.get(libraryId);
}

export function rememberLibraryView(libraryId: string, state: LibraryState): void {
  kept.set(libraryId, state);
}

/** Forgotten on sign-out and on a profile switch. */
export function clearLibraryViews(): void {
  kept.clear();
}
