import { useI18n } from "@sdk";
import { hhmm, type Channel, type EpgEntry } from "./api";

// Overlay composited over the mpv video (the page is transparent in video mode).
// Shows a channel-info banner with now/next EPG; a full-screen black + spinner
// while buffering (before the first frame, the page is still opaque).
export function PlayerOverlay({
  channel,
  epg,
  buffering,
  bannerVisible,
}: {
  channel: Channel;
  epg: EpgEntry[];
  buffering: boolean;
  bannerVisible: boolean;
}) {
  const { t } = useI18n();
  const now = epg[0];
  const next = epg[1];

  return (
    <div className="fixed inset-0 pointer-events-none">
      {buffering && (
        <div className="absolute inset-0 bg-black flex flex-col items-center justify-center gap-[2vh]">
          <div className="w-[6vh] h-[6vh] rounded-full border-[0.5vh] border-white/20 border-t-white animate-spin" />
          <div className="text-[2.4vh] font-semibold">{channel.name}</div>
          <div className="text-[1.8vh] text-fg-dim">{t("livetv.buffering")}</div>
        </div>
      )}

      <div
        className={[
          "absolute left-0 right-0 bottom-0 p-[4vh_4vw] transition-[opacity,transform] duration-300",
          "bg-gradient-to-t from-black/90 via-black/60 to-transparent",
          bannerVisible && !buffering ? "opacity-100 translate-y-0" : "opacity-0 translate-y-[3vh]",
        ].join(" ")}
      >
        <div className="flex items-center gap-[1.5vw]">
          {channel.logo && <img src={channel.logo} alt="" className="h-[7vh] w-[12vw] object-contain object-left" />}
          <div className="min-w-0">
            <div className="text-[3vh] font-bold leading-tight">{channel.name}</div>
            {now && (
              <div className="text-[2vh] mt-[0.6vh]">
                <span className="text-fg-dim mr-[0.6vw]">{t("livetv.now")}</span>
                {hhmm(now.start)} {now.title}
              </div>
            )}
            {next && (
              <div className="text-[1.7vh] text-fg-dim mt-[0.3vh]">
                <span className="mr-[0.6vw]">{t("livetv.next")}</span>
                {hhmm(next.start)} {next.title}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
