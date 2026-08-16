// What is playing, and what is next.
//
// A full screen rather than an overlay, because there is no picture underneath
// to keep looking at - which is the whole difference from the film player. So
// the artwork can be large, the queue can be on screen at the same time, and
// nothing has to auto-hide.
//
// The transport row is the first thing focus lands on. Someone arriving here
// pressed a song a moment ago; what they want next is pause or skip, not the
// bottom of a list.

import { useRef, useState } from "react";
import { FocusContext, setFocus, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, Osk, useBackspace, useFocusableItem, useI18n } from "@sdk";
import { Message } from "../Message";
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
 * How far one press moves the scrub cursor.
 *
 * Five seconds, where the film player's step is larger: a song is three minutes,
 * so this crosses one end to the other in about forty presses - and the remote
 * repeats while a key is held, so that is a second or two of holding rather than
 * forty deliberate presses.
 */
const SCRUB_STEP_MS = 5_000;

export function NowPlaying(): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const back = useApp((s) => s.back);
  const queue = useMusic((s) => s.queue);
  const index = useMusic((s) => s.index);
  const state = useMusic((s) => s.state);
  const positionMs = useMusic((s) => s.positionMs);
  const durationMs = useMusic((s) => s.durationMs);
  const scrubMs = useMusic((s) => s.scrubMs);
  const buffering = useMusic((s) => s.buffering);
  const shuffle = useMusic((s) => s.shuffle);
  const repeat = useMusic((s) => s.repeat);
  const error = useMusic((s) => s.error);
  const music = useMusic();

  const [naming, setNaming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // What the focused control is called. The row is icons now, and an icon row
  // with nothing naming it is a row of guesses - see the note on the row itself.
  const [hint, setHint] = useState<string | null>(null);

  const item = queue[index];
  // Before either early return below: a hook cannot be called conditionally, and
  // both the keyboard and the empty state return ahead of the artwork.
  const cover = useArtwork(
    item && backend ? backend.posterUrl(item, 600 * artworkScale(), 600 * artworkScale()) : undefined,
  );
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
      {/* The song on the left, the queue on the right. Both are on screen at
          once on purpose: "what is next" is the question this screen gets asked
          most, and a queue behind a button is a queue nobody looks at. */}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        {cover && <img src={cover} alt="" className="mb-[2.5vh] h-[34vh] w-[34vh] rounded-[1.5vh] object-cover" />}
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
          onFocusedChange={(on) => on && setHint(t("music.seekHint"))}
        />

        {(buffering || error || note) && (
          <p className="mt-[1vh] text-[2vh] text-fg-dim">
            {note ?? (error ? t("music.trackFailed", { title: error }) : t("common.loading"))}
          </p>
        )}

        <Transport
          state={state}
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

      <div className="flex w-[34vw] min-w-0 flex-col">
        <h2 className="shrink-0 px-[1.5vw] pb-[1vh] text-[2.4vh] text-fg-dim">
          {t("music.upNext")} · {Math.max(0, queue.length - index - 1)}
        </h2>
        {/* py, because the focus ring scales a row by 4% and the container's own
            edge clipped the top one in half. */}
        <ul className="no-scrollbar min-h-0 flex-1 overflow-y-auto py-[0.6vh]">
          {/* Bounded. A shuffle of this library is 572 rows, and every one of
              them would otherwise be a mounted focusable that spatial navigation
              measures on each press - the songs list windows for the same
              reason. What is past here is still in the queue and still plays; it
              is only not drawn. */}
          {queue.slice(index, index + QUEUE_ROWS).map((x, i) => (
            <li key={`${x.id}-${index + i}`} style={{ height: `${TRACK_ROW_VH}vh` }}>
              <TrackRow
                item={x}
                focusKey={`nq-${index + i}`}
                ordinal={index + i + 1}
                playing={i === 0}
                onEnter={() => void music.playAt(index + i)}
              />
            </li>
          ))}
        </ul>
      </div>
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
  onFocusedChange,
}: {
  positionMs: number;
  durationMs: number;
  scrubMs: number | null;
  onScrub: (deltaMs: number) => void;
  onCommit: () => void;
  onToggle: () => void;
  onFocusedChange: (focused: boolean) => void;
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
        onScrub(direction === "left" ? -SCRUB_STEP_MS : SCRUB_STEP_MS);
        return false;
      }
      // Nothing is above the bar, and letting the press go unhandled sent the
      // cursor across into the queue - navigation searches globally when it
      // finds no candidate in the direction asked for.
      if (direction === "up") return false;
      return true;
    },
  });

  // Reported rather than read from here, so the line under the buttons can name
  // this row too. Effect-free on purpose: the parent only ever stores a string.
  const wasFocused = useRef(false);
  if (focused !== wasFocused.current) {
    wasFocused.current = focused;
    onFocusedChange(focused);
  }

  return (
    <div ref={ref} className="mt-[2.5vh] flex items-center gap-[1vw]">
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
      // A tolerance, because a focused button is scaled by 4% and its box moves.
      return dir === "up" ? r.bottom <= mine.top + 2 : Math.abs(r.top - mine.top) < 4 && r.right <= mine.left + 2;
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
  const playLabel = state === "playing" ? t("music.pause") : state === "paused" ? t("music.resume") : t("music.play");
  const repeatLabel =
    repeat === "one" ? t("music.repeatOne") : `${t("music.repeat")} · ${repeat === "all" ? on : off}`;

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        // Two refs on one element: spatial navigation's, and ours for measuring
        // where a button sits when an arrow reaches the edge of the row.
        ref={(el) => {
          box.current = el;
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
        }}
        className="mt-[2.5vh] flex flex-wrap items-center gap-[1vw]"
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
          // Three states, not two. Stopped-with-a-queue restarts the track from
          // the beginning, so calling it "Resume" promised something it does not
          // do.
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
