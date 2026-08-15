import { useEffect, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, useConfigStore, FocusButton, tvbox } from "@sdk";
import { NowPlaying } from "./NowPlaying";
import { SpotifySettings } from "./SpotifySettings";
import { Browser } from "./Browser";
import { useSpotifyStore } from "./stores/spotify";
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
  // Browse too, and not only to decide whether it is offered: the active account
  // can change while this screen is up (the box follows whoever casts to it), and
  // the library screen names the account it is showing.
  useEffect(() => {
    if (view === "now" || view === "browse") authStatus().then(setAuth);
  }, [view]);
  // ...and re-read it while Browse is open, because the handover happens without
  // anybody touching this screen. Naming the account is only worth doing if the
  // name is the one whose rows are on display: stale, it is a false claim, and
  // pressing a row would send that account's context to the new owner's player.
  useEffect(() => {
    if (view !== "browse") return;
    const id = setInterval(() => void authStatus().then(setAuth), 10000);
    return () => clearInterval(id);
  }, [view]);

  // The box's screensaver, over this app. While an app is in front the launcher's
  // window is hidden and its idle timer is suppressed there on purpose - so
  // nothing would ever come up over this screen, and "nothing is playing" is a
  // static picture the box would hold all night. So we ask, on the same delay the
  // person chose for the launcher, and only from the screen that has nothing to
  // show: not while music is playing (that screen IS what to show), and not in
  // the library or the settings, where somebody is in the middle of something.
  //
  // The keys land in this window, so this is where the counting has to happen -
  // and the shell refuses the request unless this app really is the one on
  // screen. Absent on a shell that predates the request, where it no-ops.
  const ambient = useConfigStore((s) => s.config?.ambient);
  const playing = useSpotifyStore((s) => !!s.state?.is_playing);
  useEffect(() => {
    const minutes = ambient?.idleMinutes ?? 0;
    if (!ambient?.enabled || minutes <= 0 || view !== "now" || playing) return;
    let last = Date.now();
    const bump = () => {
      last = Date.now();
    };
    window.addEventListener("keydown", bump, true);
    window.addEventListener("pointermove", bump, true);
    const id = setInterval(() => {
      // A hidden window is not the screen anybody is looking at, and it receives
      // none of the keys that would reset this - so its time does not count.
      if (document.visibilityState !== "visible") return bump();
      if (Date.now() - last < minutes * 60000) return;
      last = Date.now(); // asked; start counting again rather than asking every tick
      tvbox().ambient?.request();
    }, 5000);
    return () => {
      window.removeEventListener("keydown", bump, true);
      window.removeEventListener("pointermove", bump, true);
      clearInterval(id);
    };
  }, [ambient?.enabled, ambient?.idleMinutes, view, playing]);

  // Not enabled yet: offer the one-tap enable screen, with a Settings entry so
  // the device name / account can be prepared first if desired.
  if (view !== "settings" && !enabled) {
    return <SpotifyEnable onEnable={() => loadConfig()} onSettings={() => setView("settings")} onExit={onExit} />;
  }

  if (view === "settings") return <SpotifySettings onBack={() => setView("now")} />;
  if (view === "browse")
    return <Browser onBack={() => setView("now")} onPlayed={() => setView("now")} account={auth?.user || ""} />;
  return (
    <NowPlaying
      connected={!!auth?.connected}
      onSettings={() => setView("settings")}
      onBrowse={() => setView("browse")}
      onExit={onExit}
    />
  );
}
