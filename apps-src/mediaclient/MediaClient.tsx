import { useEffect } from "react";
import { useBackspace } from "@sdk";
import { Detail } from "./Detail";
import { Home } from "./Home";
import { Library } from "./Library";
import { Login } from "./Login";
import { Message } from "./Message";
import { Person } from "./Person";
import { Player } from "./Player";
import { Profiles } from "./Profiles";
import { Search } from "./Search";
import { Settings } from "./Settings";
import { usePlayer } from "./playback/player";
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
  const playing = usePlayer((s) => s.current !== null);

  useEffect(() => {
    void boot();
  }, [boot]);

  // Back walks the screens first and only leaves the app from the top, which is
  // what the remote's Back means everywhere else on this box.
  //
  // While something is playing the player takes Back for itself (it pauses
  // rather than stops), so this must not also act on it - two handlers would
  // pause the film AND navigate away from it.
  useBackspace(() => {
    if (usePlayer.getState().current) return;
    if (!back()) onExit();
  });

  return (
    <div className="flex h-full flex-col">
      <div id="player-stage" className="pointer-events-none absolute inset-0">
        <Player />
      </div>
      <main
        className="relative flex flex-1 flex-col overflow-hidden"
        // While a film plays the page is transparent down to the stage, so the
        // browsing screens behind it must not be drawn over the picture.
        hidden={playing}
      >
        {screen.name === "boot" && <Message loading />}
        {screen.name === "login" && <Login />}
        {screen.name === "profiles" && <Profiles />}
        {screen.name === "home" && <Home />}
        {screen.name === "library" && (
          // Keyed on the library so switching between two of them starts a fresh
          // grid rather than showing the previous one's rows while it reloads.
          <Library key={screen.libraryId} libraryId={screen.libraryId} title={screen.title} />
        )}
        {screen.name === "item" && <Detail key={screen.itemId} itemId={screen.itemId} />}
        {screen.name === "person" && (
          <Person key={screen.personId} personId={screen.personId} personName={screen.personName} />
        )}
        {screen.name === "search" && <Search />}
        {screen.name === "settings" && <Settings />}
      </main>
    </div>
  );
}
