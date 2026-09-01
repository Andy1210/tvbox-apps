import { useEffect, useRef, useState } from "react";
import { FocusContext, getCurrentFocusKey, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, useFocusableItem, FocusButton, Osk } from "@sdk";
import {
  fetchLiked,
  fetchPlaylists,
  fetchPlaylistItems,
  search,
  play,
  control,
  mmss,
  URIS_MAX,
  type Track,
  type Playlist,
  type ListResult,
} from "./api";
import { TrackList } from "./TrackList";
import { useBrowse, type BrowseTab } from "./stores/browse";
import { ROWS, TABS, TOOLS, focusLost, jump } from "./focus";

function Row({
  fk,
  image,
  title,
  sub,
  right,
  onEnter,
}: {
  fk: string;
  image?: string;
  title: string;
  sub?: string;
  right?: string;
  onEnter: () => void;
}) {
  return (
    <FocusButton
      focusKey={fk}
      onEnter={onEnter}
      className="px-[1.5vw] py-[1.1vh] rounded-[1vh] bg-white/5 flex items-center gap-[1.2vw]"
    >
      {image !== undefined &&
        (image ? (
          <img src={image} alt="" decoding="async" className="w-[5vh] h-[5vh] rounded-[0.6vh] object-cover shrink-0" />
        ) : (
          <div className="w-[5vh] h-[5vh] rounded-[0.6vh] bg-white/10 shrink-0" />
        ))}
      <div className="min-w-0 flex-1 text-left">
        <div className="text-[2.1vh] truncate">{title}</div>
        {sub && <div className="text-[1.6vh] opacity-60 truncate">{sub}</div>}
      </div>
      {right && <div className="text-[1.6vh] opacity-60 tabular-nums shrink-0">{right}</div>}
    </FocusButton>
  );
}

// Account browser (shown only when connected). Liked Songs and own-playlist
// tracks are fully browsable; any playlist can be played whole; search finds
// tracks/playlists. Selecting plays on the box and returns to now-playing.
// Map a Web API error to actionable copy: the common trap is a Development
// Mode Spotify app without this account in its User Management list (403).
function apiErrorText(t: (k: string, p?: Record<string, string>) => string, error: string): string {
  if (/not registered/i.test(error)) return t("spotify.notRegistered");
  if (error === "network") return t("spotify.apiUnreachable");
  // A long list is read many pages at a time, so Spotify's rate limit is a normal
  // thing to meet. Raw JSON on a television is not an error message.
  if (/HTTP 429/.test(error)) return t("spotify.rateLimited");
  return t("spotify.apiError", { error });
}

// Why a play did nothing. Its own exported function because there are THREE call
// sites - a row, "play all"/"shuffle all", and the voice request in Spotify.tsx -
// and a mapping that lives inside one of them is a mapping the other two do not
// have: measured, the two most prominent Play buttons on the screen still put a
// raw `box_unreachable` on the television.
//
// The fall-through takes no interpolation. The codes that reach it include
// `HTTP <status> <80 characters of Spotify's JSON body>`, which is the ugliest
// thing this app could put in front of a sofa; the code belongs in the console,
// where whoever is debugging can read it.
export function playErrorText(t: (k: string, p?: Record<string, string>) => string, error: string, log = true): string {
  const keys: Record<string, string> = {
    box_not_found: "spotify.boxNotFound",
    box_signed_out: "spotify.boxSignedOut",
    recovery_failed: "spotify.recoveryFailed",
    recovery_cooling: "spotify.recoveryCooling",
    box_unreachable: "spotify.boxUnreachable",
    box_lookup_failed: "spotify.lookupFailed",
    box_other_account: "spotify.otherAccount",
    connect_off: "spotify.connectOff",
    in_use: "spotify.inUse",
    "not connected": "spotify.notConnected",
  };
  const key = keys[error];
  if (key) return t(key);
  if (log) console.warn("[spotify] play failed:", error);
  return t("spotify.playError");
}

// Whose Spotify session the music started in, when it was not the account being
// browsed. Its own exported function for the same reason playErrorText is: there
// are three call sites (a row, play-all, and the voice request in Spotify.tsx),
// and one of them is in another file.
//
// The browsed account's own name may be missing - it is resolved from Spotify and
// a box whose /me never answered has none - and a sentence with a hole in it is
// worse than a shorter one, so that case gets its own wording rather than an empty
// interpolation.
export function startedAsText(
  t: (k: string, p?: Record<string, string>) => string,
  startedAs: string,
  mine: string,
): string {
  if (!startedAs) return "";
  return mine
    ? t("spotify.startedAsOther", { name: startedAs, mine })
    : t("spotify.startedAsOtherPlain", { name: startedAs });
}

// The playlist position of a row. Falls back to the row index for a list that
// carries no positions (search results, or a box whose shell predates them),
// where the two are the same thing anyway.
function posOf(tracks: Track[], i: number): number {
  const p = tracks[i]?.pos;
  return typeof p === "number" ? p : i;
}

// Inline SVG, not a glyph: the box's Chromium has no font covering the arrow
// symbols outside the basic blocks, so one would render as tofu on the TV. The
// play triangle has a glyph that does render, but the two sit side by side and a
// drawn icon next to a text character do not match.
function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-[1.8vh] h-[1.8vh] inline-block align-[-0.2vh]">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
function ShuffleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="w-[1.8vh] h-[1.8vh] inline-block align-[-0.2vh]">
      <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" />
    </svg>
  );
}

// An action in the tools row of an open playlist (play all / shuffle all). Its own
// component so the arrow wiring matches the other controls that live there.
function Action({
  fk,
  onEnter,
  primary,
  children,
}: {
  fk: string;
  onEnter: () => void;
  primary?: boolean;
  children: React.ReactNode;
}) {
  const { ref, focused } = useFocusableItem(
    {
      focusKey: fk,
      onEnterPress: onEnter,
      onArrowPress: (dir) => {
        if (dir === "up") return !jump(TABS);
        if (dir === "down") return !jump(ROWS);
        return true;
      },
    },
    { block: "nearest" },
  );
  return (
    <div
      ref={ref}
      onClick={onEnter}
      className={[
        "px-[1.4vw] py-[0.8vh] rounded-[1vh] text-[1.7vh] font-bold shrink-0",
        focused ? "bg-white text-[#06090d]" : primary ? "bg-[#1DB954] text-[#06120b]" : "bg-white/10",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

// `account` is whose library this is. It is shown because it can change without
// anybody choosing it here: the box follows whichever linked account is casting
// to it, so the Liked Songs on this screen can be the other person's, and until
// the name was on it nothing said so.
export function Browser({
  onBack,
  onPlayed,
  onNote,
  account,
}: {
  onBack: () => void;
  onPlayed: () => void;
  /**
   * Something the player screen has to say: whose Spotify session the music
   * actually started in, when it was not this account's. Its own channel rather
   * than a payload on `onPlayed`, and delivered before this screen decides where
   * to go, because the two are not the same event - somebody who presses Back
   * during the wait still ends up on the player screen, with the music playing in
   * a session nothing would otherwise have named. `""` clears a note left over
   * from an earlier press.
   */
  onNote: (note: string) => void;
  account?: string;
}) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "sp-browser" });
  // Held outside this component, so starting a track and coming back does not
  // rebuild the screen from nothing - see stores/browse.ts.
  const tab = useBrowse((s) => s.tab);
  const liked = useBrowse((s) => s.liked);
  const playlists = useBrowse((s) => s.playlists);
  const openPl = useBrowse((s) => s.openPl);
  const plTracks = useBrowse((s) => s.plTracks);
  const results = useBrowse((s) => s.results);
  const query = useBrowse((s) => s.query);
  const remember = useBrowse((s) => s.set);
  const setTab = (v: BrowseTab): void => remember({ tab: v });
  const setLiked = (v: ListResult<Track> | null): void => remember({ liked: v });
  const setPlaylists = (v: ListResult<Playlist> | null): void => remember({ playlists: v });
  const setOpenPl = (v: Playlist | null): void => remember({ openPl: v });
  const setPlTracks = (v: ListResult<Track> | null): void => remember({ plTracks: v });
  const setResults = (v: { tracks: Track[]; playlists: Playlist[] } | null): void => remember({ results: v });
  const setQuery = (v: string): void => remember({ query: v });
  const [osk, setOsk] = useState(false);
  const [err, setErr] = useState("");
  // A press that has to sign the box back in costs a poll loop on the box, so
  // this can run to ~20s. "A few seconds" was measured wrong and it matters:
  // told that, a person starts pressing things at eight.
  const [starting, setStarting] = useState(false);
  const [slow, setSlow] = useState(false); // the wait has outlived a normal start
  const wanted = useRef(""); // the playlist whose read is still worth showing (see openPlaylist)

  // A play that is still in flight when this screen goes. It can be twenty
  // seconds behind by the time it answers, and calling onBack's navigation from a
  // component that has unmounted moves a screen nobody is on.
  //
  // Only UNMOUNT counts, not Back out of a playlist. Backing out is not "I did
  // not mean that": the music does start, so the honest thing is still to show
  // the player - suppressing that left a song playing in the room with nothing on
  // screen saying what, which is worse than the late navigation it was meant to
  // avoid. The same goes for a failure: if this screen is still up, it says so.
  const gone = useRef(false);
  useEffect(
    () => () => {
      gone.current = true;
    },
    [],
  );

  // Back: out of a playlist -> playlist list; otherwise leave the browser.
  useBackspace(() => {
    setErr(""); // a message about a playlist they have just left is noise on the list
    if (openPl) {
      wanted.current = ""; // whatever that playlist's read answers, it is no longer wanted
      setOpenPl(null);
      setPlTracks(null);
    } else onBack();
  }, !osk);

  // Long enough to read an answer to a wait that can itself be twenty seconds:
  // the longest of these carries an instruction ("Kösd be a fiókod a
  // Fiókoknál"), and at six seconds a glance away lost it with no way back
  // except pressing play and waiting again.
  useEffect(() => {
    if (!err) return;
    const id = setTimeout(() => setErr(""), 12000);
    return () => clearTimeout(id);
  }, [err]);
  // Say the long case out loud rather than letting the short label sit there for
  // twenty seconds looking stuck. Four seconds: signing the box in as another
  // account costs three to five, so at five the message could arrive as the music
  // started, and much earlier it is a flicker in a box that is about to change.
  // The case that really needs the line is a saved login that turns out to be
  // stale, which takes about ten.
  useEffect(() => {
    if (!starting) {
      setSlow(false);
      return;
    }
    const id = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(id);
  }, [starting]);
  // The box changed hands while this screen was up, so these rows belong to
  // somebody else's library now. Dropped rather than relabelled: the header would
  // otherwise name one account over another's tracks, and pressing one of them
  // sends that account's context to the new owner's player, which refuses it.
  useEffect(() => {
    const store = useBrowse.getState();
    if (store.shownFor === account) return;
    wanted.current = "";
    store.forgetLists();
    store.set({ shownFor: account });
  }, [account]);
  useEffect(() => {
    if (tab === "liked" && liked === null) fetchLiked().then(setLiked);
  }, [tab, liked]);
  useEffect(() => {
    if (tab === "playlists" && playlists === null) fetchPlaylists().then(setPlaylists);
  }, [tab, playlists]);

  // Where focus lands when the view changes. `jump` rather than setFocus: an open
  // playlist has no rows until its tracks arrive, and a setFocus at a key that is
  // not mounted leaves focus nowhere at all.
  // Leaving a playlist returns to the row it was opened from, rather than to the
  // top of the list: with forty playlists, landing on the tab means walking back
  // down every time. It no longer depends on the tracks arriving, because the two
  // actions are outside the track list now - so a slow read cannot move focus.
  useEffect(() => {
    const id = setTimeout(() => {
      if (openPl) {
        // The row first, when there is one to come back to - coming back from
        // the player into an open playlist should land where the press was.
        // `jump` walks on if the key is not mounted, so a stale one costs
        // nothing and the old behaviour is the fallback.
        jump(useBrowse.getState().cameFrom, "br-pt-all", "br-tab-playlists");
        return; // the row to come back to is still needed
      }
      jump(useBrowse.getState().cameFrom, "br-tab-" + tab);
      remember({ cameFrom: "" });
    }, 0);
    return () => clearTimeout(id);
  }, [tab, openPl]);

  // The net under all of it. A focus key can outlive the element it named, and
  // then no arrow goes anywhere, which on a TV is a remote that has stopped
  // working with no way back to even the tabs. Most of this view's focusables are
  // rows that mount and unmount as the window moves, so the check runs after every
  // render that could have changed what exists.
  useEffect(() => {
    const id = setTimeout(() => {
      if (focusLost()) jump(ROWS, TOOLS, "br-tab-" + tab, TABS);
    }, 60);
    return () => clearTimeout(id);
  });

  const playAndGo = async (body: { contextUri?: string; uris?: string[]; offset?: number; collection?: boolean }) => {
    if (starting) return; // one request at a time (signing the box back in takes a while)
    setStarting(true);
    setErr("");
    const r = await play(body);
    setStarting(false);
    // Before the `gone` check: see `onNote`. A press that FAILED reports too, with
    // nothing - or the sentence from an earlier press stands over the next song.
    onNote(r.ok ? startedAsText(t, r.startedAs || "", account || "") : "");
    if (gone.current) return; // this screen is gone; nothing to show or navigate
    if (r.ok) {
      // The row that was pressed, so Back from the player lands on it rather
      // than on the tab: "that was the wrong song, try the next one" is the
      // press this whole return path exists for, and it cost several more.
      // Read here rather than passed down: every list on this screen has its own
      // key scheme, and the focused one is the one that was just pressed.
      remember({ cameFrom: getCurrentFocusKey() || "" });
      onPlayed();
      return;
    }
    // Surface why nothing played instead of silently returning.
    setErr(playErrorText(t, r.error || ""));
  };

  // Shuffle is a setting on the ACTIVE player, and there is no active player until
  // something is playing - so both of these start playback first and set it after.
  // "Play all" has to turn it OFF for the same reason it is a setting: it persists,
  // so without this, every later Play all would still be shuffled.
  const startAll = async (p: Playlist, shuffle: boolean, at: number) => {
    if (starting) return;
    setStarting(true);
    setErr("");
    const r = await play({ contextUri: p.uri, ...(at > 0 ? { offset: at } : {}) });
    onNote(r.ok ? startedAsText(t, r.startedAs || "", account || "") : "");
    if (!r.ok) {
      setStarting(false);
      if (gone.current) return;
      setErr(playErrorText(t, r.error || ""));
      return;
    }
    // A refused shuffle would otherwise be invisible: playback started, so the
    // screen would say nothing while the order is the opposite of what was asked.
    const err = await control("shuffle", shuffle);
    setStarting(false);
    if (gone.current) return; // the music is playing; this screen just is not here to say so
    if (err) {
      setErr(/not registered|HTTP 403/i.test(err) ? t("spotify.notRegistered") : t("spotify.shuffleFailed"));
      return;
    }
    onPlayed();
  };
  const playAll = (p: Playlist) => startAll(p, false, 0);
  // A random ROW, and then that row's playlist position: picking a number up to
  // the row count would never reach the tail of a playlist that has entries we
  // could not resolve, because those are missing from the rows but not from the
  // playlist. With no rows at all (someone else's playlist) the context still
  // shuffles, it just starts at the top.
  const shuffleAll = (p: Playlist, tracks: Track[]) =>
    startAll(p, true, tracks.length ? posOf(tracks, Math.floor(Math.random() * tracks.length)) : 0);

  // A cold read of a thousand tracks takes seconds, which is long enough to leave
  // the playlist and open another one. The answer to an abandoned request must be
  // dropped: it would otherwise draw A's rows under B's name, and a row's position
  // is then an index into the WRONG playlist, so pressing it plays a different
  // track with nothing to say so.
  const openPlaylist = async (p: Playlist, rowKey: string) => {
    wanted.current = p.id;
    remember({ cameFrom: rowKey });
    setOpenPl(p);
    setPlTracks(null);
    const r = await fetchPlaylistItems(p.id);
    if (wanted.current === p.id) setPlTracks(r);
  };

  const [searching, setSearching] = useState(false);
  const runSearch = async (q: string) => {
    setQuery(q);
    setOsk(false);
    setResults(null);
    if (!q.trim()) return;
    setSearching(true);
    const r = await search(q.trim());
    setSearching(false);
    setResults(r);
  };

  if (osk) {
    return <Osk title={t("spotify.searchPrompt")} initial={query} onDone={runSearch} onCancel={() => setOsk(false)} />;
  }

  const tabBtn = (id: BrowseTab, label: string) => (
    <TabButton
      key={id}
      id={id}
      label={label}
      active={tab === id}
      onPick={() => {
        setTab(id);
        setOpenPl(null);
      }}
    />
  );

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="relative h-full flex flex-col px-[4vw] py-[3vh] min-h-0">
        {/* Anchored to the bottom rather than placed above the tabs, the way the
            player screen already does it: in the column each of these is about a
            row tall, so one failed press moved the tabs, the play buttons and
            every row four times - spinner in, spinner out, message in, message
            out - under a focus the person was still using. The list is
            overflow-y-auto and keeps its scrollTop, so the rows really did jump.
            On its own backdrop for the same reason as there: it sits over the
            list. */}
        {(err || starting) && (
          <div className="absolute bottom-[3vh] left-[4vw] right-[4vw] z-30 pointer-events-none">
            {err && (
              <div className="px-[2vw] py-[1.4vh] rounded-[1vh] bg-red-950/95 text-[1.9vh] text-red-100">{err}</div>
            )}
            {starting && !err && (
              <div className="px-[2vw] py-[1.4vh] rounded-[1vh] bg-neutral-900/95 text-[1.9vh] flex items-center gap-[1vw]">
                <div className="w-[2.2vh] h-[2.2vh] rounded-full border-[0.35vh] border-white/25 border-t-white animate-spin shrink-0" />
                {slow ? `${t("spotify.starting")} ${t("spotify.startingSlow")}` : t("spotify.starting")}
              </div>
            )}
          </div>
        )}
        <Tabs>
          {tabBtn("liked", t("spotify.liked"))}
          {tabBtn("playlists", t("spotify.playlists"))}
          {tabBtn("search", t("spotify.search"))}
          {openPl && <div className="text-[1.9vh] text-fg-dim truncate ml-[1vw] self-center">· {openPl.name}</div>}
          {account && (
            <div className="text-[1.8vh] text-fg-dim truncate ml-auto self-center max-w-[26vw]">{account}</div>
          )}
        </Tabs>

        {/* LIKED */}
        {tab === "liked" &&
          (liked === null ? (
            <Spinner t={t("spotify.loadingLiked")} />
          ) : liked.error ? (
            <Empty t={apiErrorText(t, liked.error)} />
          ) : (
            <>
              {liked.truncated && <Truncated t={t("spotify.truncated")} />}
              <TrackList
                tracks={liked.items}
                emptyText={t("spotify.emptyList")}
                // Liked Songs is a context of its own, so playing from the middle
                // of it is the real library from that track on. The uris go along
                // as the fallback: that context is undocumented, and the box falls
                // back to them if Spotify refuses it.
                onPlay={(i) =>
                  playAndGo({
                    collection: true,
                    offset: posOf(liked.items, i),
                    uris: liked.items.slice(i, i + URIS_MAX).map((x) => x.uri),
                  })
                }
              />
            </>
          ))}

        {/* PLAYLISTS: the list, or one playlist's tracks */}
        {tab === "playlists" &&
          !openPl &&
          (playlists === null ? (
            <Spinner t={t("spotify.loadingPlaylists")} />
          ) : playlists.error ? (
            <Empty t={apiErrorText(t, playlists.error)} />
          ) : playlists.items.length === 0 ? (
            <Empty t={t("spotify.emptyList")} />
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col gap-[0.8vh] px-[1vw]">
              {playlists.items.map((p, i) => (
                <Row
                  key={p.id}
                  fk={"br-p-" + i}
                  image={p.image_url}
                  title={p.name}
                  sub={p.owner}
                  right={p.tracks_total != null ? String(p.tracks_total) : ""}
                  onEnter={() => openPlaylist(p, "br-p-" + i)}
                />
              ))}
            </div>
          ))}
        {tab === "playlists" && openPl && (
          <>
            {/* Outside the track list on purpose. A playlist somebody else owns
                lists no tracks at all (Spotify only serves the items of your own),
                and these two are then the only way to play it - so they cannot
                live in a row that exists only when there are rows. */}
            <div className="flex items-center gap-[0.8vw] mb-[1.2vh] shrink-0">
              <Action fk="br-pt-all" primary onEnter={() => playAll(openPl)}>
                <PlayIcon /> {t("spotify.playAll")}
              </Action>
              <Action fk="br-pt-shuffle" onEnter={() => shuffleAll(openPl, (plTracks && plTracks.items) || [])}>
                <ShuffleIcon /> {t("spotify.shuffleAll")}
              </Action>
            </div>
            {plTracks === null ? (
              <Spinner t={t("spotify.loadingList")} />
            ) : plTracks.error ? (
              <Empty t={apiErrorText(t, plTracks.error)} />
            ) : plTracks.items.length === 0 ? (
              <Empty t={t("spotify.followedHint")} />
            ) : (
              <>
                {plTracks.truncated && <Truncated t={t("spotify.truncated")} />}
                <TrackList
                  tracks={plTracks.items}
                  emptyText={t("spotify.followedHint")}
                  // context + offset, so what plays is the playlist from this track
                  // on: `next` follows the playlist, and shuffle and repeat apply to
                  // the whole of it rather than to a copy of its tail.
                  onPlay={(i) =>
                    playAndGo({
                      contextUri: openPl.uri,
                      offset: posOf(plTracks.items, i),
                      uris: plTracks.items.slice(i, i + URIS_MAX).map((x) => x.uri),
                    })
                  }
                />
              </>
            )}
          </>
        )}

        {/* SEARCH */}
        {tab === "search" && (
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden flex flex-col gap-[0.8vh] px-[1vw]">
            <Row fk="br-tab-search-edit" title={query || t("spotify.searchPrompt")} onEnter={() => setOsk(true)} />
            {results &&
              results.tracks.map((tr, i) => (
                <Row
                  key={tr.uri + i}
                  fk={"br-st-" + i}
                  image={tr.image_url}
                  title={tr.name}
                  sub={tr.artists}
                  right={mmss(tr.duration_ms)}
                  onEnter={() => playAndGo({ uris: results.tracks.slice(i, i + URIS_MAX).map((x) => x.uri) })}
                />
              ))}
            {results &&
              results.playlists.map((p, i) => (
                <Row
                  key={p.id}
                  fk={"br-sp-" + i}
                  image={p.image_url}
                  title={p.name}
                  sub={p.owner}
                  right="▶"
                  onEnter={() => playAndGo({ contextUri: p.uri })}
                />
              ))}
            {/* Searching, found nothing, and never searched all used to look the
                same: the query row and nothing else. */}
            {searching && <Spinner t={t("spotify.searching")} />}
            {!searching && results && !results.tracks.length && !results.playlists.length && (
              <Empty t={t("spotify.noSearchMatch")} />
            )}
          </div>
        )}
      </div>
    </FocusContext.Provider>
  );
}

// The tab row is a focus container so the tools row below can hand focus back to
// whichever tab is current, rather than always to the first one.
function Tabs({ children }: { children: React.ReactNode }) {
  const { ref, focusKey } = useFocusable({ focusKey: TABS });
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="flex gap-[1vw] mb-[2vh] shrink-0">
        {children}
      </div>
    </FocusContext.Provider>
  );
}

function TabButton({ id, label, active, onPick }: { id: string; label: string; active: boolean; onPick: () => void }) {
  const { ref, focused } = useFocusableItem(
    {
      focusKey: "br-tab-" + id,
      onEnterPress: onPick,
      // Down goes into the view: its tools row if there is one, else the rows.
      onArrowPress: (dir) => (dir === "down" ? !jump(TOOLS, ROWS) : true),
    },
    { block: "nearest" },
  );
  return (
    <div
      ref={ref}
      onClick={onPick}
      className={[
        "px-[2vw] py-[1.1vh] rounded-[1vh] text-[2vh] shrink-0",
        focused ? "bg-white text-[#06090d]" : active ? "bg-white/15" : "bg-white/5",
      ].join(" ")}
    >
      {label}
    </div>
  );
}

// A spinner with a label. A large playlist can be several seconds, and an
// unlabelled circle says neither what is happening nor which of the three lists
// it belongs to.
function Spinner({ t }: { t?: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-[2vh]">
      <div className="w-[5vh] h-[5vh] rounded-full border-[0.5vh] border-white/20 border-t-white animate-spin" />
      {t && <div className="text-[1.9vh] text-fg-dim">{t}</div>}
    </div>
  );
}
function Empty({ t }: { t: string }) {
  return <div className="text-[2vh] text-fg-dim text-center mt-[6vh] px-[8vw]">{t}</div>;
}
// A library longer than the box will page must say so: the alternative is a list
// that simply ends, with nothing to tell the difference from a shorter library.
function Truncated({ t }: { t: string }) {
  return <div className="mb-[1vh] shrink-0 text-[1.6vh] text-warn px-[1vw]">{t}</div>;
}
