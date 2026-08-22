import { createRoot } from "react-dom/client";
import { initSpatialNavigation, configureI18n, useConfigStore, postNowPlaying, tvbox } from "@sdk";
import { Spotify } from "./Spotify";
import { useSpotifyStore } from "./stores/spotify";
import { control, playerState } from "./api";
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
//
// The lyrics are deliberately NOT here: they are a screen rather than a player
// setting, so that one is answered by the view that shows them (Spotify.tsx).
const bridge = tvbox();
if (bridge.onCommand) {
  const map: Record<string, string> = { play: "play", resume: "play", pause: "pause", next: "next", previous: "prev" };
  // Nothing here has a screen to say it on - this is voice or MQTT, arriving with
  // nobody necessarily looking - so a refusal is at least written down. The
  // refusals worth finding here are the box_* ones: the box is being driven by an
  // account this box has not linked, or it is not addressable at all.
  const run = (action: string, state?: boolean | string) =>
    void control(action, state).then((err) => err && console.warn("[spotify] remote " + action + " refused: " + err));
  bridge.onCommand((cmd: unknown) => {
    const c = (cmd || {}) as { action?: string; state?: string };
    const action = String(c.action || "").toLowerCase();
    const state = String(c.state || "").toLowerCase();
    const a = map[action];
    if (a) return run(a);
    // Shuffle and repeat arrive in the house's vocabulary and Spotify's API has
    // its own, so the translation happens here - the shell knows nothing about
    // either. Repeat's "one"/"all" are Spotify's "track"/"context".
    if (action === "shuffle") {
      if (state === "toggle") {
        // A toggle needs the value the player is actually on, and the cast
        // metadata does not carry it - the phone can have changed it too.
        void playerState().then((p) => p.ok && run("shuffle", !p.shuffle));
        return;
      }
      if (state === "on" || state === "off") return run("shuffle", state === "on");
      return;
    }
    if (action === "repeat") {
      const wanted: Record<string, string> = { off: "off", one: "track", all: "context" };
      if (state === "toggle") {
        // Through the three in the order the buttons cycle them, so a spoken
        // toggle and a pressed one mean the same thing.
        const next: Record<string, string> = { off: "context", context: "track", track: "off" };
        void playerState().then((p) => p.ok && run("repeat", next[p.repeat] || "context"));
        return;
      }
      if (wanted[state]) return run("repeat", wanted[state]);
      return;
    }
  });
}

createRoot(document.getElementById("root")!).render(<Spotify onExit={() => tvbox().home()} />);
