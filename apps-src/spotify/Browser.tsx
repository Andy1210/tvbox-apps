import { useEffect, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, FocusButton, Osk } from "@sdk";
import { fetchLiked, fetchPlaylists, fetchPlaylistItems, search, play, mmss, type Track, type Playlist, type ListResult,
} from "./api";

type Tab = "liked" | "playlists" | "search";

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
          <img src={image} alt="" className="w-[5vh] h-[5vh] rounded-[0.6vh] object-cover shrink-0" />
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
  return t("spotify.apiError", { error });
}

export function Browser({ onBack, onPlayed }: { onBack: () => void; onPlayed: () => void }) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "sp-browser" });
  const [tab, setTab] = useState<Tab>("liked");
  const [liked, setLiked] = useState<ListResult<Track> | null>(null);
  const [playlists, setPlaylists] = useState<ListResult<Playlist> | null>(null);
  const [openPl, setOpenPl] = useState<Playlist | null>(null);
  const [plTracks, setPlTracks] = useState<Track[] | null>(null);
  const [results, setResults] = useState<{ tracks: Track[]; playlists: Playlist[] } | null>(null);
  const [osk, setOsk] = useState(false);
  const [query, setQuery] = useState("");
  const [err, setErr] = useState("");
  const [starting, setStarting] = useState(false); // play may take ~20s when the box is being adopted

  // Back: out of a playlist -> playlist list; otherwise leave the browser.
  useBackspace(() => {
    if (openPl) {
      setOpenPl(null);
      setPlTracks(null);
    } else onBack();
  }, !osk);

  useEffect(() => {
    if (!err) return;
    const id = setTimeout(() => setErr(""), 6000);
    return () => clearTimeout(id);
  }, [err]);
  useEffect(() => {
    if (tab === "liked" && liked === null) fetchLiked().then(setLiked);
  }, [tab, liked]);
  useEffect(() => {
    if (tab === "playlists" && playlists === null) fetchPlaylists().then(setPlaylists);
  }, [tab, playlists]);

  useEffect(() => {
    const id = setTimeout(() => setFocus(openPl ? "br-pt-all" : "br-tab-" + tab), 0);
    return () => clearTimeout(id);
  }, [tab, openPl, liked, playlists, plTracks, results]);

  const playAndGo = async (body: { contextUri?: string; uris?: string[] }) => {
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

  const openPlaylist = async (p: Playlist) => {
    setOpenPl(p);
    setPlTracks(null);
    setPlTracks(await fetchPlaylistItems(p.id));
  };

  const runSearch = async (q: string) => {
    setQuery(q);
    setOsk(false);
    setResults(null);
    if (q.trim()) setResults(await search(q.trim()));
  };

  if (osk) {
    return <Osk title={t("spotify.searchPrompt")} initial={query} onDone={runSearch} onCancel={() => setOsk(false)} />;
  }

  const tabBtn = (id: Tab, label: string) => (
    <FocusButton
      focusKey={"br-tab-" + id}
      onEnter={() => {
        setTab(id);
        setOpenPl(null);
      }}
      className={["px-[2vw] py-[1.1vh] rounded-[1vh] text-[2vh]", tab === id ? "bg-white/15" : "bg-white/5"].join(" ")}
    >
      {label}
    </FocusButton>
  );

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col px-[4vw] py-[3vh]">
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
        <div className="flex gap-[1vw] mb-[2vh] shrink-0">
          {tabBtn("liked", t("spotify.liked"))}
          {tabBtn("playlists", t("spotify.playlists"))}
          {tabBtn("search", t("spotify.search"))}
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden flex flex-col gap-[0.8vh] px-[2vw]">
          {/* LIKED */}
          {tab === "liked" &&
            (liked === null ? (
              <Spinner />
            ) : liked.error ? (
              <Empty t={apiErrorText(t, liked.error)} />
            ) : liked.items.length === 0 ? (
              <Empty t={t("spotify.emptyList")} />
            ) : (
              liked.items.map((tr, i) => (
                <Row
                  key={tr.uri + i}
                  fk={"br-l-" + i}
                  image={tr.image_url}
                  title={tr.name}
                  sub={tr.artists}
                  right={mmss(tr.duration_ms)}
                  onEnter={() => playAndGo({ uris: liked.items.slice(i).map((x) => x.uri) })}
                />
              ))
            ))}

          {/* PLAYLISTS — list, or one playlist's tracks */}
          {tab === "playlists" &&
            !openPl &&
            (playlists === null ? (
              <Spinner />
            ) : playlists.error ? (
              <Empty t={apiErrorText(t, playlists.error)} />
            ) : playlists.items.length === 0 ? (
              <Empty t={t("spotify.emptyList")} />
            ) : (
              playlists.items.map((p, i) => (
                <Row
                  key={p.id}
                  fk={"br-p-" + i}
                  image={p.image_url}
                  title={p.name}
                  sub={p.owner}
                  right={p.tracks_total != null ? String(p.tracks_total) : ""}
                  onEnter={() => openPlaylist(p)}
                />
              ))
            ))}
          {tab === "playlists" && openPl && (
            <>
              <Row
                fk="br-pt-all"
                title={"▶ " + t("spotify.playAll")}
                sub={openPl.name}
                onEnter={() => playAndGo({ contextUri: openPl.uri })}
              />
              {plTracks === null ? (
                <Spinner />
              ) : plTracks.length === 0 ? (
                <Empty t={t("spotify.followedHint")} />
              ) : (
                plTracks.map((tr, i) => (
                  <Row
                    key={tr.uri + i}
                    fk={"br-pt-" + i}
                    image={tr.image_url}
                    title={tr.name}
                    sub={tr.artists}
                    right={mmss(tr.duration_ms)}
                    onEnter={() => playAndGo({ uris: plTracks.slice(i).map((x) => x.uri) })}
                  />
                ))
              )}
            </>
          )}

          {/* SEARCH */}
          {tab === "search" && (
            <>
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
                    onEnter={() => playAndGo({ uris: results.tracks.slice(i).map((x) => x.uri) })}
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
            </>
          )}
        </div>
      </div>
    </FocusContext.Provider>
  );
}

function Spinner() {
  return (
    <div className="self-center mt-[6vh] w-[5vh] h-[5vh] rounded-full border-[0.5vh] border-white/20 border-t-white animate-spin" />
  );
}
function Empty({ t }: { t: string }) {
  return <div className="text-[2vh] text-fg-dim text-center mt-[6vh] px-[8vw]">{t}</div>;
}
