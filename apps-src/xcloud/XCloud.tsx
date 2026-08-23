import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@sdk";
import { startGamepadNav } from "@sdk/gamepad";
import * as api from "./api";
import { SignIn } from "./SignIn";
import { Library } from "./Library";
import { Stream } from "./Stream";

type View = { name: "loading" } | { name: "signin" } | { name: "library" } | { name: "stream"; title: api.Title };

export function XCloud({ onExit }: { onExit: () => void }) {
  const { t } = useI18n();
  const [view, setView] = useState<View>({ name: "loading" });
  const [status, setStatus] = useState<api.Status | null>(null);

  // The pad drives the UI while browsing and belongs to the GAME while streaming.
  // Both halves are needed: without the start, a controller cannot browse the
  // library it is about to play from; without the stop, every press moves the
  // focus behind the video as well as reaching the game.
  const stopPadNav = useRef<null | (() => void)>(null);
  const [padForUi, setPadForUi] = useState(false);
  // The pad drives the UI everywhere except a game that is actually playing. Both
  // halves are needed: without the start, a controller cannot browse the library
  // it is about to play from; without the stop, every press moves the focus behind
  // the video as well as reaching the game. And a dialog over a running game is
  // OUR screen, so the pad comes back for it - `padForUi`.
  const padToGame = view.name === "stream" && !padForUi;
  useEffect(() => {
    if (padToGame) {
      stopPadNav.current?.();
      stopPadNav.current = null;
      return;
    }
    if (stopPadNav.current) return;

    // Wait for every button to be UP before handing the pad back to the UI.
    //
    // The SDK's navigation forgets which buttons were at rest when it is torn
    // down, so a button still held when it starts again reads as a fresh press.
    // That is not theoretical: the A press that launches a game is still down
    // when the stream screen appears and asks for the pad back, so it was
    // replayed as Enter onto the freshly focused Leave button - the game flashed
    // up and vanished, and the press carried on into the library behind it.
    let cancelled = false;
    const held = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const pad of pads) {
        if (pad && pad.connected && pad.buttons.some((b) => b.pressed)) return true;
      }
      return false;
    };
    const arm = () => {
      if (cancelled || stopPadNav.current) return;
      if (held()) {
        timer = window.setTimeout(arm, 50);
        return;
      }
      stopPadNav.current = startGamepadNav();
    };
    let timer = window.setTimeout(arm, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [padToGame]);
  useEffect(() => () => stopPadNav.current?.(), []);

  const refresh = useCallback(async () => {
    try {
      const s = await api.getStatus();
      setStatus(s);
      setView(s.signedIn && s.usable !== false ? { name: "library" } : { name: "signin" });
    } catch {
      setView({ name: "signin" });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A stream that is left, fails, or is exited must not stay running on a real
  // machine, so the way back always goes through here.
  const leaveStream = useCallback(() => {
    void api.stopSession().catch(() => {});
    setView({ name: "library" });
  }, []);

  if (view.name === "loading") {
    return <Splash>{t("library.loading")}</Splash>;
  }
  if (view.name === "signin") {
    return <SignIn status={status} onSignedIn={refresh} onExit={onExit} />;
  }
  if (view.name === "stream") {
    return <Stream title={view.title} onLeave={leaveStream} onUiNeedsPad={setPadForUi} />;
  }
  return (
    <Library status={status} onPlay={(title) => setView({ name: "stream", title })} onSignedOut={refresh} />
  );
}

export function Splash({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-bg-0 text-fg-dim">
      <p className="text-2xl">{children}</p>
    </div>
  );
}
