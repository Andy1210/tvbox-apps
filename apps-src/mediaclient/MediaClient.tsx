import { useEffect } from "react";
import { installNavSounds, setSoundsEnabled, setSoundsSuppressed, useBackspace, useConfigStore } from "@sdk";
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
import { deviceName } from "./identity";
import { usePrefs } from "./prefs";
import { useChosenVersion } from "./chosenVersion";
import { startCompanion } from "./backends/plex/companion";
import { runCompanionCommand } from "./playback/remoteControl";

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

  // The same navigation ticks the launcher uses, honouring the same box-wide
  // setting - a household that turned them off there does not expect them back
  // inside an app. The listener is permanent; the setting only flips the flag.
  // Read once at start: everything below reads them, and Settings writes.
  const loadPrefs = usePrefs((s) => s.load);
  useEffect(() => void loadPrefs(), [loadPrefs]);
  // Read once at start too: a detail screen needs it the moment its item
  // arrives, and a fetch per screen would be a round trip before the version
  // chips could be drawn correctly.
  const loadVersions = useChosenVersion((s) => s.load);
  useEffect(() => void loadVersions(), [loadVersions]);

  /**
   * Answer the remote control protocol while somebody is signed in.
   *
   * This is what lets a film be started by voice: the assistant creates a play
   * queue on the server and points a `playMedia` at this box by name, and the
   * same wire carries a phone's play, pause and skip. It cannot run before
   * sign-in - there is no server to poll and no token to poll it with - and it
   * must stop at sign-out, or the box keeps answering for an account that has
   * left.
   */
  const session = useApp((s) => s.session);
  const identity = useApp((s) => s.identity);
  // Not while the profile picker is up. The session and the backend are set in
  // the same call that shows it, so the loop would otherwise start holding the
  // PREVIOUS person's token - and a command would play as them, history and
  // all, without passing the picker or its PIN.
  const picking = screen.name === "profiles" || screen.name === "login" || screen.name === "boot";
  useEffect(() => {
    if (!session || !identity || picking) return;
    return startCompanion({
      baseUrl: session.baseUrl,
      token: session.token,
      id: { clientId: identity.clientId, deviceName: deviceName(identity.host) },
      onCommand: runCompanionCommand,
      // A rejected credential is what everything else in this app calls
      // "signed out"; swallowing it here left the box polling with a dead
      // token and nothing on screen.
      onUnauthorized: () => useApp.getState().fail({ kind: "signed-out" }),
    });
  }, [session, identity, picking]);

  useEffect(() => installNavSounds(), []);
  // Through the store rather than a one-shot fetch, so turning the setting off
  // in Settings reaches an app that is already open. `ui` is read defensively:
  // an app installed over the air outlives the shell it was built against, and
  // a config without that section would otherwise throw inside the effect.
  const navSounds = useConfigStore((s) => s.config?.ui?.navSounds);
  const loadConfig = useConfigStore((s) => s.load);
  useEffect(() => {
    void loadConfig().catch(() => {});
  }, [loadConfig]);
  useEffect(() => {
    setSoundsEnabled(navSounds ?? true);
  }, [navSounds]);
  // Silent while a film is on: a tick over the soundtrack is the one place they
  // are unwelcome, which is what the launcher does behind its own video too.
  useEffect(() => {
    setSoundsSuppressed(playing);
    return () => setSoundsSuppressed(false);
  }, [playing]);

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
        {screen.name === "item" && (
          <Detail
            key={screen.itemId}
            itemId={screen.itemId}
            focusChildId={screen.focusChildId}
            queueFrom={screen.queueFrom}
          />
        )}
        {screen.name === "person" && (
          <Person key={screen.personId} personId={screen.personId} personName={screen.personName} />
        )}
        {screen.name === "search" && <Search />}
        {screen.name === "settings" && <Settings />}
      </main>
    </div>
  );
}
