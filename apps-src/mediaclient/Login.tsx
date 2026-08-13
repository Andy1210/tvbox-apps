import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { FocusButton, useI18n } from "@sdk";
import { beginDeviceLogin } from "./backends/plex/auth";
import { deviceName, getIdentity } from "./identity";
import { useInitialFocus } from "./focus";
import { useApp } from "./state";
import { log } from "./redact";

type Phase =
  | { name: "starting" }
  | { name: "waiting"; code: string; url: string }
  | { name: "expired" }
  | { name: "failed" };

/**
 * Signing in from the sofa.
 *
 * The constraint that shapes this screen is that it has no keyboard: the code is
 * typed on a phone. So the code is the largest thing on it, the address sits
 * under it in full, and a QR gets someone there without anyone reading it aloud.
 */
export function Login(): React.JSX.Element {
  const { t } = useI18n();
  const signIn = useApp((s) => s.signIn);
  const [round, setRound] = useState(0);
  const [phase, setPhase] = useState<Phase>({ name: "starting" });
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    let live = true;

    setPhase({ name: "starting" });
    setQr(null);

    (async () => {
      try {
        const identity = await getIdentity();
        const login = await beginDeviceLogin({
          id: { clientId: identity.clientId, deviceName: deviceName(identity.host) },
        });
        if (!live) return;

        setPhase({ name: "waiting", code: login.code, url: login.url });
        QRCode.toDataURL(`https://${login.url}`, { margin: 1, width: 320 })
          .then((d) => live && setQr(d))
          .catch(() => {
            /* the code is readable on its own; a missing QR is not a failure */
          });

        const session = await login.poll(abort.signal);
        if (!live) return;
        if (!session) {
          setPhase({ name: "expired" });
          return;
        }
        await signIn(session);
      } catch (e) {
        if (!live) return;
        log.warn("sign-in failed", e);
        setPhase({ name: "failed" });
      }
    })();

    return () => {
      live = false;
      abort.abort();
    };
  }, [round, signIn]);

  const done = phase.name === "expired" || phase.name === "failed";
  // The retry only exists once the code has died, and nothing else on this
  // screen is pressable - so it has to be given focus the moment it appears, or
  // the first screen a new box shows has a button that ignores the remote.
  useInitialFocus("login-retry", done);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-[3vh] px-[6vw]">
      <h1 className="text-[3.4vh] font-semibold tracking-tight">{t("login.title")}</h1>

      {phase.name === "starting" && <p className="text-[2.2vh] text-fg-dim">{t("login.starting")}</p>}

      {phase.name === "waiting" && (
        <>
          <p className="text-center text-[2.2vh] text-fg-dim">{t("login.instruction", { url: phase.url })}</p>
          <div className="flex items-center gap-[4vw]">
            {qr && <img src={qr} alt="" className="h-[26vh] w-[26vh] rounded-[1vh] bg-white p-[1vh]" />}
            <div
              className="font-mono text-[11vh] leading-none font-bold tracking-[0.12em] tabular-nums"
              // Read out letter by letter: "ABCD" spoken as a word helps nobody
              // who is typing it into a phone.
              aria-label={phase.code.split("").join(" ")}
            >
              {phase.code}
            </div>
          </div>
          <p className="text-[1.8vh] text-fg-dim">{t("login.waiting")}</p>
        </>
      )}

      {done && (
        <>
          <p className="max-w-[52vw] text-center text-[2.2vh] text-fg-dim">
            {t(phase.name === "expired" ? "login.expired" : "login.failed")}
          </p>
          <FocusButton
            focusKey="login-retry"
            onEnter={() => setRound((r) => r + 1)}
            className="rounded-[1vh] bg-white/10 px-[3vw] py-[1.6vh] text-[2.2vh]"
          >
            {t("login.retry")}
          </FocusButton>
        </>
      )}
    </div>
  );
}
