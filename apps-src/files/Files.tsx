import { useCallback, useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable, setFocus, getCurrentFocusKey } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, FocusButton, postNowPlaying } from "@sdk";
import {
  castPhotoOf,
  clearCast,
  fetchCast,
  fetchList,
  fetchSources,
  formatTime,
  mountDevice,
  photoOf,
  startPairing,
  stopPairing,
  unmountDevice,
  type Entry,
  type Listing,
  type PairingInfo,
  type Photo,
  type Source,
  type SourceList,
} from "./api";
import { resumePoint } from "./resume";
import { Browser } from "./Browser";
import { Sources } from "./Sources";
import { Player } from "./Player";
import { PhotoGrid } from "./PhotoGrid";
import { Phone } from "./Phone";
import { Viewer } from "./Viewer";

// Local and USB playback, and photos: pick a source, walk it, play or look at what
// is in it.
//
// What is on screen is decided here so that Back always has one meaning - in a
// folder it goes up, at the top of a source it returns to the source list, and
// there it leaves the app. The photo screens extend the same ladder: the grid
// returns to the folder it came from, and the viewer to the grid.

const POLL_MS = 5000; // a stick plugged in while this screen is open should just appear
// While the phone page is open, photos arrive one at a time and the TV should fill
// up as they do - that is the whole point of the screen, so it polls faster.
const CAST_POLL_MS = 1500;

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
  const { t, locale } = useI18n();
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
  // The photo ladder, alongside the file one. `gallery` is a grid of photos with
  // the title it was opened under; `viewing` is an index into it. A cast gallery
  // is rebuilt from the poll, so it grows while it is on screen.
  const [gallery, setGallery] = useState<{ title: string; photos: Photo[]; cast: boolean } | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  // Which tile the grid comes back to. The viewer replaces the grid rather than
  // covering it - two screens mounted at once would both answer the arrows - so
  // the position has to be held out here, or a folder of three hundred photos
  // would start again from the top every time one of them was closed.
  const [galleryPos, setGalleryPos] = useState(0);
  const [phone, setPhone] = useState(false);
  const [cast, setCast] = useState<string[]>([]);
  // The pairing session belongs to the whole casting flow, not to the QR screen:
  // starting it mints a new code, and that screen is left and returned to while a
  // phone still has the page open.
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [pairingFailed, setPairingFailed] = useState(false);
  // A box whose shell predates the photo routes answers 404 to the first probe.
  // Everything photo-shaped is withheld there rather than offered and then failing:
  // a greyed-out feature is a feature, an empty grid is a fault.
  const [photosSupported, setPhotosSupported] = useState(true);
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
    if (listing || playing || ask || phone || gallery) return;
    loadSources();
    const id = setInterval(loadSources, POLL_MS);
    return () => clearInterval(id);
  }, [listing, playing, ask, phone, gallery, loadSources]);

  // What the phone has sent. Fast while its page is open, because each photo
  // appearing is the feedback for the tap that sent it; once a second otherwise,
  // and only on the screens where it shows.
  const castOpen = phone || (gallery?.cast ?? false);
  useEffect(() => {
    // A box whose shell has no such route answers 404, and the answer does not
    // change while the app is open - so the first one ends the poll instead of
    // leaving an old box fetching a 404 every five seconds for the session.
    if (playing || !photosSupported) return;
    if (!castOpen && (listing || ask)) return;
    let alive = true;
    const read = () =>
      void fetchCast().then((c) => {
        if (!alive) return;
        if (c.unsupported) return setPhotosSupported(false);
        setCast(c.names);
      });
    read();
    const id = setInterval(read, castOpen ? CAST_POLL_MS : POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [castOpen, listing, ask, playing, photosSupported]);

  // A cast gallery IS the session, so it follows it: photos appear while it is
  // open, and it closes by itself when the phone empties it.
  useEffect(() => {
    if (!gallery?.cast) return;
    const photos = cast.map(castPhotoOf);
    setGallery((g) => (g && g.cast ? { ...g, photos } : g));
    if (!photos.length) {
      setViewing(null);
      setGallery(null);
    } else if (viewing !== null && viewing >= photos.length) setViewing(photos.length - 1);
  }, [cast, gallery?.cast, viewing]);

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

  // Opening the casting flow. The session is started ONCE and kept until the flow
  // ends: coming back here from the gallery must not mint a new code, or the phone
  // still holding the page would be answered 403 for the rest of the session.
  const openCast = useCallback(() => {
    setPhone(true);
    if (pairing) return;
    setPairingFailed(false);
    startPairing(locale)
      .then((d) => (d && d.url ? setPairing(d) : setPairingFailed(true)))
      .catch(() => setPairingFailed(true));
  }, [pairing, locale]);

  // The one deliberate end of a cast: the photos go, and the LAN server with them.
  // Everything else is a way back to the QR, because someone who has just looked at
  // thirty photos usually has more to send.
  const endCast = useCallback(() => {
    setViewing(null);
    setGallery(null);
    setPhone(false);
    setCast([]);
    setPairing(null);
    setPairingFailed(false);
    void clearCast();
    void stopPairing();
  }, []);

  // Leaving the app must not leave a film running behind the launcher - nor a
  // stranger's holiday on the box's disk. The boot sweep is the backstop for a TV
  // switched off at the wall; this is the ordinary case.
  // Read on the way out, so the cleanup can see what the last render did without
  // re-subscribing on every change.
  const leaving = useRef({ cast: [] as string[], pairing: false });
  useEffect(() => {
    leaving.current = { cast, pairing: !!pairing };
  }, [cast, pairing]);
  useEffect(
    () => () => {
      postNowPlaying({ app: "files", state: "idle" });
      if (leaving.current.cast.length) void clearCast();
      // The pairing server is open on the LAN. It times itself out after five
      // minutes, but leaving the app is an answer sooner than that.
      if (leaving.current.pairing) void stopPairing();
    },
    [],
  );

  // A message is news, not a state: it goes away on its own rather than sitting
  // over the source list until something else happens to replace it.
  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(""), 6000);
    return () => clearTimeout(id);
  }, [note]);

  // Back, one meaning per screen. Disabled while a film plays or a photo fills the
  // screen: both have their own handler (and no focusable UI), and the two must not
  // fire for one press - in the viewer's case because Back there means "out of the
  // zoom" before it means "out of the photo".
  useBackspace(() => {
    if (ask) return setAsk(null);
    // A cast gallery goes back to the QR rather than to the folder list: the phone
    // is still in someone's hand, and the next thing they do is usually send more.
    if (gallery) {
      setGallery(null);
      if (gallery.cast) setPhone(true); // back to the QR, session and code intact
      return;
    }
    if (phone) return endCast();
    if (listing) {
      nav.current++; // whatever a slower screen was loading is no longer wanted
      if (listing.parent) open(listing.parent);
      else setListing(null);
      return;
    }
    onExit();
  }, !playing && viewing === null);

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

  if (gallery && viewing !== null) {
    return (
      <Viewer
        photos={gallery.photos}
        startIndex={viewing}
        onClose={(at) => {
          // Come back to the photo that was on screen, not to the top of a folder
          // that may be three hundred long.
          setGalleryPos(at);
          setViewing(null);
        }}
      />
    );
  }

  return (
    <div className="h-full">
      {gallery ? (
        <PhotoGrid title={gallery.title} photos={gallery.photos} startIndex={galleryPos} onOpen={setViewing} />
      ) : phone ? (
        <Phone
          info={pairing}
          failed={pairingFailed}
          count={cast.length}
          onDone={() => {
            setGalleryPos(0);
            setGallery({ title: t("files.fromPhone"), photos: cast.map(castPhotoOf), cast: true });
            setPhone(false);
          }}
          onExit={endCast}
        />
      ) : listing ? (
        <Browser
          listing={listing}
          loading={loadingList}
          photosSupported={photosSupported}
          onOpen={openEntry}
          onPhotos={(photos) => setGallery({ title: listing.name, photos: photos.map(photoOf), cast: false })}
        />
      ) : (
        <Sources
          sources={sources.sources}
          removable={sources.removable}
          loading={loadingSources}
          busyId={busyId}
          note={note}
          castCount={cast.length}
          photosSupported={photosSupported}
          onOpen={openSource}
          onEject={eject}
          onPhone={openCast}
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
