import { useCallback, useEffect, useRef, useState } from "react";
import { FocusButton, useBackspace, useI18n } from "@sdk";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
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
    // It is loading the STATUS, not the catalogue - and after a while it has to
    // offer a way out, or an app whose plugin never answers is a screen with
    // nothing focused that only Home escapes.
    return <Splash onExit={onExit}>{t("connecting")}</Splash>;
  }
  if (view.name === "signin") {
    return <SignIn status={status} onSignedIn={refresh} onSignedOut={refresh} onExit={onExit} />;
  }
  if (view.name === "stream") {
    return <Stream title={view.title} onLeave={leaveStream} onUiNeedsPad={setPadForUi} />;
  }
  return (
    <Library
      status={status}
      onPlay={(title) => setView({ name: "stream", title })}
      onSignedOut={refresh}
      onExit={onExit}
    />
  );
}

export function Splash({ children, onExit }: { children: React.ReactNode; onExit?: () => void }) {
  const { t } = useI18n();
  // Long enough that an ordinary cold start never shows it - the plugin answers in
  // milliseconds - and short enough that nobody sits in front of a still screen
  // wondering. Until then there is deliberately nothing to press: a button that
  // appears at once invites leaving a start that was going to work.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setStuck(true), 10000);
    return () => clearTimeout(id);
  }, []);
  useBackspace(() => onExit?.());
  useEffect(() => {
    if (!stuck) return;
    const id = setTimeout(() => setFocus("splash-exit"), 0);
    return () => clearTimeout(id);
  }, [stuck]);
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-[3vh] bg-bg-0 text-fg-dim">
      <p className="text-[2.2vh]">{children}</p>
      {stuck && onExit && (
        <>
          <p className="text-[1.7vh] text-warn">{t("errors.slow")}</p>
          <FocusButton
            focusKey="splash-exit"
            className="rounded-xl bg-bg-1 px-10 py-4 text-[1.9vh] text-fg"
            onEnter={onExit}
          >
            {t("signin.exit")}
          </FocusButton>
        </>
      )}
    </div>
  );
}
