import { useCallback, useEffect, useRef, useState } from "react";
import { FocusButton, useI18n } from "@sdk";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import * as api from "./api";
import { connect, type Phase, type StreamHandle } from "./stream/connection";

// The stream. Two waits happen here and they are different things: the SERVER
// getting ready (a queue, measured at 224 s on this account, so it needs a screen
// of its own) and then the WebRTC connection coming up (seconds).
//
// The queue estimate the server offers is shown as prose, never as a countdown: it
// said 10 seconds for a wait that took 224, and a timer that expires while you are
// still waiting is worse than no timer at all.
const STATE_POLL_MS = 1500;

export function Stream({ title, onLeave }: { title: api.Title; onLeave: () => void }) {
  const { t } = useI18n();
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
        await api.startSession(title.titleId, window.innerWidth || 1920, window.innerHeight || 1080);
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
        if (s.state === "Provisioned" && s.config) {
          stopPolling();
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
  }, [title.titleId, message, leave, t]);

  // Any Back or Escape leaves. The shell's own Back handling is for navigating
  // between screens; a running stream has to be able to end from the remote.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Backspace" || e.key === "BrowserBack") {
        e.preventDefault();
        leave();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [leave]);

  const playing = phase === "playing";

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
 * The waiting animation: the game's own cover, breathing, with rings leaving it
 * and an arc going round.
 *
 * Every moving part is a `transform` or an `opacity` and nothing else, because
 * those two are the only composited properties on this box - a glow or an
 * animated gradient here would cost more GPU than the video about to arrive.
 *
 * It stops on a failure: motion that carries on after something has gone wrong
 * reads as "still trying", which is the opposite of what the screen then says.
 */
function Waiting({ tile, still }: { tile: string; still: boolean }) {
  const ring = "absolute inset-0 rounded-[1.6vh] border-2 border-focus";
  return (
    <div className="relative h-[22vh] w-[22vh]">
      {!still && (
        <>
          <span className={ring + " xc-ring"} aria-hidden="true" />
          <span className={ring + " xc-ring xc-ring-2"} aria-hidden="true" />
          <span className={ring + " xc-ring xc-ring-3"} aria-hidden="true" />
          {/* The arc: a dashed circle, rotated. The dash is static - only the
              rotation moves - so nothing is re-rasterised per frame. */}
          <svg className="xc-spin absolute -inset-[2vh]" viewBox="0 0 100 100" aria-hidden="true">
            <circle
              cx="50"
              cy="50"
              r="47"
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray="52 243"
            />
          </svg>
        </>
      )}
      {tile ? (
        <img
          src={tile}
          alt=""
          className={"h-full w-full rounded-[1.6vh] object-cover " + (still ? "opacity-50" : "xc-breathe")}
        />
      ) : (
        <div className={"h-full w-full rounded-[1.6vh] bg-bg-1 " + (still ? "" : "xc-breathe")} />
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
