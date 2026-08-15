import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, Osk, useI18n } from "@sdk";
import { beginDeviceLogin } from "./backends/plex/auth";
import { beginQuickConnect, quickConnectAvailable, serverInfo } from "./backends/jellyfin/auth";
import { normaliseAddress } from "./backends/jellyfin/address";
import { deviceName, getIdentity } from "./identity";
import { useFocusFallback } from "./focus";
import { useApp } from "./state";
import { readJson, writeJson } from "./storage";
import { log } from "./redact";
import type { DeviceLogin } from "./backends/types";

/** What was chosen last time, so a second sign-in does not ask twice. */
const SERVER_KEY = "server";
/** Long enough for a slow server, short enough to be a wrong address. */
const CONNECT_TIMEOUT_MS = 8000;

/** One signal that gives up either when the screen does or when time does. */
function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  // `AbortSignal.any` is what composes two reasons to stop; where it is
  // missing, the screen's own signal still cancels and only the clock is lost.
  const A = AbortSignal as unknown as {
    any?: (s: AbortSignal[]) => AbortSignal;
    timeout?: (ms: number) => AbortSignal;
  };
  if (typeof A.any !== "function" || typeof A.timeout !== "function") return signal;
  try {
    return A.any([signal, A.timeout(ms)]);
  } catch {
    return signal;
  }
}

interface RememberedServer {
  kind: "plex" | "jellyfin";
  /** Jellyfin only. Plex is found through the account, not by address. */
  baseUrl?: string;
}

type Phase =
  | { name: "choosing" }
  | { name: "address" }
  | { name: "checking" }
  | { name: "starting" }
  | { name: "waiting"; code: string; url: string }
  | { name: "expired" }
  | { name: "failed"; why?: "notFound" | "quickConnectOff" };

/**
 * Signing in from the sofa.
 *
 * The constraint that shapes this screen is that it has no keyboard: the code is
 * typed on a phone. So the code is the largest thing on it, the address sits
 * under it in full, and a QR gets someone there without anyone reading it aloud.
 *
 * Two servers reach the same code screen by different routes. Plex is found
 * through the account, so there is nothing to ask. Jellyfin has no account
 * service at all - the code is typed into THAT server's own web interface - so
 * its address has to be known first, and it is the one thing here that needs the
 * keyboard. It is remembered, so this is asked once per box rather than once per
 * sign-in.
 */
export function Login(): React.JSX.Element {
  const { t } = useI18n();
  const signIn = useApp((s) => s.signIn);
  const [round, setRound] = useState(0);
  const [server, setServer] = useState<RememberedServer | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: "choosing" });
  const [serverName, setServerName] = useState<{ name: string; version: string } | null>(null);
  /** The last Jellyfin address this box knew, kept across a change of mind. */
  const [lastAddress, setLastAddress] = useState("");
  const [qr, setQr] = useState<string | null>(null);

  // What was chosen last time. Until this has been read the screen shows the
  // chooser, which is the honest state rather than a guess that flickers.
  useEffect(() => {
    let live = true;
    void readJson<RememberedServer>(SERVER_KEY).then((saved) => {
      if (!live || !saved) return;
      setServer(saved);
      if (saved.baseUrl) setLastAddress(saved.baseUrl);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!server) return;
    if (server.kind === "jellyfin" && !server.baseUrl) {
      setPhase({ name: "address" });
      return;
    }

    const abort = new AbortController();
    let live = true;
    setQr(null);
    setPhase({ name: "starting" });

    (async () => {
      try {
        const identity = await getIdentity();
        let login: DeviceLogin;

        if (server.kind === "jellyfin") {
          const base = server.baseUrl!;
          const id = { deviceId: identity.clientId, deviceName: deviceName(identity.host) };
          setPhase({ name: "checking" });
          // Asked before a code is shown, because a server with Quick Connect
          // off answers the initiate with an error and the screen would show a
          // number nobody can do anything with.
          // Bounded, because the realistic failure is a typo in the last octet
          // of a LAN address: nothing refuses the connection, the SYN is
          // blackholed, and the screen sat on "connecting" for as long as
          // anybody was willing to watch it - measured at eighteen seconds
          // before somebody intervened.
          const info = await serverInfo(base, id, withTimeout(abort.signal, CONNECT_TIMEOUT_MS));
          if (!live) return;
          setServerName(info.ServerName ? { name: info.ServerName, version: info.Version ?? "" } : null);
          if (!(await quickConnectAvailable(base, id, withTimeout(abort.signal, CONNECT_TIMEOUT_MS)))) {
            if (live) setPhase({ name: "failed", why: "quickConnectOff" });
            return;
          }
          login = await beginQuickConnect(base, id, abort.signal);
        } else {
          login = await beginDeviceLogin({
            id: { clientId: identity.clientId, deviceName: deviceName(identity.host) },
          });
        }
        if (!live) return;
        // A login without a code is not a login. Nothing else checks it, and
        // the code screen reads the value character by character for the screen
        // reader - so an answer from a proxy, a captive portal or a server
        // having a bad day took the whole screen down with it rather than
        // saying anything.
        if (!login?.code || !login.url) throw new Error("the server answered without a code");

        setPhase({ name: "waiting", code: login.code, url: login.url });
        // Plex answers with a bare host and path; Jellyfin with a whole URL.
        const target = /^https?:\/\//i.test(login.url) ? login.url : `https://${login.url}`;
        QRCode.toDataURL(target, { margin: 1, width: 320 })
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
        await signIn({ ...session, kind: server.kind });
      } catch (e) {
        if (!live) return;
        log.warn("sign-in failed", e);
        setPhase({ name: "failed", why: server.kind === "jellyfin" ? "notFound" : undefined });
      }
    })();

    return () => {
      live = false;
      abort.abort();
    };
  }, [round, server, signIn]);

  const choose = (kind: "plex" | "jellyfin"): void => {
    // The address comes from what was last KNOWN, not from `server` - which the
    // way back to this chooser sets to null two commits earlier, so choosing
    // Jellyfin again wrote `{kind}` with no address and threw away the one
    // thing on this screen that costs a minute of typing on a D-pad. The next
    // launch then opened straight into an empty keyboard.
    const next: RememberedServer = kind === "plex" ? { kind } : { kind, baseUrl: lastAddress || undefined };
    setServer(next);
    void writeJson(SERVER_KEY, next).then((w) => {
      if (!w.ok) log.warn("the chosen server was not remembered");
    });
  };

  const done = phase.name === "expired" || phase.name === "failed";
  const waiting = phase.name === "waiting" || phase.name === "starting" || phase.name === "checking";
  const choosing = phase.name === "choosing" && !server;

  /**
   * What the remote is pointing at, decided per screen rather than per mount.
   *
   * This component is five screens in a row - chooser, keyboard, code, expired,
   * failed - and `useInitialFocus` fires ONCE in a component's life, which is
   * right for a screen that loads once and wrong here: coming back to the
   * chooser from the code screen left focus on a button that unmounts in the
   * same commit, so the remote did nothing at all. Nothing errors, and a mouse
   * still works, which is how it reached a television.
   */
  // Nothing while the keyboard is up: it owns focus, and naming a button that
  // is not on screen both wasted the setFocus and - because the value did not
  // CHANGE when the code screen replaced it - meant the effect never fired
  // again. The screen after the keyboard had no focus ring at all, which is the
  // same fault the chooser had, one screen along.
  const wants =
    phase.name === "address" ? undefined : choosing ? "login-plex" : done ? "login-retry" : server ? "login-other" : undefined;
  useEffect(() => {
    if (!wants) return;
    // The timeout is not a guess: `useFocusable` registers during its own
    // effect, so a setFocus in a sibling effect of the same commit finds
    // nothing there.
    const t = setTimeout(() => setFocus(wants), 0);
    return () => clearTimeout(t);
  }, [wants]);
  // And a backstop, because the failure mode of getting this wrong is a dead
  // remote rather than a visible fault: any nav key with focus gone or on
  // something that is not this screen's puts it back. Off while the keyboard is
  // up, which owns focus itself.
  useFocusFallback(wants, (k) => k.startsWith("login-"), phase.name !== "address");

  if (phase.name === "address") {
    return (
      <Osk
        title={`${t("login.address")} — ${t("login.addressHint")}`}
        initial={server?.baseUrl ?? lastAddress}
        onDone={(value) => {
          const base = normaliseAddress(value);
          // Something that is not an address at all - a letter O where a zero
          // belongs, a port with no host, a scheme with nothing after it. The
          // keyboard used to stay up with Done doing nothing at all, forever,
          // which reads as a broken remote rather than as a typo.
          if (!base) {
            setPhase({ name: "failed", why: "notFound" });
            return;
          }
          const next: RememberedServer = { kind: "jellyfin", baseUrl: base };
          setLastAddress(base);
          setServer(next);
          setRound((r) => r + 1);
          void writeJson(SERVER_KEY, next);
        }}
        onCancel={() => {
          setServer(null);
          setPhase({ name: "choosing" });
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-[3vh] px-[6vw]">
      <h1 className="text-[3.4vh] font-semibold tracking-tight">{t("login.title")}</h1>

      {phase.name === "choosing" && !server && (
        <>
          <p className="text-[2.2vh] text-fg-dim">{t("login.chooseServer")}</p>
          <div className="flex gap-[2vw]">
            <FocusButton
              focusKey="login-plex"
              onEnter={() => choose("plex")}
              className="rounded-[1vh] bg-white/10 px-[4vw] py-[2vh] text-[2.6vh]"
            >
              {t("login.plexName")}
            </FocusButton>
            <FocusButton
              focusKey="login-jellyfin"
              onEnter={() => choose("jellyfin")}
              className="rounded-[1vh] bg-white/10 px-[4vw] py-[2vh] text-[2.6vh]"
            >
              {t("login.jellyfinName")}
            </FocusButton>
          </div>
        </>
      )}

      {phase.name === "checking" && <p className="text-[2.2vh] text-fg-dim">{t("login.checking")}</p>}
      {phase.name === "starting" && <p className="text-[2.2vh] text-fg-dim">{t("login.starting")}</p>}

      {phase.name === "waiting" && (
        <>
          <p className="text-center text-[2.2vh] text-fg-dim">
            {t(server?.kind === "jellyfin" ? "login.instructionJellyfin" : "login.instruction", { url: phase.url })}
          </p>
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
          {serverName && (
            <p className="text-[1.8vh] text-fg-dim">{t("login.found", { name: serverName.name, version: serverName.version })}</p>
          )}
        </>
      )}

      {done && (
        <>
          <p className="max-w-[52vw] text-center text-[2.2vh] text-fg-dim">
            {phase.name === "failed" && phase.why === "quickConnectOff"
              ? t("login.quickConnectOff")
              : phase.name === "failed" && phase.why === "notFound"
                ? t("login.notFound")
                : t(phase.name === "expired" ? "login.expired" : "login.failed")}
          </p>
          <div className="flex gap-[1.5vw]">
            <FocusButton
              focusKey="login-retry"
              onEnter={() => setRound((r) => r + 1)}
              className="rounded-[1vh] bg-white/10 px-[3vw] py-[1.6vh] text-[2.2vh]"
            >
              {t("login.retry")}
            </FocusButton>
            {server?.kind === "jellyfin" && (
              <FocusButton
                focusKey="login-address"
                onEnter={() => setPhase({ name: "address" })}
                className="rounded-[1vh] bg-white/10 px-[3vw] py-[1.6vh] text-[2.2vh]"
              >
                {t("login.changeAddress")}
              </FocusButton>
            )}
          </div>
        </>
      )}

      {/* The way back out of a choice, wherever the screen has got to.
          Signing out leaves the chosen server remembered - a box signs back
          into the same one nearly every time - so without this the code screen
          was a dead end: no way to pick the other server until the code
          expired. */}
      {server && (waiting || done) && (
        <FocusButton
          focusKey="login-other"
          onEnter={() => {
            setServer(null);
            setServerName(null);
            setPhase({ name: "choosing" });
          }}
          className="rounded-[1vh] bg-white/10 px-[3vw] py-[1.4vh] text-[2vh] text-fg-dim"
        >
          {t("login.otherServer")}
        </FocusButton>
      )}
    </div>
  );
}
