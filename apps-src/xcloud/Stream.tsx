import { useCallback, useEffect, useRef, useState } from "react";
import { FocusButton, useI18n } from "@sdk";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import * as api from "./api";
import { connect, type Phase, type StreamHandle } from "./stream/connection";
import type { ServerDialog } from "./stream/channels";

// The stream. Two waits happen here and they are different things: the SERVER
// getting ready (a queue, measured at 224 s on this account, so it needs a screen
// of its own) and then the WebRTC connection coming up (seconds).
//
// The queue estimate the server offers is shown as prose, never as a countdown: it
// said 10 seconds for a wait that took 224, and a timer that expires while you are
// still waiting is worse than no timer at all.
const STATE_POLL_MS = 1500;
// Once it is playing, the only thing left to watch for is the session ending.
const WATCH_POLL_MS = 3000;

export function Stream({
  title,
  onLeave,
  onUiNeedsPad,
}: {
  title: api.Title;
  onLeave: () => void;
  /**
   * True while something of OURS is on screen over the game.
   *
   * The pad belongs to the game while it is playing, which is why the app stops
   * spatial navigation for the duration - but a dialog or a failure is our own
   * screen, and a remote is not the only thing in the room. So the pad comes back
   * for exactly as long as one is up, and the game stops hearing it.
   */
  onUiNeedsPad: (needed: boolean) => void;
}) {
  const { t, tag } = useI18n();
  const video = useRef<HTMLVideoElement | null>(null);
  // The audio arrives as its OWN track, and assuming otherwise is why there was
  // no sound: `ontrack` fires once per kind, and the video element only carries
  // what is in the stream handed to IT.
  const audio = useRef<HTMLAudioElement | null>(null);
  const handle = useRef<StreamHandle | null>(null);
  const [phase, setPhase] = useState<Phase | "provisioning" | "queued">("provisioning");
  const [queueSeconds, setQueueSeconds] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Counted here rather than taken from the plugin: the plugin re-asks the server
  // at most every 30 s, and a number that only moves twice a minute is exactly
  // what "it has frozen" looks like.
  const [elapsed, setElapsed] = useState(0);
  // A question the SERVER asked and expects us to draw. Until this existed, the
  // Xbox guide's "quit the game?" left a dark overlay over a game that was still
  // running and still making sound, waiting for an answer nothing could give.
  const [dialog, setDialog] = useState<ServerDialog | null>(null);

  const message = useCallback(
    (code: string | undefined) => t("errors." + (code || "generic")) || t("errors.generic"),
    [t],
  );

  const leave = useCallback(() => {
    handle.current?.close();
    handle.current = null;
    onLeave();
  }, [onLeave]);

  useEffect(() => {
    let alive = true;
    let poll: ReturnType<typeof setInterval> | null = null;

    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };

    void (async () => {
      try {
        await api.startSession(title.titleId, window.innerWidth || 1920, window.innerHeight || 1080, tag);
      } catch (e) {
        if (alive) setError(message((e as api.ApiError).code));
        return;
      }

      // The ladder runs in the plugin; this asks how far along it is. Polling
      // rather than a socket because the answer changes a handful of times.
      poll = setInterval(async () => {
        if (!alive) return;
        const s = await api.sessionState().catch(() => null);
        if (!s || !alive) return;

        if (s.state === "WaitingForResources") {
          setPhase("queued");
          setQueueSeconds(typeof s.queueSeconds === "number" ? s.queueSeconds : null);
          return;
        }
        if (s.state === "Failed") {
          stopPolling();
          setError(s.error ? s.error : message(s.code));
          return;
        }
        // The server ended it - somebody quit from the Xbox guide. A normal way
        // out, so it leaves rather than reporting a failure.
        if (s.ended) {
          stopPolling();
          console.log("[xcloud] session ended:", s.ended);
          leave();
          return;
        }
        if (s.state === "Provisioned" && s.config) {
          // Slower from here, but NOT stopped: this poll is the only way the page
          // hears that the server ended the session, and stopping it left a frozen
          // picture until WebRTC's ICE timeout gave up half a minute later.
          stopPolling();
          poll = setInterval(() => {
            if (!alive) return;
            void api.sessionState().then((now) => {
              if (!alive || (!now.ended && now.active !== false)) return;
              stopPolling();
              console.log("[xcloud] session ended:", now.ended || "no longer active");
              leave();
            }).catch(() => {
              /* a blip on the loopback API is not a session ending */
            });
          }, WATCH_POLL_MS);
          try {
            handle.current = await connect(
              {
              onPhase: (p, detail) => {
                if (!alive) return;
                setPhase(p);
                if (p === "failed") {
                  // The detail is ours ("connection disconnected") and was going
                  // straight to the television. It goes to the log; the screen
                  // gets a sentence.
                  if (detail) console.warn("[xcloud] stream failed:", detail);
                  setError(t("stream.failed"));
                }
              },
                onDialog: (d) => {
                  if (alive) setDialog(d);
                },
                onEnded: (why) => {
                  if (!alive) return;
                  console.log("[xcloud] stream ended:", why);
                  leave();
                },
                onStream: (stream, kind) => {
                  const el = kind === "video" ? video.current : audio.current;
                  if (!el) return;
                  el.srcObject = stream;
                  void el.play().catch((e) => {
                    // Autoplay is allowed here - the window was opened by a press
                    // - so a refusal is worth seeing rather than swallowing.
                    // Silence with a playing picture is exactly what this looked
                    // like.
                    console.warn("[xcloud] " + kind + " would not start:", String(e));
                  });
                },
              },
              // The plugin sends the saved quality with the session state, so the
              // offer carries it without a second round trip at the one moment
              // that matters.
              s.quality,
            );
          } catch (e) {
            if (alive) setError((e as Error).message || t("stream.failed"));
          }
        }
      }, STATE_POLL_MS);
    })();

    return () => {
      alive = false;
      stopPolling();
      handle.current?.close();
      handle.current = null;
    };
  }, [title.titleId, message, leave, t, tag]);

  const answer = useCallback(
    (index: number) => {
      if (!dialog) return;
      handle.current?.answerDialog(dialog.id, index);
      setDialog(null);
    },
    [dialog],
  );

  // The server's own default is the safe one for a destructive question - it
  // points at "Never mind", not "Quit game".
  useEffect(() => {
    if (!dialog) return;
    const id = setTimeout(() => setFocus("dlg-" + dialog.defaultIndex), 0);
    return () => clearTimeout(id);
  }, [dialog]);

  // Any Back or Escape leaves. The shell's own Back handling is for navigating
  // between screens; a running stream has to be able to end from the remote.
  //
  // While the server is asking something, Back answers ITS cancel option instead:
  // leaving the stream with the question unanswered is how the session was left
  // dimmed in the first place.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Backspace" && e.key !== "BrowserBack") return;
      e.preventDefault();
      if (dialog) answer(dialog.cancelIndex);
      else leave();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [leave, dialog, answer]);

  const playing = phase === "playing";
  // Ours on screen: a dialog the server asked for, a failure, or the waiting
  // screen before anything is playing.
  const uiOnTop = !!dialog || !!error || !playing;
  useEffect(() => {
    onUiNeedsPad(uiOnTop);
    handle.current?.setInputEnabled(!uiOnTop);
  }, [uiOnTop, onUiNeedsPad]);
  useEffect(() => () => onUiNeedsPad(false), [onUiNeedsPad]);

  // One second, from when this screen opened. It is the only honest number here -
  // the server's own estimate said 10 s for a wait measured at 224 - and a value
  // that moves every second is what says the box is still working rather than
  // stuck.
  useEffect(() => {
    if (playing) return;
    const id = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [playing]);

  // Leaving must be reachable from the remote at every moment this screen is up,
  // including the failure. It was a paragraph that read like a button - so a
  // stream that dropped left the box with nothing to press.
  useEffect(() => {
    if (playing) return;
    const id = setTimeout(() => setFocus("stream-leave"), 0);
    return () => clearTimeout(id);
  }, [playing, error]);

  const waitLabel = error
    ? null
    : phase === "queued"
      ? t("stream.queued")
      : phase === "provisioning"
        ? t("stream.starting")
        : phase === "offering" || phase === "answered"
          ? t("stream.negotiating")
          : t("stream.connecting");

  return (
    <div className="relative h-screen w-screen bg-black">
      {/* Always mounted: assigning srcObject to an element that has not rendered
          yet loses the stream, and a stream cannot be asked for again. */}
      <video
        ref={video}
        autoPlay
        playsInline
        // Not muted: the sound is on the audio element below, and muting this one
        // would also silence anything the server does put in the video stream.
        className={"h-full w-full object-contain " + (playing ? "opacity-100" : "opacity-0")}
      />
      {/* Its own element, because the server sends audio as a separate track and
          `ontrack` hands it over as a separate stream. Nothing to show, but it has
          to be in the document to play. */}
      <audio ref={audio} autoPlay />

      {/* Over the running game, because that is what it is: the guide dimmed the
          picture and handed the question over. */}
      {dialog && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-[6vw]">
          <div className="w-[54vw] rounded-2xl bg-bg-1 p-[3vw] text-fg">
            <h2 className="mb-[1.5vh] text-3xl font-semibold">{dialog.title}</h2>
            {dialog.body && <p className="mb-[3vh] text-2xl text-fg-dim">{dialog.body}</p>}
            <div className="flex flex-wrap gap-4">
              {dialog.buttons.map((label, i) => (
                <FocusButton
                  key={label + i}
                  focusKey={"dlg-" + i}
                  className="rounded-xl bg-bg-0 px-8 py-4 text-2xl"
                  onEnter={() => answer(i)}
                >
                  {label}
                </FocusButton>
              ))}
            </div>
          </div>
        </div>
      )}

      {!playing && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-[3vh] px-16 text-center">
          <Waiting tile={title.tile} still={!!error} />
          <h1 className="text-4xl font-semibold text-fg">{title.name || title.titleId}</h1>

          {error ? (
            <p className="max-w-3xl text-2xl text-warn">{error}</p>
          ) : (
            <>
              <p className="text-2xl text-fg-dim">{waitLabel}</p>
              {/* The elapsed time is the truthful one and it ticks; the server's
                  estimate is labelled as the server's, because it was an order of
                  magnitude out when it was measured. Neither is a countdown - a
                  timer that expires while you are still waiting is worse than no
                  timer at all. */}
              <p className="text-xl text-fg-dim">
                {t("stream.elapsed", { time: clock(elapsed) })}
                {phase === "queued" && queueSeconds ? " · " + t("stream.estimate", { minutes: Math.max(1, Math.round(queueSeconds / 60)) }) : ""}
              </p>
              {phase === "queued" && <p className="text-xl text-fg-dim">{t("stream.queuedHint")}</p>}
            </>
          )}

          {title.maxPlaySeconds > 0 && (
            <p className="text-xl text-warn">{t("stream.trial", { minutes: Math.round(title.maxPlaySeconds / 60) })}</p>
          )}

          <FocusButton
            focusKey="stream-leave"
            className="mt-[2vh] rounded-xl bg-bg-1 px-10 py-4 text-2xl"
            onEnter={leave}
          >
            {t("stream.stop")}
          </FocusButton>
        </div>
      )}
    </div>
  );
}

/**
 * The waiting animation: the game's own cover, breathing.
 *
 * One moving thing rather than three. It is a `transform`, which with `opacity`
 * is the only composited property on this box - a glow or an animated gradient
 * here would cost more GPU than the video about to arrive.
 *
 * It stops on a failure: motion that carries on after something has gone wrong
 * reads as "still trying", which is the opposite of what the screen then says.
 */
function Waiting({ tile, still }: { tile: string; still: boolean }) {
  const shape = "h-full w-full rounded-[1.6vh] ";
  return (
    <div className="relative h-[24vh] w-[24vh]">
      {tile ? (
        <img src={tile} alt="" className={shape + "object-cover " + (still ? "opacity-50" : "xc-breathe")} />
      ) : (
        <div className={shape + "bg-bg-1 " + (still ? "" : "xc-breathe")} />
      )}
    </div>
  );
}

/** m:ss, because a bare second count past a minute is hard to read at a glance. */
function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? m + ":" + String(s).padStart(2, "0") : String(s) + "s";
}
