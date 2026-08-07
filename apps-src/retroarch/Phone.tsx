import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, FocusButton } from "@sdk";

// The one thing that stays on the phone: picking game files.
//
// Everything else this app needs - consoles, covers, where the games are - is a
// screen here, because a setting nobody can find is a setting nobody has. A file
// picker is the exception: on a remote it is miserable, and a phone already has
// one. So the app opens the phone page itself with a QR, instead of the button
// living in a Settings menu three levels away from the games.
export function Phone({ kind, title, hint, onClose }: { kind: string; title: string; hint: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "phone-qr", isFocusBoundary: true });
  const [info, setInfo] = useState<{ shortUrl: string; code: string } | null>(null);
  const [qr, setQr] = useState("");

  useEffect(() => {
    let alive = true;
    fetch("/tvbox/api/pairing/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale, kind }),
    })
      .then((r) => r.json())
      .then(async (d) => {
        if (!alive || !d || !d.url) return;
        setInfo(d);
        try {
          setQr(await QRCode.toDataURL(d.url, { width: 480, margin: 1 }));
        } catch {
          /* text only - the address and the code are still on screen */
        }
      })
      .catch(() => {});
    // The pairing server binds to the LAN, so it goes down with this screen.
    return () => {
      alive = false;
      fetch("/tvbox/api/pairing/stop", { method: "POST" }).catch(() => {});
    };
  }, [kind, locale]);

  useEffect(() => {
    setFocus("phone-done");
  }, []);
  useBackspace(onClose);

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="fixed inset-0 z-50 bg-black/90 flex flex-col items-center justify-center gap-[2.2vh] px-[6vw] text-center"
      >
        <div className="text-[3vh] font-bold">{title}</div>
        <div className="text-[2vh] text-fg-dim max-w-[62vw]">{hint}</div>
        {qr ? (
          <>
            <img src={qr} alt="QR" className="w-[30vh] h-[30vh] rounded-[1.4vh] bg-white p-[1vh]" />
            <div className="text-[2.2vh] font-semibold tabular-nums">{info?.shortUrl}</div>
            <div className="text-[2vh] text-fg-dim">
              {t("retroarch.phoneCode")}:{" "}
              <span className="font-bold text-fg tabular-nums tracking-[0.3vw]">{info?.code}</span>
            </div>
          </>
        ) : (
          <div className="w-[6vh] h-[6vh] rounded-full border-[0.5vh] border-white/20 border-t-white animate-spin" />
        )}
        <FocusButton
          focusKey="phone-done"
          onEnter={onClose}
          className="px-[3vw] py-[1.6vh] rounded-[1.2vh] bg-white/10 text-[2.2vh] font-semibold"
        >
          {t("retroarch.phoneDone")}
        </FocusButton>
      </div>
    </FocusContext.Provider>
  );
}
