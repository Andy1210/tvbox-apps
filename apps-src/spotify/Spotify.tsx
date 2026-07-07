import { useEffect, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, useConfigStore, FocusButton } from "@sdk";
import { NowPlaying } from "./NowPlaying";
import { SpotifySettings } from "./SpotifySettings";
import { Browser } from "./Browser";
import { authStatus, setSpotifyEnabled, type AuthStatus } from "./api";

// Opt-in screen shown until Spotify Connect is enabled on this box. The
// librespot daemon (which advertises the box on the LAN) runs only once enabled
// — this is the built-in app's on/off switch, no account or setup required.
// Enabling is a single D-pad action (no root, no keyboard).
function SpotifyEnable({
  onEnable,
  onSettings,
  onExit,
}: {
  onEnable: () => void;
  onSettings: () => void;
  onExit: () => void;
}) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "sp-enable-screen" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setFocus("sp-enable");
  }, []);
  useBackspace(onExit);
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col items-center justify-center gap-[2.5vh] px-[8vw] text-center">
        <svg viewBox="0 0 24 24" className="w-[10vh] h-[10vh]" fill="#1DB954">
          <circle cx="12" cy="12" r="11" />
          <path
            d="M6.4 9.7c3.7-1.1 8.2-0.7 11.4 1.2M7 13c3-0.85 6.6-0.5 9 1.1M7.5 16c2.3-0.65 4.9-0.4 6.7 0.8"
            stroke="#0a160f"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
        <div className="text-[3vh] font-bold">{t("spotify.enableTitle")}</div>
        <div className="text-[2vh] text-fg-dim max-w-[60vw]">{t("spotify.enableHint")}</div>
        <div className="flex gap-[1.5vw] mt-[1vh]">
          <FocusButton
            focusKey="sp-enable"
            onEnter={async () => {
              if (busy) return;
              setBusy(true);
              const ok = await setSpotifyEnabled(true);
              if (ok) onEnable();
              else setBusy(false);
            }}
            className="px-[4vw] py-[2vh] rounded-[1.4vh] bg-[#1DB954] text-[#06140c] text-[2.4vh] font-bold"
          >
            {busy ? t("spotify.starting") : t("spotify.enable")}
          </FocusButton>
          <FocusButton
            focusKey="sp-enable-settings"
            onEnter={onSettings}
            className="px-[3vw] py-[2vh] rounded-[1.4vh] bg-white/10 text-[2.4vh] font-semibold"
          >
            {t("settings.title")}
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

// Built-in Spotify app. Always a cast target once ENABLED (now-playing over
// SSE); when an account is connected (optional Web API), it also offers a
// library Browser. Casting auto-opens this screen (shell navigates here on the
// cast rising edge).
export function Spotify({ onExit }: { onExit: () => void }) {
  const [view, setView] = useState<"now" | "settings" | "browse">("now");
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const enabled = useConfigStore((s) => s.config?.spotify.enabled ?? false);
  const loadConfig = useConfigStore((s) => s.load);
  // The SSE stream is owned by App (kept connected launcher-wide so now-playing
  // publishes even off this screen), so this view just reads the store.

  // refresh connection status whenever we return to now-playing (e.g. after
  // connecting an account in settings) so the Browse entry appears
  useEffect(() => {
    if (view === "now") authStatus().then(setAuth);
  }, [view]);

  // Not enabled yet: offer the one-tap enable screen, with a Settings entry so
  // the device name / account can be prepared first if desired.
  if (view !== "settings" && !enabled) {
    return <SpotifyEnable onEnable={() => loadConfig()} onSettings={() => setView("settings")} onExit={onExit} />;
  }

  if (view === "settings") return <SpotifySettings onBack={() => setView("now")} />;
  if (view === "browse") return <Browser onBack={() => setView("now")} onPlayed={() => setView("now")} />;
  return (
    <NowPlaying
      connected={!!auth?.connected}
      onSettings={() => setView("settings")}
      onBrowse={() => setView("browse")}
      onExit={onExit}
    />
  );
}
