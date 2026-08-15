import { createRoot } from "react-dom/client";
import { initSpatialNavigation, configureI18n, tvbox } from "@sdk";
import { MediaClient } from "./MediaClient";
import { installLifecycle } from "./lifecycle";
import hu from "./locales/hu.json";
import en from "./locales/en.json";
import "./index.css";

// i18n must be configured before anything renders. The chosen locale is shared
// with the launcher through the same-origin `tvbox.i18n` localStorage key, so the
// user's language carries over into the app.
configureI18n({ hu, en }, { fallback: "en" });

// Spatial navigation: the remote's arrows + Enter arrive as key events, which
// norigin turns into directional focus moves. Back/Home are handled by the shell
// preload and by this app's own handlers, not here.
initSpatialNavigation({ debug: false, visualDebug: false });

// Auto-hide the mouse cursor: hidden by default (this is a D-pad UI), shown for
// ~2.5s when a mouse actually moves, so a connected mouse works but an idle
// pointer never sits on screen over a film.
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

// Release server-side state when this window stops being visible. Installed
// before the first render so a crash during boot still cleans up after itself.
installLifecycle();

createRoot(document.getElementById("root")!).render(<MediaClient onExit={() => tvbox().home()} />);
