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
  const streaming = view.name === "stream";
  useEffect(() => {
    if (streaming) {
      stopPadNav.current?.();
      stopPadNav.current = null;
      return;
    }
    if (!stopPadNav.current) stopPadNav.current = startGamepadNav();
  }, [streaming]);
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
    return <Stream title={view.title} onLeave={leaveStream} />;
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

export function Splash({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-bg-0 text-fg-dim">
      <p className="text-2xl">{children}</p>
    </div>
  );
}
