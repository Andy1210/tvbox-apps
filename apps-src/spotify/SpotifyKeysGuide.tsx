import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, FocusButton } from "@sdk";

const DASHBOARD_URL = "https://developer.spotify.com/dashboard";
// The loopback redirect Spotify calls back to. Must be registered verbatim in the
// dashboard app; built from the port the launcher is actually served on so it
// can't drift (Spotify requires the literal 127.0.0.1, not localhost).
const REDIRECT_URI = `http://127.0.0.1:${window.location.port || "8097"}/tvbox/api/spotify/auth/callback`;

// On-TV walkthrough for obtaining the (optional) Spotify Web API keys. Explains
// the dashboard app + the exact Redirect URI, shows a QR to open the dashboard on
// a phone, then hands off to the phone-paste flow (SpotifyConfig) via onContinue.
export function SpotifyKeysGuide({ onContinue, onCancel }: { onContinue: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [qr, setQr] = useState("");
  const { ref, focusKey } = useFocusable({ focusKey: "sp-guide" });

  useEffect(() => {
    QRCode.toDataURL(DASHBOARD_URL, { width: 360, margin: 1 })
      .then(setQr)
      .catch(() => {});
  }, []);
  useEffect(() => {
    const id = setTimeout(() => setFocus("sp-guide-continue"), 0);
    return () => clearTimeout(id);
  }, []);
  useBackspace(onCancel);

  const Step = ({ n, children }: { n: number; children: React.ReactNode }) => (
    <div className="flex gap-[1.4vw] items-start max-w-[72vw]">
      <span className="shrink-0 w-[3.4vh] h-[3.4vh] rounded-full bg-[#1DB954] text-[#06120b] text-[1.9vh] font-bold flex items-center justify-center">
        {n}
      </span>
      <span className="text-[2vh] leading-[1.4] text-left">{children}</span>
    </div>
  );

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col px-[6vw] py-[3.5vh] gap-[1.6vh] overflow-y-auto">
        <div className="text-[3vh] font-bold">{t("spotify.guideTitle")}</div>
        <div className="text-[1.9vh] text-fg-dim max-w-[72vw]">{t("spotify.guideIntro")}</div>

        <div className="flex items-start gap-[3vw] mt-[0.5vh]">
          <div className="flex flex-col gap-[1.6vh] flex-1">
            <Step n={1}>{t("spotify.guideStep1")}</Step>
            <Step n={2}>
              {t("spotify.guideStep2")}
              <div className="mt-[0.8vh] px-[1.4vw] py-[1.2vh] rounded-[1vh] bg-black/40 font-mono text-[1.7vh] break-all select-all">
                {REDIRECT_URI}
              </div>
            </Step>
            <Step n={3}>{t("spotify.guideStep3")}</Step>
            <Step n={4}>{t("spotify.guideStep4")}</Step>
          </div>
          {qr && (
            <div className="shrink-0 flex flex-col items-center gap-[0.8vh]">
              <img src={qr} alt="QR" className="w-[24vh] h-[24vh] rounded-[1.4vh] bg-white p-[1vh]" />
              <div className="text-[1.6vh] text-fg-dim text-center max-w-[26vh]">{t("spotify.guideScan")}</div>
            </div>
          )}
        </div>

        <FocusButton
          focusKey="sp-guide-continue"
          onEnter={onContinue}
          className="mt-[1vh] px-[2.5vw] py-[2vh] rounded-[1.4vh] bg-[#1DB954] text-[#06120b] text-[2.1vh] font-bold max-w-[72vw] text-left"
        >
          {t("spotify.guideContinue")}
        </FocusButton>
      </div>
    </FocusContext.Provider>
  );
}
