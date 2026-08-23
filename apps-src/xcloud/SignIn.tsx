import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { FocusButton, useBackspace, useI18n } from "@sdk";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import * as api from "./api";
import { errorText } from "./errors";

// The device-code screen. Nothing is typed on the television: the code goes on
// the phone, which is why this flow was chosen over a redirect.
//
// The POLL runs in the plugin, not here, and that is deliberate - it lasts up to
// fifteen minutes, and a page that reloads or navigates away would otherwise
// abandon a sign-in the person is halfway through on their phone. This screen only
// asks the plugin how it went.
const POLL_MS = 2000;

// Microsoft's device pages take the code as `otc`, so a scanned QR skips the
// typing entirely rather than only saving the URL. If that parameter is ever
// ignored the page still opens and the code is on screen to type, which is why it
// is safe to include: the QR is a shortcut, never the only way in.
const codeUrl = (uri: string, code: string) => {
  try {
    const u = new URL(uri);
    u.searchParams.set("otc", code);
    return u.toString();
  } catch {
    return uri;
  }
};

export function SignIn({
  status,
  onSignedIn,
  onSignedOut,
  onExit,
}: {
  status: api.Status | null;
  onSignedIn: () => void;
  onSignedOut: () => void;
  onExit: () => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState<api.DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState("");
  // Seconds left on the code, ticked here. The plugin answers with the ORIGINAL
  // lifetime, so a screen resumed after a reload - which this flow is built to
  // survive - said "valid for 15 minutes" about a code with two left, and then
  // simply failed.
  const [left, setLeft] = useState(0);
  const secondsLeft = (dc: api.DeviceCode) =>
    Math.max(0, Math.round(((dc.expiresAt || Date.now() + dc.expiresIn * 1000) - Date.now()) / 1000));
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const message = useCallback((code: string | undefined) => errorText(t, code), [t]);

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
      // Seeded with the code, not left at 0: the ticker runs in an effect, so the
      // first painted frame otherwise read "the code expires in 0 seconds".
      setLeft(secondsLeft(dc));
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
    // A sign-in lives in the plugin, not in this page - it lasts up to fifteen
    // minutes and the poll must survive a reload. So if one is already running,
    // pick the code back up rather than asking Microsoft for a second one and
    // making the person retype.
    if (status && status.signingIn && status.pending) {
      setLeft(secondsLeft(status.pending));
      setCode(status.pending);
      poll();
    }
    return stopPolling;
  }, [status, poll, stopPolling]);

  useEffect(() => {
    if (!code) return;
    // `expiresAt` is what the plugin says, so a resumed sign-in counts from the
    // real deadline rather than from when this page happened to open.
    const tick = () => setLeft(secondsLeft(code));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [code]);

  useEffect(() => {
    if (!code) return setQr("");
    let alive = true;
    QRCode.toDataURL(codeUrl(code.verificationUri, code.userCode), { width: 420, margin: 1 })
      .then((d) => alive && setQr(d))
      // No QR is not a broken screen: the URL and the code are both on it.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code]);

  useEffect(() => {
    const id = setTimeout(() => setFocus(code ? "signin-cancel" : "signin-start"), 0);
    return () => clearTimeout(id);
  }, [code]);

  // Back walks back, as it does on every other screen of this app and every other
  // app on the box. It did nothing at all here, on all three states - and on the
  // code screen the only focusable is Cancel, so there was no way out of the app
  // without cancelling a sign-in somebody might be halfway through on their phone.
  useBackspace(() => {
    if (!code) return onExit();
    stopPolling();
    void api.cancelSignIn().catch(() => {});
    setCode(null);
  });

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-8 bg-bg-0 px-16 text-fg">
      <h1 className="text-[3.3vh] font-semibold">{t("signin.heading")}</h1>

      {unusable && <p className="max-w-3xl text-center text-[2.2vh] text-warn">{unusable}</p>}
      {error && <p className="max-w-3xl text-center text-[2.2vh] text-warn">{error}</p>}

      {code ? (
        <>
          <div className="flex items-center gap-[5vw]">
            {/* Scanning is the short way; the URL and code beside it are the long
                way, and both are always on screen. The QR is on a white plate
                because a dark-on-dark code does not scan. */}
            {qr && (
              <div className="flex flex-col items-center gap-3">
                <img src={qr} alt="" className="h-[34vh] w-[34vh] rounded-xl bg-white p-3" />
                <span className="text-[1.7vh] text-fg-dim">{t("signin.scan")}</span>
              </div>
            )}
            <div className="flex flex-col items-start gap-4">
              <p className="text-[2.2vh] text-fg-dim">{t("signin.instruction")}</p>
              <p className="text-[2.8vh] text-fg-dim">{code.verificationUri}</p>
              {/* The code is the point of this screen, so it is the biggest thing
                  on it and spaced out to be read from a sofa - and WHITE rather
                  than the accent green, which measured as poor contrast on this
                  near-black ground when read off the television. */}
              <p className="text-[8.9vh] font-bold tracking-[0.2em] text-fg">{code.userCode}</p>
            </div>
          </div>
          <p className="text-[1.9vh] text-fg-dim">
            {left > 60
              ? t("signin.expiresIn", { minutes: Math.ceil(left / 60) })
              : t("signin.expiresSoon", { seconds: left })}
          </p>
          <p className="text-[1.9vh] text-fg-dim">{t("signin.keepOpen")}</p>
          <p className="text-[1.9vh] text-fg-dim">{t("signin.waiting")}</p>
          <FocusButton
            focusKey="signin-cancel"
            className="rounded-xl bg-bg-1 px-10 py-4 text-[2.2vh]"
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
          {unusable ? (
            // The only thing that helps is a DIFFERENT account, so that is the
            // button - "sign in" here starts the same account's sign-in again and
            // lands back on this screen.
            <FocusButton
              focusKey="signin-start"
              className="rounded-xl bg-accent px-12 py-5 text-[2.8vh] font-semibold"
              onEnter={() => void api.signOut().then(onSignedOut).catch(() => setError(t("errors.generic")))}
            >
              {t("signin.otherAccount")}
            </FocusButton>
          ) : (
            <FocusButton
              focusKey="signin-start"
              className="rounded-xl bg-accent px-12 py-5 text-[2.8vh] font-semibold"
              onEnter={() => void start()}
            >
              {busy ? "…" : error ? t("signin.retry") : t("signin.start")}
            </FocusButton>
          )}
          <FocusButton focusKey="signin-exit" className="rounded-xl bg-bg-1 px-10 py-5 text-[2.2vh]" onEnter={onExit}>
            {t("signin.exit")}
          </FocusButton>
        </div>
      )}
    </div>
  );
}
