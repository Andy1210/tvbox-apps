import { useEffect } from "react";
import { installNavSounds, setSoundsEnabled, setSoundsSuppressed, tvbox, useBackspace, useConfigStore } from "@sdk";
import { Detail } from "./Detail";
import { Home } from "./Home";
import { Library } from "./Library";
import { Login } from "./Login";
import { Message } from "./Message";
import { AddBanner } from "./music/AddBanner";
import { MiniPlayer } from "./music/MiniPlayer";
import { MusicHome } from "./music/MusicHome";
import { MusicItem } from "./music/MusicItem";
import { MusicList } from "./music/MusicList";
import { NowPlaying } from "./music/NowPlaying";
import { Person } from "./Person";
import { Player } from "./Player";
import { Profiles } from "./Profiles";
import { Search } from "./Search";
import { Settings } from "./Settings";
import { useMusic } from "./playback/music";
import { usePlayer } from "./playback/player";
import { useMusicMediaKeys } from "./playback/mediakeys";
import { useApp } from "./state";
import { deviceName } from "./identity";
import { usePrefs } from "./prefs";
import { useChosenVersion } from "./chosenVersion";
import { startCompanion } from "./backends/plex/companion";
import { companionTimelines, runCompanionCommand, runPendingCast } from "./playback/remoteControl";

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
/**
 * Which of the two Plex receivers on this box is the live one.
 *
 * Best effort and never awaited: a box without the plugin (an app newer than
 * the shell it landed on) simply answers 404, and this app polls as it always
 * did. What it must not do is delay the poll it is announcing.
 */
function tellBox(what: "poll-taken" | "poll-released"): void {
  try {
    void fetch(`/tvbox/api/mediaclient/${what}`, { method: "POST", keepalive: what === "poll-released" }).catch(
      () => {},
    );
  } catch (e) {
    /* no shell (dev, tests) */
  }
}

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
  // The same setting the box reads. Without it the switch turned off only the
  // half of the receiver that runs OUT here: the box hides an app rather than
  // closing it, so once anybody had opened this app its own page went on
  // answering Plex, and Settings said the television was not offered while it
  // was - measured against the shell plugin, which stands down whenever this
  // window exists.
  const castEnabled = usePrefs((s) => s.cast);
  useEffect(() => {
    if (!session || !identity || picking || !castEnabled) return;
    // Plex's protocol, not a general one: `player/proxy/poll` is a Plex route,
    // and this loop reads a 401 as "signed out". Pointed at a Jellyfin server it
    // would poll a path that does not exist, forever - and the day that server
    // answered 401 instead of 404 it would sign the household out of it. A
    // session with no `kind` is a Plex one written before there was a second
    // backend, so it keeps the loop.
    if (session.kind === "jellyfin") return;
    // Tell the box BEFORE polling, and again when this stops. The box answers
    // Plex while this app is closed, and the two must never both poll (they
    // share one client identifier, so they would take each other's commands)
    // nor both fall silent - measured, standing the box down the moment it
    // handed a cast over left a gap the length of this app's boot, and a phone
    // sends `subscribe` straight after casting: it spun, gave up, and only
    // stuck on a second try, sometimes playing the song on the phone instead.
    void tellBox("poll-taken");
    const stop = startCompanion({
      baseUrl: session.baseUrl,
      token: session.token,
      serverId: session.serverId,
      id: { clientId: identity.clientId, deviceName: deviceName(identity.host) },
      onCommand: runCompanionCommand,
      // What the box is doing, asked for on a tick while something plays and
      // after every command. Without it a phone that casts stays on
      // "connecting": it subscribes and then waits to be told.
      timelines: () => companionTimelines({ machineIdentifier: session.serverId, baseUrl: session.baseUrl }),
      // A rejected credential is what everything else in this app calls
      // "signed out"; swallowing it here left the box polling with a dead
      // token and nothing on screen.
      onUnauthorized: () => useApp.getState().fail({ kind: "signed-out" }),
    });
    return () => {
      stop();
      void tellBox("poll-released");
    };
  }, [session, identity, picking, castEnabled]);

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

  // A cast may be what opened this app: the box answers Plex while the app is
  // closed and leaves the command here. After boot, because it needs the
  // session that boot restores.
  const signedIn = Boolean(session);
  useEffect(() => {
    if (!signedIn || picking) return;
    void runPendingCast();
  }, [signedIn, picking]);

  /**
   * The box's screensaver, over this app.
   *
   * The launcher owns the ambient screen and its window is hidden while an app
   * is in front, so its idle timer cannot arm behind this one - a media client
   * left on a poster grid is a still picture the box would hold all night. The
   * keys land in this window, so this is where the counting has to be, on the
   * same delay the person chose for the launcher.
   *
   * Not while a FILM is loaded, paused included: the shell refuses then anyway,
   * because reaching the launcher would END mpv rather than hide it. Music is
   * the exception the shell makes - audio outlives the launcher coming forward -
   * so a paused song is asked over and a playing one is not. And not on the
   * sign-in screen, which is a code being read off the television while somebody
   * types it into a phone - the one screen where minutes without a press mean
   * attention rather than absence.
   *
   * The profile picker is NOT excluded, though it also asks for something: it
   * shows nothing that has to be read off the screen, the window is hidden
   * rather than closed, and a key brings it back with the PIN half-typed
   * exactly as it was. A box left on the picker all night is the still picture
   * this exists to prevent.
   *
   * Absent on a shell older than this feature, where the call is simply not
   * there.
   */
  const ambient = useConfigStore((s) => s.config?.ambient);
  const waitingToSignIn = screen.name === "login";
  /**
   * Music PLAYING, which is a different question from music being loaded.
   *
   * A song paused on the player screen is a still picture like any other and the
   * screensaver belongs over it - the shell allows that now, because audio-only
   * playback survives the launcher coming forward, so nothing is lost by asking.
   * A song that is actually playing is what the screen is FOR, and the player's
   * own idle view is what keeps that from being a static picture.
   */
  const musicPlaying = useMusic((s) => s.state === "playing");
  useEffect(() => {
    const minutes = ambient?.idleMinutes ?? 0;
    if (!ambient?.enabled || minutes <= 0 || playing || musicPlaying || waitingToSignIn) return;
    let last = Date.now();
    const bump = (): void => {
      last = Date.now();
    };
    window.addEventListener("keydown", bump, true);
    window.addEventListener("pointermove", bump, true);
    // The return edge is not optional. A hidden renderer's timers are throttled
    // to roughly one wake a minute and frozen outright after a while, so the
    // interval below cannot keep the stamp fresh while the screensaver is up:
    // the first tick after coming back compared against a minutes-old stamp and
    // asked again about twenty seconds later, whatever the person had
    // configured. Measured on the box at a one-minute setting: 60 s asked for,
    // 20 s delivered. The launcher's own idle timer carries the same guard.
    document.addEventListener("visibilitychange", bump);
    const id = setInterval(() => {
      // A hidden window is not what anybody is looking at, and it receives none
      // of the keys that would reset this, so its time does not count.
      if (document.visibilityState !== "visible") return bump();
      if (Date.now() - last < minutes * 60_000) return;
      last = Date.now(); // asked; start counting again rather than asking every tick
      tvbox().ambient?.request();
    }, 5000);
    return () => {
      window.removeEventListener("keydown", bump, true);
      window.removeEventListener("pointermove", bump, true);
      document.removeEventListener("visibilitychange", bump);
      clearInterval(id);
    };
  }, [ambient?.enabled, ambient?.idleMinutes, playing, musicPlaying, waitingToSignIn]);

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

  // Here rather than on the player screen, because the screen is not mounted
  // for most of the time music is playing. See the module's own note.
  useMusicMediaKeys();

  /**
   * The add-to-queue mode belongs to the music screens, and ends with them.
   *
   * It changes what OK does, and its banner is drawn on those screens only - so
   * carried into the film side of the app it would be a mode nothing on screen
   * mentions, waiting to surprise whoever comes back. Turned off here rather
   * than by each screen's teardown, because walking between two music screens
   * unmounts one of them and that must not end the mode.
   */
  const musicScreen =
    screen.name === "music" ||
    screen.name === "musicList" ||
    screen.name === "musicItem" ||
    screen.name === "nowPlaying";
  useEffect(() => {
    if (!musicScreen && useMusic.getState().adding) useMusic.getState().setAdding(false);
  }, [musicScreen]);

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
        {/* Above the screens, because it is what says OK is adding rather than
            playing - and a mode nothing names is a remote that has changed
            meaning. NOT on the player: OK on a queue row there starts that song,
            mode or no mode, so the line would be describing the one screen where
            it is not true. */}
        {screen.name !== "nowPlaying" && <AddBanner />}
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
        {screen.name === "music" && (
          <MusicHome key={screen.libraryId} libraryId={screen.libraryId} title={screen.title} />
        )}
        {screen.name === "musicList" && (
          // Keyed on the lens too: songs, albums and artists are three different
          // lists, and reusing the mounted one would show the old rows and the
          // old letter strip while the new ones load.
          <MusicList
            key={`${screen.libraryId}-${screen.lens}`}
            libraryId={screen.libraryId}
            lens={screen.lens}
            title={screen.title}
          />
        )}
        {screen.name === "musicItem" && (
          <MusicItem
            key={screen.itemId}
            itemId={screen.itemId}
            kind={screen.kind}
            title={screen.title}
            libraryId={screen.libraryId}
          />
        )}
        {screen.name === "nowPlaying" && <NowPlaying />}
        {screen.name === "search" && <Search />}
        {screen.name === "settings" && <Settings />}
        {/* Outside the screens, because it belongs to none of them: it is what
            says the music is still on while you browse for the next thing. */}
        <MiniPlayer />
      </main>
    </div>
  );
}
