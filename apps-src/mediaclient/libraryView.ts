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

/**
 * Where the cursor was standing when the library was last left.
 *
 * Both numbers, because a cell alone does not say where the grid sat under it:
 * a row can be at the top of the screen or at the bottom of it, and putting it
 * back in the wrong place is a jump on a screen nobody asked to move.
 *
 * Kept apart from the view above so one clear covers both, and so a screen that
 * writes one does not have to carry the other.
 */
export interface LibraryCursor {
  /** The grid cell the cursor was on. */
  index: number;
  /** What the moving layer was translated to, in px. */
  offset: number;
}

const cursors = new Map<string, LibraryCursor>();

export function recallLibraryView(libraryId: string): LibraryState | undefined {
  return kept.get(libraryId);
}

export function rememberLibraryView(libraryId: string, state: LibraryState): void {
  kept.set(libraryId, state);
}

export function recallLibraryCursor(libraryId: string): LibraryCursor | undefined {
  return cursors.get(libraryId);
}

export function rememberLibraryCursor(libraryId: string, at: LibraryCursor): void {
  cursors.set(libraryId, at);
}

/**
 * Forget where the cursor was.
 *
 * For a list that is no longer the same list: a new order, filter or mode
 * renumbers everything, so the cell an index names is a different title.
 */
export function forgetLibraryCursor(libraryId: string): void {
  cursors.delete(libraryId);
}

/**
 * Everything this module holds, forgotten on sign-out and on a profile switch.
 *
 * Both maps, and anything added beside them: a filter label carries a genre or
 * an age rating, and a cursor is a record of what somebody was looking at. This
 * box is shared, so the boundary is the session rather than the window.
 */
export function clearLibraryViews(): void {
  kept.clear();
  cursors.clear();
}
