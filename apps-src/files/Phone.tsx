import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, FocusButton } from "@sdk";
import { startPairing, stopPairing } from "./api";

// Getting photos off a phone and onto the TV, without asking anyone to type an
// address on a remote.
//
// The TV shows a QR; the phone opens the page and picks photos out of its own
// gallery. That division is the point: a phone already has a picker, a camera roll
// and a keyboard, and a remote has none of the three. The pairing server binds to
// the LAN only while this screen is up, and every write carries the four-digit code
// shown here, so a stray device on the network cannot push anything at the TV.
//
// Photos appear as they arrive rather than at the end - the caller polls - so the
// person holding the phone watches the TV fill up as they tap.
export function Phone({ count, onDone, onExit }: { count: number; onDone: () => void; onExit: () => void }) {
  const { t, locale } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "phone-page", isFocusBoundary: true });
  const [info, setInfo] = useState<{ shortUrl: string; code: string } | null>(null);
  const [qr, setQr] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    startPairing(locale)
      .then(async (d) => {
        if (!alive) return;
        if (!d || !d.url) return setFailed(true);
        setInfo(d);
        try {
          setQr(await QRCode.toDataURL(d.url, { width: 480, margin: 1 }));
        } catch {
          /* the address and the code are still on screen */
        }
      })
      .catch(() => alive && setFailed(true));
    // The server is open on the LAN, so it goes down with this screen rather than
    // waiting out its own timeout.
    return () => {
      alive = false;
      void stopPairing();
    };
  }, [locale]);

  useEffect(() => {
    const id = setTimeout(() => setFocus(count ? "phone-view" : "phone-done"), 0);
    return () => clearTimeout(id);
  }, [count]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col items-center justify-center gap-[2vh] px-[6vw]">
        <div className="text-[3.4vh] font-bold">{t("files.phoneTitle")}</div>
        <div className="text-[1.9vh] text-fg-dim text-center max-w-[60vw]">{t("files.phoneHint")}</div>

        {failed ? (
          <div className="text-[2vh] text-[#ffb3b3]">{t("files.errFailed")}</div>
        ) : (
          <>
            {qr ? (
              <img src={qr} alt="QR" className="w-[30vh] h-[30vh] rounded-[1.4vh] bg-white p-[1vh]" />
            ) : (
              <div className="w-[30vh] h-[30vh] rounded-[1.4vh] bg-white/5" />
            )}
            {info && (
              <div className="text-center">
                <div className="text-[2.1vh] font-semibold">{info.shortUrl}</div>
                <div className="text-[1.7vh] text-fg-dim mt-[0.4vh]">{t("files.phoneCode", { code: info.code })}</div>
              </div>
            )}
          </>
        )}

        <div className="text-[2vh] min-h-[3vh]">
          {count ? t("files.phoneArrived", { n: count }) : t("files.phoneWaiting")}
        </div>

        <div className="flex gap-[1.5vw]">
          {/* Only once something has arrived - a button that opens an empty viewer
              does nothing. Not rendered rather than hidden: a registered focusable
              whose element is `display:none` is a 0x0 rectangle at the top left of
              the screen, and the D-pad will happily land on it. */}
          {count > 0 && (
            <FocusButton
              focusKey="phone-view"
              onEnter={onDone}
              className="px-[3vw] py-[1.8vh] rounded-[1.2vh] bg-white/10 text-[2.2vh] font-semibold"
            >
              {t("files.phoneView")}
            </FocusButton>
          )}
          <FocusButton
            focusKey="phone-done"
            onEnter={onExit}
            className="px-[3vw] py-[1.8vh] rounded-[1.2vh] bg-white/10 text-[2.2vh] font-semibold"
          >
            {t("files.phoneClose")}
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}
