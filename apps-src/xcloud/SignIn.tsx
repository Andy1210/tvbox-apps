import { useCallback, useEffect, useRef, useState } from "react";
import { FocusButton, useI18n } from "@sdk";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import * as api from "./api";

// The device-code screen. Nothing is typed on the television: the code goes on
// the phone, which is why this flow was chosen over a redirect.
//
// The POLL runs in the plugin, not here, and that is deliberate - it lasts up to
// fifteen minutes, and a page that reloads or navigates away would otherwise
// abandon a sign-in the person is halfway through on their phone. This screen only
// asks the plugin how it went.
const POLL_MS = 2000;

export function SignIn({
  status,
  onSignedIn,
  onExit,
}: {
  status: api.Status | null;
  onSignedIn: () => void;
  onExit: () => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState<{ userCode: string; verificationUri: string; expiresIn: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const message = useCallback(
    (codeName: string | undefined) => t("errors." + (codeName || "generic")) || t("errors.generic"),
    [t],
  );

  const stopPolling = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }, []);

  const poll = useCallback(() => {
    stopPolling();
    timer.current = setInterval(async () => {
      try {
        const s = await api.signInState();
        if (s.state === "done") {
          stopPolling();
          onSignedIn();
        } else if (s.state === "failed") {
          stopPolling();
          setCode(null);
          setError(message(s.code));
        }
      } catch {
        // A route that momentarily fails is not a failed sign-in; the next tick
        // asks again.
      }
    }, POLL_MS);
  }, [message, onSignedIn, stopPolling]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const dc = await api.startSignIn();
      setCode(dc);
      poll();
    } catch (e) {
      setError(message((e as api.ApiError).code));
    } finally {
      setBusy(false);
    }
  }, [message, poll]);

  // An account that exists but cannot be used - suspended, a child account, a
  // country without Game Pass - is not a missing sign-in, and starting another one
  // would not help. Say what it is instead.
  const unusable = status && status.signedIn && status.usable === false ? message(status.code) : null;

  useEffect(() => {
    // If the plugin is already mid-sign-in (this screen was reopened), pick the
    // code back up rather than asking Microsoft for a second one.
    if (status && status.signingIn && status.code) {
      setCode(status.code as unknown as typeof code);
      poll();
    }
    return stopPolling;
  }, [status, poll, stopPolling]);

  useEffect(() => {
    const id = setTimeout(() => setFocus(code ? "signin-cancel" : "signin-start"), 0);
    return () => clearTimeout(id);
  }, [code]);

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-8 bg-bg-0 px-16 text-fg">
      <h1 className="text-4xl font-semibold">{t("signin.heading")}</h1>

      {unusable && <p className="max-w-3xl text-center text-2xl text-warn">{unusable}</p>}
      {error && <p className="max-w-3xl text-center text-2xl text-warn">{error}</p>}

      {code ? (
        <>
          <p className="text-2xl text-fg-dim">{t("signin.instruction")}</p>
          <p className="text-3xl text-fg-dim">{code.verificationUri}</p>
          {/* The code is the whole point of this screen, so it is the biggest
              thing on it and spaced out to be read from a sofa. */}
          <p className="text-8xl font-bold tracking-[0.2em] text-accent">{code.userCode}</p>
          <p className="text-xl text-fg-dim">{t("signin.expiresIn", { minutes: Math.round(code.expiresIn / 60) })}</p>
          <p className="text-xl text-fg-dim">{t("signin.keepOpen")}</p>
          <p className="text-xl text-fg-dim">{t("signin.waiting")}</p>
          <FocusButton
            focusKey="signin-cancel"
            className="rounded-xl bg-bg-1 px-10 py-4 text-2xl"
            onEnter={() => {
              stopPolling();
              void api.cancelSignIn().catch(() => {});
              setCode(null);
            }}
          >
            {t("signin.cancel")}
          </FocusButton>
        </>
      ) : (
        <div className="flex gap-6">
          <FocusButton
            focusKey="signin-start"
            className="rounded-xl bg-accent px-12 py-5 text-3xl font-semibold"
            onEnter={() => void start()}
          >
            {busy ? "…" : error ? t("signin.retry") : t("signin.start")}
          </FocusButton>
          <FocusButton focusKey="signin-exit" className="rounded-xl bg-bg-1 px-10 py-5 text-2xl" onEnter={onExit}>
            {t("stream.stop")}
          </FocusButton>
        </div>
      )}
    </div>
  );
}
