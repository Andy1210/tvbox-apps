import { useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
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

type Tab = "liked" | "playlists" | "search";

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
export function Browser({ onBack, onPlayed, account }: { onBack: () => void; onPlayed: () => void; account?: string }) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "sp-browser" });
  const [tab, setTab] = useState<Tab>("liked");
  const [liked, setLiked] = useState<ListResult<Track> | null>(null);
  const [playlists, setPlaylists] = useState<ListResult<Playlist> | null>(null);
  const [openPl, setOpenPl] = useState<Playlist | null>(null);
  const [plTracks, setPlTracks] = useState<ListResult<Track> | null>(null);
  const [results, setResults] = useState<{ tracks: Track[]; playlists: Playlist[] } | null>(null);
  const [osk, setOsk] = useState(false);
  const [query, setQuery] = useState("");
  const [err, setErr] = useState("");
  const [starting, setStarting] = useState(false); // play may take ~20s when the box is being adopted
  const wanted = useRef(""); // the playlist whose read is still worth showing (see openPlaylist)
  const cameFrom = useRef(""); // the playlist row that was pressed, so Back can return to it

  // Back: out of a playlist -> playlist list; otherwise leave the browser.
  useBackspace(() => {
    if (openPl) {
      wanted.current = ""; // whatever that playlist's read answers, it is no longer wanted
      setOpenPl(null);
      setPlTracks(null);
    } else onBack();
  }, !osk);

  useEffect(() => {
    if (!err) return;
    const id = setTimeout(() => setErr(""), 6000);
    return () => clearTimeout(id);
  }, [err]);
  // The box changed hands while this screen was up, so these rows belong to
  // somebody else's library now. Dropped rather than relabelled: the header would
  // otherwise name one account over another's tracks, and pressing one of them
  // sends that account's context to the new owner's player, which refuses it.
  const shownFor = useRef(account);
  useEffect(() => {
    if (shownFor.current === account) return;
    shownFor.current = account;
    wanted.current = "";
    setLiked(null);
    setPlaylists(null);
    setPlTracks(null);
    setOpenPl(null);
    setResults(null);
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
        jump("br-pt-all", "br-tab-playlists");
        return; // the row to come back to is still needed
      }
      jump(cameFrom.current, "br-tab-" + tab);
      cameFrom.current = "";
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
    if (starting) return; // one request at a time (adoption can take a while)
    setStarting(true);
    setErr("");
    const r = await play(body);
    setStarting(false);
    if (r.ok) {
      onPlayed();
      return;
    }
    // Surface why nothing played instead of silently returning.
    const key =
      r.error === "box_not_found"
        ? "spotify.boxNotFound"
        : r.error === "adopt_failed"
          ? "spotify.adoptFailed"
          : r.error === "in_use"
            ? "spotify.inUse"
            : "";
    setErr(key ? t(key) : t("spotify.playError", { error: r.error || "?" }));
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
    if (!r.ok) {
      setStarting(false);
      setErr(t("spotify.playError", { error: r.error || "?" }));
      return;
    }
    // A refused shuffle would otherwise be invisible: playback started, so the
    // screen would say nothing while the order is the opposite of what was asked.
    const err = await control("shuffle", shuffle);
    setStarting(false);
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
    cameFrom.current = rowKey;
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

  const tabBtn = (id: Tab, label: string) => (
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
      <div ref={ref} className="h-full flex flex-col px-[4vw] py-[3vh] min-h-0">
        {err && (
          <div className="mb-[1.5vh] shrink-0 px-[2vw] py-[1.4vh] rounded-[1vh] bg-red-500/15 text-[1.9vh] text-red-100 max-w-[80vw]">
            {err}
          </div>
        )}
        {starting && (
          <div className="mb-[1.5vh] shrink-0 px-[2vw] py-[1.4vh] rounded-[1vh] bg-white/10 text-[1.9vh] flex items-center gap-[1vw] max-w-[80vw]">
            <div className="w-[2.2vh] h-[2.2vh] rounded-full border-[0.35vh] border-white/25 border-t-white animate-spin shrink-0" />
            {t("spotify.starting")}
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
