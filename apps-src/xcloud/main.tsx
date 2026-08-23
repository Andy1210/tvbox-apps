import { createRoot } from "react-dom/client";
import { initSpatialNavigation, configureI18n, tvbox } from "@sdk";
import { XCloud } from "./XCloud";
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

// Gamepad navigation is started and stopped by the app rather than here, and that
// is the difference from RetroArch: there the game runs in its own window, so the
// SDK's own visibility rule hands the pad to the emulator by itself. Here the
// stream is in THIS window, so a running stream would otherwise get every press
// twice - once into the game and once as a focus move in the UI behind the video.
// XCloud.tsx owns the switch.

// Auto-hide the mouse cursor: hidden by default (D-pad UI), shown for ~2.5s when
// a mouse actually moves - so a connected mouse works but an idle pointer never
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

createRoot(document.getElementById("root")!).render(<XCloud onExit={() => tvbox().home()} />);
