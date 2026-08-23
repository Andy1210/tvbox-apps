import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@sdk";
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
  const handle = useRef<StreamHandle | null>(null);
  const [phase, setPhase] = useState<Phase | "provisioning" | "queued">("provisioning");
  const [queuedFor, setQueuedFor] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
          setQueuedFor(s.queuedFor || 0);
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
            handle.current = await connect({
              onPhase: (p, detail) => {
                if (!alive) return;
                setPhase(p);
                if (p === "failed") setError(detail || t("stream.failed"));
              },
              onStream: (stream, kind) => {
                // One element carries both: the audio track arrives in the same
                // MediaStream, and a separate <audio> would be a second clock to
                // keep in sync with the picture.
                if (kind === "video" && video.current) {
                  video.current.srcObject = stream;
                  void video.current.play().catch(() => {
                    /* autoplay is allowed here - the window is a user gesture away */
                  });
                }
              },
              // The Xbox button is the way out on a television, so it is caught
              // here rather than forwarded into the game.
              onNexus: leave,
            });
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

  return (
    <div className="relative h-screen w-screen bg-black">
      {/* Always mounted: assigning srcObject to an element that has not rendered
          yet loses the stream, and a stream cannot be asked for again. */}
      <video
        ref={video}
        autoPlay
        playsInline
        // Muted would be silent gameplay; the window is opened by a press, so
        // autoplay with sound is allowed here.
        className={"h-full w-full object-contain " + (playing ? "opacity-100" : "opacity-0")}
      />

      {!playing && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 px-16 text-center">
          <h1 className="text-4xl font-semibold text-fg">{title.name || title.titleId}</h1>
          {error ? (
            <>
              <p className="max-w-3xl text-2xl text-warn">{error}</p>
              <p className="text-xl text-fg-dim">{t("stream.stop")}</p>
            </>
          ) : phase === "queued" ? (
            <>
              <p className="text-2xl text-fg-dim">{t("stream.queued")}</p>
              {queuedFor > 0 && <p className="text-xl text-fg-dim">{t("stream.queuedFor", { seconds: queuedFor })}</p>}
            </>
          ) : (
            <p className="text-2xl text-fg-dim">
              {phase === "provisioning"
                ? t("stream.starting")
                : phase === "offering" || phase === "answered"
                  ? t("stream.negotiating")
                  : t("stream.connecting")}
            </p>
          )}
          {title.maxPlaySeconds > 0 && (
            <p className="text-xl text-warn">{t("stream.trial", { minutes: Math.round(title.maxPlaySeconds / 60) })}</p>
          )}
        </div>
      )}
    </div>
  );
}
