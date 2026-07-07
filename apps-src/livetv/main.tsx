import { createRoot } from "react-dom/client";
import { initSpatialNavigation, configureI18n, useConfigStore, tvbox } from "@sdk";
import { LiveTV } from "./LiveTV";
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

// The launcher's App loads the shell config once on mount; the Live TV views
// (parental lock, settings) expect it to be present. Kick the same load here.
void useConfigStore.getState().load();

createRoot(document.getElementById("root")!).render(<LiveTV onExit={() => tvbox().home()} />);
