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
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, Osk, useI18n } from "@sdk";
import { Message } from "../Message";
import { TrackRow, TRACK_ROW_VH } from "./TrackRow";
import { artworkScale } from "../posters";
import { useFocusFallback, useInitialFocus } from "../focus";
import { useApp } from "../state";
import { useMusic, type RepeatMode } from "../playback/music";
import { useArtwork } from "./useArtwork";
import { clock } from "../time";
import { log } from "../redact";

/** How much of the queue is drawn. See the note where it is used. */
const QUEUE_ROWS = 60;

export function NowPlaying(): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const back = useApp((s) => s.back);
  const queue = useMusic((s) => s.queue);
  const index = useMusic((s) => s.index);
  const state = useMusic((s) => s.state);
  const positionMs = useMusic((s) => s.positionMs);
  const durationMs = useMusic((s) => s.durationMs);
  const buffering = useMusic((s) => s.buffering);
  const shuffle = useMusic((s) => s.shuffle);
  const repeat = useMusic((s) => s.repeat);
  const error = useMusic((s) => s.error);
  const music = useMusic();

  const [naming, setNaming] = useState(false);
  const [note, setNote] = useState<string | null>(null);

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
  const pct = durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0;

  return (
    <div className="relative z-10 flex h-full gap-[3vw] px-[5vw] py-[4vh]">
      {/* The song on the left, the queue on the right. Both are on screen at
          once on purpose: "what is next" is the question this screen gets asked
          most, and a queue behind a button is a queue nobody looks at. */}
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        {cover && <img src={cover} alt="" className="mb-[2.5vh] h-[38vh] w-[38vh] rounded-[1.5vh] object-cover" />}
        <h1 className="truncate text-[4.4vh] font-bold">{item.title}</h1>
        {artist && <p className="truncate text-[2.6vh] text-fg-dim">{artist}</p>}
        {item.parentTitle && item.parentTitle !== artist && (
          <p className="truncate text-[2.2vh] text-fg-dim">{item.parentTitle}</p>
        )}

        <div className="mt-[2.5vh] flex items-center gap-[1vw]">
          <span className="w-[8vw] text-[2vh] text-fg-dim tabular-nums">{clock(positionMs)}</span>
          <div className="h-[0.7vh] flex-1 overflow-hidden rounded-full bg-white/15">
            <div className="h-full rounded-full bg-white/80" style={{ width: `${pct}%` }} />
          </div>
          <span className="w-[8vw] text-right text-[2vh] text-fg-dim tabular-nums">{clock(durationMs)}</span>
        </div>

        {(buffering || error || note) && (
          <p className="mt-[1vh] text-[2vh] text-fg-dim">
            {note ?? (error ? t("music.trackFailed", { title: error }) : t("common.loading"))}
          </p>
        )}

        <Transport
          state={state}
          shuffle={shuffle}
          repeat={repeat}
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

function Transport({
  state,
  shuffle,
  repeat,
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
  const chip = "shrink-0 rounded-[1vh] px-[1.6vw] py-[1.1vh] text-[2.2vh]";

  /**
   * Swallow an arrow that has nowhere to go inside this row.
   *
   * Measured on the box: Left on the first chip left the screen with NOTHING
   * focused - still gone half a second later - and the next press recovered it
   * somewhere else entirely; Up on play/pause threw the cursor across into the
   * queue, because nothing above the transport is focusable so navigation
   * searched globally.
   *
   * Decided by geometry at press time rather than by position in the list,
   * because this row WRAPS: which chip is first on a line depends on the panel,
   * so Up from the second line has to keep working while Up from the first has
   * to be consumed.
   */
  const atEdge = (key: string, dir: "up" | "left"): boolean => {
    const here = box.current?.querySelector<HTMLElement>(`[data-sfocus="${key}"]`);
    if (!here || !box.current) return false;
    const mine = here.getBoundingClientRect();
    const siblings = [...box.current.querySelectorAll<HTMLElement>("[data-sfocus]")].filter((el) => el !== here);
    return !siblings.some((el) => {
      const r = el.getBoundingClientRect();
      // A tolerance, because a focused chip is scaled by 4% and its box moves.
      return dir === "up" ? r.bottom <= mine.top + 2 : Math.abs(r.top - mine.top) < 4 && r.right <= mine.left + 2;
    });
  };
  const edgeGuard =
    (key: string) =>
    (dir: string): boolean =>
      (dir === "up" || dir === "left") && atEdge(key, dir) ? false : true;
  const on = "bg-white/25";
  const off = "bg-white/10";

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        // Two refs on one element: spatial navigation's, and ours for measuring
        // where a chip sits when an arrow reaches the edge of the row.
        ref={(el) => {
          box.current = el;
          (ref as React.MutableRefObject<HTMLDivElement | null>).current = el;
        }}
        className="mt-[2.5vh] flex flex-wrap items-center gap-[0.8vw]"
      >
        <FocusButton
          focusKey="np-prev"
          onArrowPress={edgeGuard("np-prev")}
          onEnter={onPrevious}
          className={`${chip} ${off}`}
        >
          {t("music.previous")}
        </FocusButton>
        <FocusButton
          focusKey="np-toggle"
          onArrowPress={edgeGuard("np-toggle")}
          onEnter={onToggle}
          className={`${chip} ${off}`}
        >
          {/* Three states, not two. Stopped-with-a-queue restarts the track from
              the beginning, so calling it "Resume" promised something it does
              not do. */}
          {state === "playing" ? t("music.pause") : state === "paused" ? t("music.resume") : t("music.play")}
        </FocusButton>
        <FocusButton
          focusKey="np-next"
          onArrowPress={edgeGuard("np-next")}
          onEnter={onNext}
          className={`${chip} ${off}`}
        >
          {t("music.next")}
        </FocusButton>
        {/* There was no way to move inside a song at all: the progress bar is a
            picture, and Previous/Next change the track. A long mix or a podcast
            episode needs a step, and two chips are what a D-pad can aim at. */}
        <FocusButton
          focusKey="np-back10"
          onArrowPress={edgeGuard("np-back10")}
          onEnter={() => onSeek(-10_000)}
          className={`${chip} ${off}`}
        >
          {t("music.back10")}
        </FocusButton>
        <FocusButton
          focusKey="np-fwd10"
          onArrowPress={edgeGuard("np-fwd10")}
          onEnter={() => onSeek(10_000)}
          className={`${chip} ${off}`}
        >
          {t("music.forward10")}
        </FocusButton>
        {/* The two modes show their state in the chip rather than in an icon:
            a filled shape means nothing to someone who has not been told, and
            this is the only place either mode can be read. */}
        <FocusButton
          focusKey="np-shuffle"
          onArrowPress={edgeGuard("np-shuffle")}
          onEnter={onShuffle}
          className={`${chip} ${shuffle ? on : off}`}
        >
          {t("music.shuffle")}
        </FocusButton>
        <FocusButton
          focusKey="np-repeat"
          onArrowPress={edgeGuard("np-repeat")}
          onEnter={onRepeat}
          className={`${chip} ${repeat === "off" ? off : on}`}
        >
          {repeat === "one" ? t("music.repeatOne") : t("music.repeat")}
        </FocusButton>
        <FocusButton
          focusKey="np-save"
          onArrowPress={edgeGuard("np-save")}
          onEnter={onSave}
          className={`${chip} ${off}`}
        >
          {t("music.saveAsPlaylist")}
        </FocusButton>
        <FocusButton
          focusKey="np-stop"
          onArrowPress={edgeGuard("np-stop")}
          onEnter={onStop}
          className={`${chip} ${off}`}
        >
          {t("music.stop")}
        </FocusButton>
      </div>
    </FocusContext.Provider>
  );
}
