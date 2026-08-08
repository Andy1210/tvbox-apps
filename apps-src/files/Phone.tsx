import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, FocusButton } from "@sdk";
import type { PairingInfo } from "./api";

// Getting photos off a phone and onto the TV, without asking anyone to type an
// address on a remote.
//
// The TV shows a QR; the phone opens the page and picks photos out of its own
// gallery. That division is the point: a phone already has a picker, a camera
// roll and a keyboard, and a remote has none of the three. Every write carries
// the four-digit code shown here, so a stray device on the network cannot push
// anything at the TV.
//
// The session itself is NOT started here. Starting it mints a new code, and this
// screen is left and returned to while a phone still has the page open - so it
// belongs to the casting flow in Files.tsx, which outlives this component.
export function Phone({
  info,
  failed,
  count,
  onDone,
  onExit,
}: {
  info: PairingInfo | null;
  failed: boolean;
  count: number;
  onDone: () => void;
  onExit: () => void;
}) {
  const { t } = useI18n();
  // A grouping container, not a target: a focusable page is a full-screen
  // rectangle that the D-pad can land on, and once it has, nothing is highlighted
  // and every arrow measures from a rect covering the screen.
  const { ref, focusKey } = useFocusable({
    focusKey: "phone-page",
    focusable: false,
    isFocusBoundary: true,
    saveLastFocusedChild: true,
  });
  const [qr, setQr] = useState("");

  useEffect(() => {
    let alive = true;
    if (!info) return setQr("");
    QRCode.toDataURL(info.url, { width: 480, margin: 1 })
      .then((d) => alive && setQr(d))
      .catch(() => {
        /* the address and the code are still on screen */
      });
    return () => {
      alive = false;
    };
  }, [info]);

  // Focus moves when the buttons CHANGE, not when a photo arrives. Photos arrive
  // one at a time while someone is choosing on the phone, and re-focusing on each
  // one would take the cursor off whatever they had just selected here.
  const had = useRef(false);
  const has = count > 0;
  useEffect(() => {
    if (had.current === has) return;
    had.current = has;
    const id = setTimeout(() => setFocus(has ? "phone-view" : "phone-done"), 0);
    return () => clearTimeout(id);
  }, [has]);

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

        <div className="text-[2vh] min-h-[3vh]">{has ? t("files.phoneArrived", { n: count }) : t("files.phoneWaiting")}</div>

        <div className="flex gap-[1.5vw]">
          {/* Only once something has arrived - a button that opens an empty viewer
              does nothing. Not rendered rather than hidden: a registered focusable
              whose element is `display:none` is a 0x0 rectangle at the top left of
              the screen, and the D-pad will happily land on it. */}
          {has && (
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
