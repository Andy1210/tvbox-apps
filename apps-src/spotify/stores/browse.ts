import { create } from "zustand";
import type { ListResult, Playlist, Track } from "../api";

// What the library screen was showing, kept outside the component that shows it.
//
// Starting a track LEAVES that screen - the app switches to now-playing, which is
// what somebody who just pressed a song wants to see - and the screen was rebuilt
// from nothing on the way back: the search box empty, the results gone, the
// playlist closed. So the one press that follows a search ("that was the wrong
// song, try the next one") meant typing the query again on a D-pad.
//
// A store rather than keeping the screen mounted and hidden: a hidden subtree
// stays in the spatial-navigation tree, so every arrow press on the player would
// have somewhere invisible to go.
//
// The lists are held as they arrived, `error` and `truncated` included, because
// the screen distinguishes "no rows" from "we could not ask" and rebuilding that
// from a bare array would lose it.
export type BrowseTab = "liked" | "playlists" | "search";

export interface SearchResults {
  tracks: Track[];
  playlists: Playlist[];
}

interface BrowseStore {
  tab: BrowseTab;
  liked: ListResult<Track> | null;
  playlists: ListResult<Playlist> | null;
  /** The playlist whose tracks are open, if one is. */
  openPl: Playlist | null;
  plTracks: ListResult<Track> | null;
  results: SearchResults | null;
  query: string;
  /** The row an open playlist was entered from, so Back returns to it. */
  cameFrom: string;
  /**
   * Whose library these rows are.
   *
   * The box follows whichever linked account casts to it, and that can change
   * with nobody touching this screen - so the rows have to be dropped rather
   * than relabelled: pressing one would send that account's context to the new
   * owner's player, which refuses it.
   */
  shownFor: string | undefined;

  set(patch: Partial<Omit<BrowseStore, "set" | "forgetLists">>): void;
  /**
   * Everything that was read from an account. The tab and the query survive -
   * they are what the person typed, not what the account answered - but
   * `cameFrom` does not: it names a ROW in a list that is being dropped, and
   * the next account's list can have a row with the same key.
   */
  forgetLists(): void;
}

export const useBrowse = create<BrowseStore>((set) => ({
  tab: "liked",
  liked: null,
  playlists: null,
  openPl: null,
  plTracks: null,
  results: null,
  query: "",
  cameFrom: "",
  shownFor: undefined,

  set: (patch) => set(patch),
  forgetLists: () => set({ liked: null, playlists: null, openPl: null, plTracks: null, results: null, cameFrom: "" }),
}));
