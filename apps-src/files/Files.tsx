import { useCallback, useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable, setFocus, getCurrentFocusKey } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, FocusButton, postNowPlaying } from "@sdk";
import {
  fetchList,
  fetchSources,
  formatTime,
  mountDevice,
  unmountDevice,
  type Entry,
  type Listing,
  type Source,
  type SourceList,
} from "./api";
import { resumePoint } from "./resume";
import { Browser } from "./Browser";
import { Sources } from "./Sources";
import { Player } from "./Player";

// Local and USB playback: pick a source, walk it, play a file.
//
// Three screens deep and no further. What is on screen is decided here so Back
// always has one meaning - in a folder it goes up, at the top of a source it
// returns to the source list, and there it leaves the app.

const POLL_MS = 5000; // a stick plugged in while this screen is open should just appear

type Playing = { file: Entry; playlist: Entry[]; startPos: number };
type Ask = { file: Entry; playlist: Entry[]; pos: number };

// A film that is already part-watched is offered rather than assumed: someone who
// left it on for ten minutes and gave up wants the beginning, and there is no way
// to tell the two apart from a position.
function ResumeAsk({ ask, onAnswer }: { ask: Ask; onAnswer: (from: number) => void }) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "resume-ask", isFocusBoundary: true });
  // Where focus was when this opened, so Back can put it back. Without it the two
  // focusables here are removed in one commit with nothing left to inherit from,
  // and the D-pad is dead on the list underneath - the one state a remote cannot
  // get out of.
  const cameFrom = useRef("");
  useEffect(() => {
    cameFrom.current = getCurrentFocusKey() || "";
    const id = setTimeout(() => setFocus("resume-yes"), 0);
    return () => {
      clearTimeout(id);
      if (cameFrom.current) setFocus(cameFrom.current);
    };
  }, []);
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="fixed inset-0 z-50 bg-black/85 flex flex-col items-center justify-center gap-[2.5vh]">
        <div className="text-[3vh] font-bold px-[10vw] text-center truncate">{ask.file.name}</div>
        <div className="flex gap-[1.5vw]">
          <FocusButton
            focusKey="resume-yes"
            onEnter={() => onAnswer(ask.pos)}
            className="px-[3vw] py-[1.8vh] rounded-[1.2vh] bg-white/10 text-[2.2vh] font-semibold"
          >
            {t("files.resumeFrom", { time: formatTime(ask.pos) })}
          </FocusButton>
          <FocusButton
            focusKey="resume-no"
            onEnter={() => onAnswer(0)}
            className="px-[3vw] py-[1.8vh] rounded-[1.2vh] bg-white/10 text-[2.2vh] font-semibold"
          >
            {t("files.startOver")}
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

export function Files({ onExit }: { onExit: () => void }) {
  const { t } = useI18n();
  const [sources, setSources] = useState<SourceList>({
    sources: [],
    removable: { supported: true, error: null },
  });
  const [loadingSources, setLoadingSources] = useState(true);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [note, setNote] = useState("");
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  // Only the newest navigation may act on its answer: a remote repeats faster than
  // a stick answers, so an older listing (or an older resume lookup) must not land
  // on a screen the user has already left.
  const nav = useRef(0);
  // What is playing, for callbacks that must not read it through a state updater
  // (React may run one more than once, and stopping playback is not idempotent).
  const playingRef = useRef<Playing | null>(null);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  const errorText = useCallback(
    (code?: string) => {
      switch (code) {
        case "not_authorized":
          return t("files.errNotAuthorized");
        case "unsupported":
          return t("files.errUnsupported");
        case "unknown_device":
          return t("files.errGone");
        case "busy":
          return t("files.errBusy");
        case "unsupported_filesystem":
          return t("files.errFilesystem");
        case "forbidden":
        case "not_found":
          return t("files.errFolderGone");
        default:
          return t("files.errFailed");
      }
    },
    [t],
  );

  const loadSources = useCallback(() => {
    fetchSources()
      .then((s) => {
        setSources(s);
        if (s.unsupported) setNote(t("files.errUnsupported"));
      })
      .finally(() => setLoadingSources(false));
  }, [t]);

  // Poll only while the source list is what is on screen: a folder listing and a
  // running film have nothing to gain from it, and a poll during playback would
  // spin up lsblk behind the picture.
  useEffect(() => {
    if (listing || playing || ask) return;
    loadSources();
    const id = setInterval(loadSources, POLL_MS);
    return () => clearInterval(id);
  }, [listing, playing, ask, loadSources]);

  const open = useCallback(
    (path: string) => {
      const req = ++nav.current;
      setLoadingList(true);
      setNote("");
      return fetchList(path)
        .then((l) => {
          if (req !== nav.current) return;
          if (l.ok) setListing(l);
          else setNote(errorText(l.error));
        })
        .finally(() => {
          if (req === nav.current) setLoadingList(false);
        });
    },
    [errorText],
  );

  const openSource = useCallback(
    (s: Source) => {
      if (busyId) return; // one at a time: a remote repeats, and mounting is not free
      if (s.kind === "removable" && !s.mounted) {
        if (!s.device) return;
        setBusyId(s.id);
        setNote("");
        mountDevice(s.device)
          .then((r) => {
            // A mount that reports no mount point is a failure, not a no-op: the
            // stick was pulled between mounting and confirming, or the confirming
            // read failed. Saying nothing would read as a dead button.
            if (r.ok && r.mountpoint) return open(r.mountpoint);
            setNote(errorText(r.error));
          })
          .finally(() => setBusyId(""));
        return;
      }
      if (!s.path) return;
      setBusyId(s.id);
      void open(s.path).finally(() => setBusyId(""));
    },
    [busyId, open, errorText],
  );

  const eject = useCallback(
    (s: Source) => {
      if (!s.device || busyId) return;
      setBusyId(s.id);
      setNote("");
      unmountDevice(s.device)
        .then((r) => {
          setNote(r.ok ? t("files.ejected", { name: s.name }) : errorText(r.error));
          loadSources();
          // The button that was pressed is the one that disappears: an ejected
          // stick has nothing left to eject. Hand the focus back to its row.
          setTimeout(() => setFocus("src-" + s.id), 0);
        })
        .finally(() => setBusyId(""));
    },
    [busyId, t, errorText, loadSources],
  );

  const openEntry = useCallback(
    (entry: Entry, playable: Entry[]) => {
      if (entry.dir) return open(entry.path);
      const req = ++nav.current;
      void resumePoint(entry.path).then((point) => {
        if (req !== nav.current) return; // Back was pressed while the store answered
        if (point && point.pos > 0) setAsk({ file: entry, playlist: playable, pos: point.pos });
        else setPlaying({ file: entry, playlist: playable, startPos: 0 });
      });
    },
    [open],
  );

  const stopPlayback = useCallback(() => {
    window.tvbox?.stop?.();
    postNowPlaying({ app: "files", state: "idle" });
    setPlaying(null);
  }, []);

  // The end of a file: the next playable one in the same folder, in the order the
  // list showed - which is what "the next episode" means without a media server
  // to ask. Nothing to play next is the end of the session, not a silent stop.
  const playNext = useCallback(() => {
    const cur = playingRef.current;
    if (!cur) return;
    const idx = cur.playlist.findIndex((e) => e.path === cur.file.path);
    const next = idx >= 0 ? cur.playlist[idx + 1] : undefined;
    if (!next) return stopPlayback();
    setPlaying({ file: next, playlist: cur.playlist, startPos: 0 });
  }, [stopPlayback]);

  // Leaving the app must not leave a film running behind the launcher.
  useEffect(() => () => postNowPlaying({ app: "files", state: "idle" }), []);

  // A message is news, not a state: it goes away on its own rather than sitting
  // over the source list until something else happens to replace it.
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(""), 6000);
    return () => clearTimeout(id);
  }, [note]);

  // Back, one meaning per screen. Disabled while a film plays: the player has its
  // own handler (and no focusable UI), and both must not fire for one press.
  useBackspace(() => {
    if (ask) return setAsk(null);
    if (listing) {
      nav.current++; // whatever a slower screen was loading is no longer wanted
      if (listing.parent) open(listing.parent);
      else setListing(null);
      return;
    }
    onExit();
  }, !playing);

  if (playing) {
    return (
      <Player
        key={playing.file.path}
        file={playing.file}
        startPos={playing.startPos}
        onStop={stopPlayback}
        onEnded={playNext}
      />
    );
  }

  return (
    <div className="h-full">
      {listing ? (
        <Browser listing={listing} loading={loadingList} onOpen={openEntry} />
      ) : (
        <Sources
          sources={sources.sources}
          removable={sources.removable}
          loading={loadingSources}
          busyId={busyId}
          note={note}
          onOpen={openSource}
          onEject={eject}
        />
      )}
      {listing && note && <div className="fixed left-[4vw] bottom-[3vh] text-[1.8vh] text-[#ffb3b3]">{note}</div>}
      {ask && (
        <ResumeAsk
          ask={ask}
          onAnswer={(from) => {
            setPlaying({ file: ask.file, playlist: ask.playlist, startPos: from });
            setAsk(null);
          }}
        />
      )}
    </div>
  );
}
