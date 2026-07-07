import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useI18n, useBackspace } from "@sdk";
import { authStatus, startConnect } from "./api";

// Connect-account flow. Spotify offers no QR/device login and only a loopback
// redirect, so the login must happen in a window on the box — but the box has no
// keyboard. So we turn the phone into one: this starts the "keyboard" pairing
// server and shows a QR. The moment the phone opens that page the box auto-opens
// the Spotify login window (no button to press, no wrong order), and the phone's
// Email/Code fields are injected into it. Polls until the account is connected.
export function SpotifyConnect({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t, locale } = useI18n();
  const [info, setInfo] = useState<{ shortUrl: string; code: string } | null>(null);
  const [qr, setQr] = useState("");
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/tvbox/api/pairing/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale, kind: "keyboard" }),
    })
      .then((r) => r.json())
      .then(async (d) => {
        if (!alive || !d || !d.url) return;
        setInfo(d);
        try {
          setQr(await QRCode.toDataURL(d.url, { width: 420, margin: 1 }));
        } catch {
          /* text only */
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
      fetch("/tvbox/api/pairing/stop", { method: "POST" }).catch(() => {});
    };
  }, [locale]);

  useBackspace(onCancel);

  // auto-open the login as soon as the phone opens the keyboard page
  useEffect(() => {
    if (opened) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch("/tvbox/api/pairing/status", { cache: "no-store" });
        if ((await r.json()).phoneConnected) {
          setOpened(true);
          startConnect();
        }
      } catch {
        /* keep polling */
      }
    }, 1200);
    return () => clearInterval(id);
  }, [opened]);

  // Finish when a NEW link succeeds — tracked by connectSeq, not "connected"
  // (the box may already be connected when ADDING another account).
  const baseSeq = useRef<number | null>(null);
  useEffect(() => {
    const id = setInterval(async () => {
      const s = await authStatus();
      if (baseSeq.current === null) {
        baseSeq.current = s.connectSeq;
        return;
      }
      if (s.connectSeq > baseSeq.current) {
        clearInterval(id);
        onDone();
      }
    }, 1500);
    return () => clearInterval(id);
  }, [onDone]);

  return (
    <div className="h-full flex flex-col items-center justify-center gap-[1.8vh] px-[6vw] text-center">
      <div className="text-[3vh] font-bold">{t("spotify.connectTitle")}</div>
      <div className="text-[1.9vh] text-fg-dim max-w-[66vw]">{t("spotify.connectScan")}</div>
      {qr ? (
        <img src={qr} alt="QR" className="w-[26vh] h-[26vh] rounded-[1.4vh] bg-white p-[1vh]" />
      ) : (
        <div className="w-[5vh] h-[5vh] rounded-full border-[0.5vh] border-white/20 border-t-white animate-spin" />
      )}
      {info && (
        <div className="text-[1.8vh] text-fg-dim">
          {info.shortUrl} · {t("livetv.phoneSetupCode")}:{" "}
          <span className="font-bold text-fg tracking-[0.2vw]">{info.code}</span>
        </div>
      )}
      {opened && <div className="text-[1.9vh] text-[#1DB954] font-semibold">{t("spotify.connecting")}</div>}
      <div className="text-[1.6vh] text-fg-dim/70 max-w-[66vw]">{t("spotify.connectSteps")}</div>
    </div>
  );
}
