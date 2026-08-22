// What is playing, and what is next.
//
// A full screen rather than an overlay, because there is no picture underneath
// to keep looking at - which is the whole difference from the film player. So
// the artwork can be large and the queue can be on screen beside it.
//
// The transport row is the first thing focus lands on. Someone arriving here
// pressed a song a moment ago; what they want next is pause or skip, not the
// bottom of a list.
//
// Left alone while a song plays, the screen settles: the panel on the right goes
// away, the song moves to the middle, and its own artwork fills the background
// behind it, blurred and dimmed. This is not decoration - a television holding
// one static screen for an album's length is the thing the box's screensaver
// exists to prevent, and the screensaver cannot come up over music that IS the
// thing on show. Any press brings the panel back, and so does the next song.

import { useEffect, useRef, useState } from "react";
import { FocusContext, getCurrentFocusKey, setFocus, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, Osk, useBackspace, useFocusableItem, useI18n } from "@sdk";
import { Message } from "../Message";
import { Lyrics } from "./Lyrics";
import { TrackRow, TRACK_ROW_VH } from "./TrackRow";
import { artworkScale } from "../posters";
import { useFocusFallback, useInitialFocus } from "../focus";
import { useApp } from "../state";
import { useMusic, type RepeatMode } from "../playback/music";
import { useArtwork } from "./useArtwork";
import { clock } from "../time";
import { log } from "../redact";
import {
  Back10Icon,
  Forward10Icon,
  LyricsIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PlaylistAddIcon,
  PreviousIcon,
  RepeatIcon,
  ShuffleIcon,
  StopIcon,
} from "../icons";

/** How much of the queue is drawn. See the note where it is used. */
const QUEUE_ROWS = 60;
/**
 * How many played rows the window keeps behind the cursor.
 *
 * Enough to see where you came from without spending the window on it: the
 * point of showing them at all is that the song that just went past is one
 * press away, not that the whole history is on screen.
 */
const QUEUE_LEAD = 6;

/**
 * How far one press moves the scrub cursor.
 *
 * Five seconds, where the film player's step is larger: a song is three minutes,
 * so this crosses one end to the other in about forty presses - and the remote
 * repeats while a key is held, so that is a second or two of holding rather than
 * forty deliberate presses.
 */
const SCRUB_STEP_MS = 5_000;

/**
 * How long a playing song sits untouched before the screen settles.
 *
 * Long enough to read the top of the queue and decide, short enough that the
 * still picture is not what the room looks at all evening. Only while something
 * is PLAYING: paused, this screen has the box's own screensaver coming over it
 * instead, which is a better answer than a dimmer version of the same picture.
 */
const SETTLE_MS = 12_000;

export function NowPlaying(): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const back = useApp((s) => s.back);
  const queue = useMusic((s) => s.queue);
  const index = useMusic((s) => s.index);
  /**
   * Where the LIST is looking, which is not where the music is.
   *
   * Follows the playing track until somebody moves focus, and follows the focus
   * after that - the same anchor the songs list uses, and for the same reason: a
   * window that follows playback alone scrolls out from under the person
   * reading it.
   */
  const [queueCursor, setQueueCursor] = useState<number | null>(null);
  const state = useMusic((s) => s.state);
  const positionMs = useMusic((s) => s.positionMs);
  const durationMs = useMusic((s) => s.durationMs);
  const scrubMs = useMusic((s) => s.scrubMs);
  const buffering = useMusic((s) => s.buffering);
  const shuffle = useMusic((s) => s.shuffle);
  const repeat = useMusic((s) => s.repeat);
  const error = useMusic((s) => s.error);
  const resume = useMusic((s) => s.resume);
  const music = useMusic();

  const [naming, setNaming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** Which panel the right-hand column holds. */
  const [panel, setPanel] = useState<"queue" | "lyrics">("queue");
  /** Nothing pressed for a while, with a song playing: the screen has settled. */
  const [settled, setSettled] = useState(false);
  /** The words are time-tagged and following the song, so something IS moving. */
  const [lyricsLive, setLyricsLive] = useState(false);
  // What the focused control is called. The row is icons now, and an icon row
  // with nothing naming it is a row of guesses - see the note on the row itself.
  const [hint, setHint] = useState<string | null>(null);

  const item = queue[index];
  const at = queueCursor ?? index;
  const qStart = Math.max(0, Math.min(at - QUEUE_LEAD, Math.max(0, queue.length - QUEUE_ROWS)));
  // Before either early return below: a hook cannot be called conditionally, and
  // both the keyboard and the empty state return ahead of the artwork.
  const cover = useArtwork(
    item && backend ? backend.posterUrl(item, 600 * artworkScale(), 600 * artworkScale()) : undefined,
  );
  /**
   * What goes behind the settled screen.
   *
   * The item's own backdrop where the server has one - on this library a track
   * inherits its artist's - and the cover blown up where it has not, which is
   * the same picture the screen is already showing and is why it is blurred hard
   * rather than shown as a picture. Asked for at backdrop size in both cases: a
   * 600px cover across a 4K panel is soft even before the blur.
   */
  const wide = useArtwork(item && backend ? backend.backdropUrl(item, 1280, 720) : undefined);
  const behind = wide ?? cover;

  /**
   * The settle timer.
   *
   * Restarted by any press, and by the next song - both of them are somebody or
   * something saying the screen has news. Off unless a song is PLAYING: paused,
   * the box's own screensaver is what comes over this screen, and two things
   * dimming the same picture on two different clocks is one too many.
   *
   * Not while the cursor is IN the queue: that panel is what would disappear, and
   * with it the row holding focus - a remote that stops working because nobody
   * pressed anything. Somebody parked on a song row is reading the list.
   */
  const playing = state === "playing";
  useEffect(() => {
    setSettled(false);
    if (!playing) return;
    let timer = 0;
    const arm = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if ((getCurrentFocusKey() ?? "").startsWith("nq-")) return arm();
        // Reading is the one thing on this screen that LOOKS like nothing
        // happening: no press for a minute is what reading the words to a song
        // is made of, and a karaoke view is moving on its own anyway, so it is
        // not the still picture this exists to prevent.
        //
        // Held off by the words MOVING, not by the panel being the chosen one:
        // with the lyrics switch off, or on a song the database does not have,
        // the panel is a single static line and the screen would never settle at
        // all - which is the opposite of what it is for.
        if (panel === "lyrics" && lyricsLive) return arm();
        setSettled(true);
      }, SETTLE_MS);
    };
    const wake = (): void => {
      setSettled(false);
      arm();
    };
    arm();
    window.addEventListener("keydown", wake, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", wake, true);
    };
    // The track is a dependency on purpose: a new song re-arms the timer, which
    // is what brings the queue back as it changes.
  }, [playing, item?.id, panel, lyricsLive]);
  useInitialFocus("np-toggle", Boolean(item) && !naming);
  // OFF while the keyboard is up. The keyboard replaces this screen, so np-toggle
  // is unmounted - and the fallback runs in the capture phase, ahead of spatial
  // navigation, so every arrow and Enter would be spent putting the cursor back
  // on a key that cannot exist until the keyboard closes. That is the dead remote
  // the fallback exists to prevent, caused by the fallback itself. Search does
  // the same thing for the same reason: the keyboard owns focus while it is open.
  useFocusFallback(
    "np-toggle",
    (key) => key.startsWith("np-") || key.startsWith("nq-") || key.startsWith("msg-"),
    !naming,
  );
  // Back takes the cursor back to the song before it leaves the screen. Enabled
  // only while the cursor is out, so it sits on top of the app's own Back handler
  // exactly then and hands it back afterwards - the stack fires only the newest
  // enabled one.
  useBackspace(() => music.cancelScrub(), scrubMs !== null);

  if (naming) {
    return (
      <Osk
        title={t("music.saveAsPlaylist")}
        // Seeded with something usable, because a name typed on a D-pad costs
        // real presses and most queues never need a considered one.
        initial={item ? `${item.grandparentTitle ?? item.title}` : t("music.queue")}
        onDone={(value) => {
          setNaming(false);
          void savePlaylist(value);
        }}
        onCancel={() => setNaming(false)}
      />
    );
  }

  async function savePlaylist(name: string): Promise<void> {
    const title = name.trim();
    if (!backend || !title || !queue.length) return;
    try {
      // The whole queue, in the order it is playing - which is the shuffled
      // order when shuffle is on, and that is the point: this is for keeping a
      // running order somebody liked.
      //
      // Deduplicated first, because the server does it silently: measured, eight
      // ids with one repeat became a seven-track playlist. Adding an album to the
      // queue twice is easy, so the difference between what was asked for and
      // what was saved has to be resolved here rather than left as a surprise on
      // another device.
      const ids = [...new Set(queue.map((x) => x.id))];
      const made = await backend.createPlaylist(title, ids, "audio");
      // The count the SERVER wrote, not the count we asked for. Deduplicating
      // here is not enough: it also drops any id it cannot resolve - a track
      // removed since the queue was built, or a rating key changed by a rescan -
      // and answers 200 either way. Measured: five ids became three tracks, and
      // two unresolvable ones became an empty playlist.
      setNote(t("music.saved", { title, n: String(made.childCount ?? ids.length) }));
    } catch (e) {
      log.warn("saving the playlist failed", e);
      setNote(t("music.saveFailed"));
    }
  }

  if (!item) return <Message text={t("music.nothingPlaying")} />;

  const artist = item.grandparentTitle ?? item.parentTitle;

  return (
    <div className="relative z-10 flex h-full gap-[3vw] px-[5vw] py-[4vh]">
      {/* The artwork behind a settled screen. Its own layer at the bottom of this
          one's stacking context, so it covers the padding too - a blurred image
          with a hard edge inside the frame reads as a mistake. Faded in rather
          than switched on: appearing between two frames is startling in a dark
          room, which is the room this happens in. */}
      {behind && (
        <div
          aria-hidden="true"
          className={[
            "pointer-events-none absolute inset-0 -z-10 transition-opacity duration-700",
            settled ? "opacity-100" : "opacity-0",
          ].join(" ")}
        >
          {/* scale, because a blur samples past the edge and leaves the frame
              lighter all the way round without it. */}
          <img src={behind} alt="" className="h-full w-full scale-110 object-cover blur-[1.4vh] brightness-50" />
          {/* Dark enough that the settled screen is DIMMER than the one it
              replaces. Measured on this library: a track's backdrop resolves to
              the artist collage, and at a 70% scrim alone the "resting" screen
              came out brighter than the player - which is backwards for
              something whose whole reason is not holding a bright still picture
              on a television. */}
          <div className="absolute inset-0 bg-bg-0/80" />
        </div>
      )}
      {/* The song on the left, the queue on the right. Both are on screen at
          once on purpose: "what is next" is the question this screen gets asked
          most, and a queue behind a button is a queue nobody looks at - until
          the screen settles, when the song has the middle to itself. */}
      <div
        className={[
          "flex min-w-0 flex-col justify-center transition-all duration-500",
          settled ? "mx-auto w-[64vw] text-center" : "flex-1",
        ].join(" ")}
      >
        {cover && (
          <img
            src={cover}
            alt=""
            className={[
              "mb-[2.5vh] h-[34vh] w-[34vh] rounded-[1.5vh] object-cover",
              settled ? "self-center shadow-[0_2vh_6vh_rgba(0,0,0,0.6)]" : "",
            ].join(" ")}
          />
        )}
        <h1 className="truncate text-[4.4vh] font-bold">{item.title}</h1>
        {artist && <p className="truncate text-[2.6vh] text-fg-dim">{artist}</p>}
        {item.parentTitle && item.parentTitle !== artist && (
          <p className="truncate text-[2.2vh] text-fg-dim">{item.parentTitle}</p>
        )}

        <ScrubBar
          positionMs={positionMs}
          durationMs={durationMs}
          scrubMs={scrubMs}
          onScrub={(delta) => music.scrubBy(delta)}
          onCommit={() => music.commitScrub()}
          onToggle={() => music.toggle()}
          onFocused={() => setHint(t("music.seekHint"))}
        />

        {(buffering || error || note) && (
          <p className="mt-[1vh] text-[2vh] text-fg-dim">
            {note ?? (error ? t("music.trackFailed", { title: error }) : t("common.loading"))}
          </p>
        )}

        <Transport
          state={state}
          centred={settled}
          panel={panel}
          onPanel={() => setPanel(panel === "queue" ? "lyrics" : "queue")}
          // Stopped on a song that was left part-way is a THIRD thing the one
          // button does, and the only one whose name was a lie before: it starts
          // where the song was left, so it may say so.
          canResume={Boolean(resume && resume.index === index)}
          shuffle={shuffle}
          repeat={repeat}
          onHint={setHint}
          onToggle={() => music.toggle()}
          onNext={() => void music.next()}
          onPrevious={() => void music.previous()}
          onSeek={(delta) => music.seek(positionMs + delta)}
          onShuffle={() => music.setShuffle(!shuffle)}
          onRepeat={() => music.setRepeat(nextRepeat(repeat))}
          onSave={() => setNaming(true)}
          onStop={() => {
            void music.stop();
            back();
          }}
        />

        {/* One line, reserved whether or not there is anything in it: without a
            fixed height the whole column shifted up and down by its height as
            the cursor moved between the bar and the buttons. */}
        <p className="mt-[1.2vh] h-[2.8vh] truncate text-[2.1vh] text-fg-dim">{hint}</p>
      </div>

      {/* Unmounted rather than hidden, both when the screen settles and when the
          words replace the list: a hidden subtree is still in the
          spatial-navigation tree, so the arrows would walk into a panel nobody
          can see. The settle timer refuses to fire while the cursor is in the
          queue, so nothing focusable is ever taken away under a press. */}
      {!settled && (
        <div className="flex w-[34vw] min-w-0 flex-col">
          <h2 className="shrink-0 px-[1.5vw] pb-[1vh] text-[2.4vh] text-fg-dim">
            {panel === "lyrics" ? t("music.lyrics") : `${t("music.queue")} · ${index + 1}/${queue.length}`}
          </h2>
          {panel === "lyrics" && (
            <Lyrics item={item} positionMs={positionMs} scrollKey="np-lyrics" onLive={setLyricsLive} />
          )}
          {/* py and px, because the focus ring scales a row by 4% and a scroll
            container clips both axes: without them the top row was cut in half
            and the focused one lost a slice off each side. */}
          {panel === "queue" && (
            <ul className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-[1vw] py-[0.6vh]">
              {/* Bounded, and windowed around the CURSOR rather than around what is
              playing. A shuffle of this library is 572 rows, and every one of
              them would otherwise be a mounted focusable that spatial
              navigation measures on each press - the songs list windows for the
              same reason, and learns where it is the same way, from `onFocused`
              rather than by counting presses.
              Anchored on the playing track it drew only what was ahead, so a
              song that had just gone past could not be reached at all: the way
              back to it was off the list. */}
              {queue.slice(qStart, qStart + QUEUE_ROWS).map((x, i) => (
                <li key={`${x.id}-${qStart + i}`} style={{ height: `${TRACK_ROW_VH}vh` }}>
                  <TrackRow
                    item={x}
                    focusKey={`nq-${qStart + i}`}
                    ordinal={qStart + i + 1}
                    playing={qStart + i === index}
                    onFocused={() => setQueueCursor(qStart + i)}
                    onEnter={() => void music.playAt(qStart + i)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** off -> all -> one -> off. The order a person expects from one button. */
function nextRepeat(mode: RepeatMode): RepeatMode {
  return mode === "off" ? "all" : mode === "all" ? "one" : "off";
}

/**
 * The bar, and the cursor on it.
 *
 * Focusable in its own right, which is what lets Left and Right mean two
 * different things on two rows without a mode nobody can see: what has focus
 * says which. Same shape as the film player's, minus the frame preview - there
 * is no picture to show, and a song has nothing to look at on the way past.
 */
function ScrubBar({
  positionMs,
  durationMs,
  scrubMs,
  onScrub,
  onCommit,
  onToggle,
  onFocused,
}: {
  positionMs: number;
  durationMs: number;
  scrubMs: number | null;
  onScrub: (deltaMs: number) => void;
  onCommit: () => void;
  onToggle: () => void;
  onFocused: () => void;
}): React.JSX.Element {
  const scrubbing = scrubMs !== null;
  const shown = scrubMs ?? positionMs;
  const pct = durationMs > 0 ? Math.min(100, (shown / durationMs) * 100) : 0;
  const playedPct = durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0;

  const { ref, focused } = useFocusableItem({
    focusKey: "np-scrub",
    onEnterPress: () => {
      // Committing comes first: while the cursor is out, OK is the only way to
      // go where it points, and pausing there would be an odd answer to a press
      // that was aiming at a place in the song.
      if (scrubbing) onCommit();
      else onToggle();
    },
    onArrowPress: (direction: string) => {
      if (direction === "left" || direction === "right") {
        // The store refuses to move a cursor it has no scale for, and the press
        // is still consumed: the alternative is that Left and Right move FOCUS
        // for the fraction of a second before the box reports a length, so the
        // one press that behaves differently is the one nobody could predict.
        onScrub(direction === "left" ? -SCRUB_STEP_MS : SCRUB_STEP_MS);
        return false;
      }
      // Nothing is above the bar, and letting the press go unhandled sent the
      // cursor across into the queue - navigation searches globally when it
      // finds no candidate in the direction asked for.
      if (direction === "up") return false;
      return true;
    },
    // Reported through spatial navigation's own callback, so the line under the
    // buttons can name this row too. NOT compared during render: setting parent
    // state from a child's render body is what React warns about, and it is a
    // real hazard rather than a style note - the parent re-renders this child,
    // which is the shape a render loop is made of.
    onFocus: () => onFocused(),
  });

  return (
    <div
      ref={ref}
      // The focus key in the DOM, as every FocusButton carries one: without a
      // marker nothing outside React can tell which row has the cursor, and a
      // navigation check with nothing to point at is decided by nothing at all.
      data-sfocus="np-scrub"
      className="mt-[2.5vh] flex items-center gap-[1vw]"
    >
      <span className="w-[8vw] text-[2vh] text-fg-dim tabular-nums">{clock(shown)}</span>
      <div
        className={`relative flex-1 rounded-full bg-white/15 transition-all ${
          focused ? "h-[1.1vh] ring-[0.3vh] ring-white/70" : "h-[0.7vh]"
        }`}
      >
        <div className="absolute top-0 left-0 h-full rounded-full bg-white/80" style={{ width: `${playedPct}%` }} />
        {/* Two marks while the cursor is out: where the song IS, and where the
            cursor points. Without the first there is no way back to it. They
            differ in SHAPE rather than in size - at three metres a size
            difference alone is a few arc-minutes and reads as one mark that
            moved. */}
        {scrubbing && (
          <div
            className="absolute top-1/2 h-[2.2vh] w-[0.35vh] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white"
            style={{ left: `${playedPct}%` }}
          />
        )}
        <div
          className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[0_0_1.5vh_rgba(0,0,0,0.7)] ${
            scrubbing
              ? "h-[2.6vh] w-[2.6vh] border-[0.3vh] border-white bg-[var(--color-accent)]"
              : focused
                ? "h-[1.8vh] w-[1.8vh] bg-white"
                : "h-[1.4vh] w-[1.4vh] bg-white"
          }`}
          style={{ left: `${pct}%` }}
        />
      </div>
      <span className="w-[8vw] text-right text-[2vh] text-fg-dim tabular-nums">{clock(durationMs)}</span>
    </div>
  );
}

/**
 * One round button per thing the player can do.
 *
 * Icons rather than words: a word is wider and slower to read across a room than
 * the shape everyone already knows from every other player, and nine of them in
 * a row wrapped onto two lines. Inline SVG, never a font glyph or an emoji -
 * this Chromium has no colour-emoji font and draws a hollow box in its place.
 *
 * What the icons cost is that a shape says nothing about STATE, and shuffle and
 * repeat have state that is readable nowhere else. So the row is paired with a
 * line under it naming whatever has focus, and for those two it names the state
 * as well.
 */
function Transport({
  state,
  canResume,
  centred,
  panel,
  onPanel,
  shuffle,
  repeat,
  onHint,
  onToggle,
  onNext,
  onPrevious,
  onSeek,
  onShuffle,
  onRepeat,
  onSave,
  onStop,
}: {
  state: string;
  /** Stopped, but on a song with somewhere to carry on from. */
  canResume: boolean;
  /** The screen has settled and the row is under a centred column. */
  centred: boolean;
  panel: "queue" | "lyrics";
  onPanel: () => void;
  shuffle: boolean;
  repeat: RepeatMode;
  onHint: (text: string) => void;
  onToggle: () => void;
  onNext: () => void;
  onPrevious: () => void;
  /** Relative, in milliseconds; the store clamps it to the track. */
  onSeek: (deltaMs: number) => void;
  onShuffle: () => void;
  onRepeat: () => void;
  onSave: () => void;
  onStop: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "np-transport", saveLastFocusedChild: true });
  const box = useRef<HTMLDivElement | null>(null);

  /**
   * Where an arrow goes when it has nowhere to go inside this row.
   *
   * Measured on the box: Left on the first button left the screen with NOTHING
   * focused - still gone half a second later - and the next press recovered it
   * somewhere else entirely; Up threw the cursor across into the queue, because
   * navigation searches globally when it finds no candidate in the direction
   * asked for.
   *
   * Decided by geometry at press time rather than by position in the list,
   * because this row can WRAP on a narrow panel: which button is first on a line
   * depends on the panel, so Up from the second line has to keep working while
   * Up from the first has to reach the bar.
   */
  const atEdge = (key: string, dir: "up" | "left"): boolean => {
    const here = box.current?.querySelector<HTMLElement>(`[data-sfocus="${key}"]`);
    if (!here || !box.current) return false;
    const mine = here.getBoundingClientRect();
    const siblings = [...box.current.querySelectorAll<HTMLElement>("[data-sfocus]")].filter((el) => el !== here);
    return !siblings.some((el) => {
      const r = el.getBoundingClientRect();
      // Same line means the two boxes OVERLAP vertically - not that their tops
      // agree. Measured on the box: play/pause is the big button, so its top sits
      // 6px above its neighbours' while a comparison of tops allowed 4px, and
      // every neighbour was judged to be on another line. Left was therefore
      // swallowed as an edge and shuffle, previous and -10 could not be reached
      // from where focus starts. A tolerance is still wanted at the boundary,
      // because a focused button is scaled by 4% and its box moves.
      const sameLine = r.bottom > mine.top + 2 && r.top < mine.bottom - 2;
      return dir === "up" ? r.bottom <= mine.top + 2 : sameLine && r.right <= mine.left + 2;
    });
  };
  const edgeGuard =
    (key: string) =>
    (dir: string): boolean => {
      // Up from the top line is the way ONTO the bar. Named rather than left to
      // geometry: the queue is up and to the right of this row and would win.
      if (dir === "up" && atEdge(key, "up")) {
        setFocus("np-scrub");
        return false;
      }
      return !(dir === "left" && atEdge(key, "left"));
    };

  const on = t("music.on");
  const off = t("music.off");
  const playLabel =
    state === "playing" ? t("music.pause") : state === "paused" || canResume ? t("music.resume") : t("music.play");
  const repeatLabel = repeat === "one" ? t("music.repeatOne") : `${t("music.repeat")} · ${repeat === "all" ? on : off}`;

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        // Two refs on one element: spatial navigation's, and ours for measuring
        // where a button sits when an arrow reaches the edge of the row.
        ref={(el) => {
          box.current = el;
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
        }}
        className={["mt-[2.5vh] flex flex-wrap items-center gap-[1vw]", centred ? "justify-center" : ""].join(" ")}
      >
        <Button
          focusKey="np-shuffle"
          label={`${t("music.shuffle")} · ${shuffle ? on : off}`}
          active={shuffle}
          onHint={onHint}
          onEnter={onShuffle}
          onArrow={edgeGuard("np-shuffle")}
        >
          <ShuffleIcon className="h-[2.8vh] w-[2.8vh]" />
        </Button>
        <Button
          focusKey="np-prev"
          label={t("music.previous")}
          onHint={onHint}
          onEnter={onPrevious}
          onArrow={edgeGuard("np-prev")}
        >
          <PreviousIcon className="h-[2.8vh] w-[2.8vh]" />
        </Button>
        {/* There was no way to move inside a song from the buttons alone: the
            steppers change the track. The bar above takes the careful case; these
            two are the reflex. */}
        <Button
          focusKey="np-back10"
          label={t("music.back10")}
          onHint={onHint}
          onEnter={() => onSeek(-10_000)}
          onArrow={edgeGuard("np-back10")}
        >
          <Back10Icon className="h-[2.8vh] w-[2.8vh]" />
        </Button>
        <Button
          focusKey="np-toggle"
          // Three states, not two: playing, paused, and stopped with a queue
          // still in hand. That last one now carries on where the song was left
          // when it has somewhere to carry on from, and starts it otherwise -
          // which is what the two words are for.
          label={playLabel}
          big
          onHint={onHint}
          onEnter={onToggle}
          onArrow={edgeGuard("np-toggle")}
        >
          {state === "playing" ? (
            <PauseIcon className="h-[3.6vh] w-[3.6vh]" />
          ) : (
            <PlayIcon className="h-[3.6vh] w-[3.6vh]" />
          )}
        </Button>
        <Button
          focusKey="np-fwd10"
          label={t("music.forward10")}
          onHint={onHint}
          onEnter={() => onSeek(10_000)}
          onArrow={edgeGuard("np-fwd10")}
        >
          <Forward10Icon className="h-[2.8vh] w-[2.8vh]" />
        </Button>
        <Button
          focusKey="np-next"
          label={t("music.next")}
          onHint={onHint}
          onEnter={onNext}
          onArrow={edgeGuard("np-next")}
        >
          <NextIcon className="h-[2.8vh] w-[2.8vh]" />
        </Button>
        <Button
          focusKey="np-repeat"
          label={repeatLabel}
          active={repeat !== "off"}
          onHint={onHint}
          onEnter={onRepeat}
          onArrow={edgeGuard("np-repeat")}
        >
          <RepeatIcon one={repeat === "one"} className="h-[2.8vh] w-[2.8vh]" />
        </Button>
        {/* The words to the song, in the panel the queue usually has. Next to
            Save rather than beside the transport, because it changes what is on
            the screen rather than what the music is doing. */}
        <Button
          focusKey="np-lyrics"
          label={t("music.lyrics")}
          active={panel === "lyrics"}
          onHint={onHint}
          onEnter={onPanel}
          onArrow={edgeGuard("np-lyrics")}
        >
          <LyricsIcon className="h-[2.8vh] w-[2.8vh]" />
        </Button>
        <Button
          focusKey="np-save"
          label={t("music.saveAsPlaylist")}
          onHint={onHint}
          onEnter={onSave}
          onArrow={edgeGuard("np-save")}
        >
          <PlaylistAddIcon className="h-[2.8vh] w-[2.8vh]" />
        </Button>
        <Button
          focusKey="np-stop"
          label={t("music.stop")}
          onHint={onHint}
          onEnter={onStop}
          onArrow={edgeGuard("np-stop")}
        >
          <StopIcon className="h-[2.8vh] w-[2.8vh]" />
        </Button>
      </div>
    </FocusContext.Provider>
  );
}

/** A round icon button, and the one place the row's sizing lives. */
function Button({
  focusKey,
  label,
  active = false,
  big = false,
  onHint,
  onEnter,
  onArrow,
  children,
}: {
  focusKey: string;
  /** Spoken name, and what the line under the row says while this has focus. */
  label: string;
  active?: boolean;
  big?: boolean;
  onHint: (text: string) => void;
  onEnter: () => void;
  onArrow: (direction: string) => boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <FocusButton
      focusKey={focusKey}
      label={label}
      onEnter={onEnter}
      onArrowPress={onArrow}
      onFocused={() => onHint(label)}
      className={[
        "flex shrink-0 items-center justify-center rounded-full",
        big ? "h-[7.4vh] w-[7.4vh]" : "h-[6vh] w-[6vh]",
        // A mode that is ON is filled with the accent. Focus overrides it with
        // white, which is correct: focus has to stay the one unmistakable
        // highlight, and the line under the row is what says "on" in words.
        active ? "bg-[var(--color-accent)]" : "bg-white/10",
      ].join(" ")}
    >
      {children}
    </FocusButton>
  );
}
