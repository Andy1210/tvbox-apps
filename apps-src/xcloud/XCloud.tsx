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
    if (!stopPadNav.current) stopPadNav.current = startGamepadNav();
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
