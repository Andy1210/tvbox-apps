import { createRoot } from "react-dom/client";
import { initSpatialNavigation, configureI18n, useConfigStore, postNowPlaying, tvbox } from "@sdk";
import { Spotify } from "./Spotify";
import { useSpotifyStore } from "./stores/spotify";
import { control } from "./api";
import hu from "./locales/hu.json";
import en from "./locales/en.json";
import "./index.css";

// i18n must be configured before anything renders. The chosen locale is shared
// with the launcher via the same-origin `tvbox.i18n` localStorage key, so the
// user's language carries over into the app.
configureI18n({ hu, en }, { fallback: "en" });

// Spatial navigation: the CEC->uinput bridge sends arrow keys + Enter, which
// norigin maps to directional focus moves + onEnterPress. Back/Home/media keys
// are handled by the shell preload, not here. Mirrors the launcher's init.
initSpatialNavigation({
  debug: false,
  visualDebug: false,
});

// Auto-hide the mouse cursor: hidden by default (D-pad UI), shown for ~2.5s when
// a mouse actually moves — so a connected mouse works but an idle pointer never
// lingers on screen. Mirrors the launcher.
let cursorTimer: ReturnType<typeof setTimeout>;
window.addEventListener(
  "mousemove",
  () => {
    document.documentElement.classList.add("cursor-on");
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => document.documentElement.classList.remove("cursor-on"), 2500);
  },
  true,
);

// The launcher's App loads the shell config once on mount; the Spotify views
// (enable toggle, settings, device name) read it. Kick the same load here.
void useConfigStore.getState().load();

// Own the Spotify SSE cast stream (shell/spotify.js pushes now-playing on every
// change). The launcher does this app-wide; here the app owns it while open.
const sp = useSpotifyStore.getState();
sp.connect();

// Bridge now-playing to the shell (MQTT/Home Assistant) whenever the casting
// track/state changes — mirrors the launcher's App. Keyed on track/state/title
// so position-only pushes don't re-post.
let lastNp = "";
useSpotifyStore.subscribe((s) => {
  const st = s.state;
  const sig = st ? `${st.track_id}|${st.is_playing}|${st.title}` : "idle";
  if (sig === lastNp) return;
  lastNp = sig;
  postNowPlaying(
    st && st.title
      ? {
          app: "spotify",
          state: st.is_playing ? "playing" : "paused",
          title: st.title,
          artist: st.artist,
          image: st.artist_image_url || st.cover_url,
        }
      : { app: "spotify", state: "idle" },
  );
});

// Media commands forwarded from the shell (MQTT tv_control) -> route transport to
// the connected Spotify account. No-op if no account is connected. Mirrors App.
const bridge = tvbox();
if (bridge.onCommand) {
  const map: Record<string, string> = { play: "play", resume: "play", pause: "pause", next: "next", previous: "prev" };
  bridge.onCommand((cmd: unknown) => {
    const a = map[String((cmd as { action?: string } | null)?.action || "").toLowerCase()];
    if (a) control(a);
  });
}

createRoot(document.getElementById("root")!).render(<Spotify onExit={() => tvbox().home()} />);
