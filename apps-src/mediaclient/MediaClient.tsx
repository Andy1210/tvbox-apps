import { useEffect } from "react";
import { useBackspace } from "@sdk";
import { Home } from "./Home";
import { Library } from "./Library";
import { Login } from "./Login";
import { Message } from "./Message";
import { useApp } from "./state";

export interface MediaClientProps {
  /** Leave the app and return to the launcher. */
  onExit: () => void;
}

/**
 * Root of the media client.
 *
 * The player stage is a sibling of every screen rather than something the player
 * mounts: the shell reveals mpv by making this page transparent down to the node
 * the manifest names, so that node has to exist whether or not anything is
 * playing.
 */
export function MediaClient({ onExit }: MediaClientProps): React.JSX.Element {
  const screen = useApp((s) => s.screen);
  const boot = useApp((s) => s.boot);
  const back = useApp((s) => s.back);

  useEffect(() => {
    void boot();
  }, [boot]);

  // Back walks the screens first and only leaves the app from the top, which is
  // what the remote's Back means everywhere else on this box.
  useBackspace(() => {
    if (!back()) onExit();
  });

  return (
    <div className="flex h-full flex-col">
      <div id="player-stage" className="pointer-events-none absolute inset-0" />
      <main className="relative flex flex-1 flex-col overflow-hidden">
        {screen.name === "boot" && <Message loading />}
        {screen.name === "login" && <Login />}
        {screen.name === "home" && <Home />}
        {screen.name === "library" && (
          // Keyed on the library so switching between two of them starts a fresh
          // grid rather than showing the previous one's rows while it reloads.
          <Library key={screen.libraryId} libraryId={screen.libraryId} title={screen.title} />
        )}
        {(screen.name === "item" || screen.name === "person" || screen.name === "search" || screen.name === "settings") && (
          <Message text="…" />
        )}
      </main>
    </div>
  );
}
