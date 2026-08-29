import { useEffect, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, useConfigStore, FocusButton, tvbox } from "@sdk";
import { NowPlaying } from "./NowPlaying";
import { SpotifySettings } from "./SpotifySettings";
import { Browser, playErrorText } from "./Browser";
import { useSpotifyStore } from "./stores/spotify";
import { authStatus, play, search, setSpotifyEnabled, URIS_MAX, type AuthStatus } from "./api";

/**
 * A song asked for out loud.
 *
 * The assistant publishes it to the box over MQTT and the shell hands it to this
 * window (`play_media`), because nothing outside the box can reach the Spotify
 * account: the credentials live in this app's own host plugin, behind an HTTP
 * server bound to loopback. So the search and the play happen HERE, with the
 * code the library screen already uses.
 *
 * The query travels as text rather than as a uri: whoever asked said a name, and
 * resolving a name to a Spotify uri needs the account that this box holds.
 */
type PlayMedia = { action: string; query?: unknown };

// Opt-in screen shown until Spotify Connect is enabled on this box. The
// librespot daemon (which advertises the box on the LAN) runs only once enabled
// — this is the built-in app's on/off switch, no account or setup required.
// Enabling is a single D-pad action (no root, no keyboard).
function SpotifyEnable({
  onEnable,
  onSettings,
  onExit,
}: {
  onEnable: () => void;
  onSettings: () => void;
  onExit: () => void;
}) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "sp-enable-screen" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setFocus("sp-enable");
  }, []);
  useBackspace(onExit);
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col items-center justify-center gap-[2.5vh] px-[8vw] text-center">
        <svg viewBox="0 0 24 24" className="w-[10vh] h-[10vh]" fill="#1DB954">
          <circle cx="12" cy="12" r="11" />
          <path
            d="M6.4 9.7c3.7-1.1 8.2-0.7 11.4 1.2M7 13c3-0.85 6.6-0.5 9 1.1M7.5 16c2.3-0.65 4.9-0.4 6.7 0.8"
            stroke="#0a160f"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
          />
        </svg>
        <div className="text-[3vh] font-bold">{t("spotify.enableTitle")}</div>
        <div className="text-[2vh] text-fg-dim max-w-[60vw]">{t("spotify.enableHint")}</div>
        <div className="flex gap-[1.5vw] mt-[1vh]">
          <FocusButton
            focusKey="sp-enable"
            onEnter={async () => {
              if (busy) return;
              setBusy(true);
              const ok = await setSpotifyEnabled(true);
              if (ok) onEnable();
              else setBusy(false);
            }}
            className="px-[4vw] py-[2vh] rounded-[1.4vh] bg-[#1DB954] text-[#06140c] text-[2.4vh] font-bold"
          >
            {busy ? t("spotify.starting") : t("spotify.enable")}
          </FocusButton>
          <FocusButton
            focusKey="sp-enable-settings"
            onEnter={onSettings}
            className="px-[3vw] py-[2vh] rounded-[1.4vh] bg-white/10 text-[2.4vh] font-semibold"
          >
            {t("settings.title")}
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

// Built-in Spotify app. Always a cast target once ENABLED (now-playing over
// SSE); when an account is connected (optional Web API), it also offers a
// library Browser. Casting auto-opens this screen (shell navigates here on the
// cast rising edge).
export function Spotify({ onExit }: { onExit: () => void }) {
  const { t } = useI18n();
  const [view, setView] = useState<"now" | "settings" | "browse">("now");
  /**
   * Whether the player screen was reached by starting something from the library.
   *
   * Starting a track leaves the library for the player, which is what somebody
   * who just pressed a song wants to see - but Back then left the app entirely,
   * so "that was the wrong song" meant opening the library again and typing the
   * search a second time. With this, Back goes back to where the press came
   * from, and the library is still showing what it was (stores/browse.ts).
   */
  const [fromBrowse, setFromBrowse] = useState(false);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  /** What a spoken request did, when it did not simply start playing. */
  const [asked, setAsked] = useState("");
  /**
   * A spoken request for the lyrics: what was asked for, and when.
   *
   * The timestamp is what makes the same request twice fire twice - somebody
   * asking again because the screen was on something else. The view that SHOWS
   * the lyrics owns the toggle, so this only carries the request down to it.
   */
  const [lyrics, setLyrics] = useState<{ state: string; at: number } | null>(null);
  /**
   * A spoken request waiting for the app to know whether it has an account.
   *
   * The command is what OPENS this app, so it arrives while the first
   * `authStatus()` is still in the air - acting on it there answered every
   * voice request with "connect an account", on a box that has one. Held until
   * the answer is in, then run once.
   */
  const [wanted, setWanted] = useState<string | null>(null);
  const enabled = useConfigStore((s) => s.config?.spotify.enabled ?? false);
  const loadConfig = useConfigStore((s) => s.load);
  // The SSE stream is owned by App (kept connected launcher-wide so now-playing
  // publishes even off this screen), so this view just reads the store.

  // refresh connection status whenever we return to now-playing (e.g. after
  // connecting an account in settings) so the Browse entry appears
  // Browse too, and not only to decide whether it is offered: the active account
  // can change while this screen is up (the box follows whoever casts to it), and
  // the library screen names the account it is showing.
  useEffect(() => {
    if (view === "now" || view === "browse") authStatus().then(setAuth);
  }, [view]);
  // ...and re-read it while Browse is open, because the handover happens without
  // anybody touching this screen. Naming the account is only worth doing if the
  // name is the one whose rows are on display: stale, it is a false claim, and
  // pressing a row would send that account's context to the new owner's player.
  useEffect(() => {
    if (view !== "browse") return;
    const id = setInterval(() => void authStatus().then(setAuth), 10000);
    return () => clearInterval(id);
  }, [view]);

  // A spoken request. The listener is here rather than on the player screen
  // because that screen is not the one on display when the request arrives - the
  // box may have been sitting in the library, or the app may have just been
  // opened by the command itself. Subscribed ONCE: re-subscribing when something
  // else on this screen changes would drop a request the shell had already
  // handed over, which is exactly the moment this arrives in.
  const connected = !!auth?.connected;
  useEffect(() => {
    const off = tvbox().onCommand?.((c) => {
      const cmd = c as PlayMedia & { state?: string; sounding?: string };
      if (!cmd) return;
      // The shell says which app it believes is making the sound, and a forwarded
      // command reaches the foreground app as well as that one - so with the media
      // client playing and this app on screen, a lyrics request would have opened
      // the words of THIS app's paused track over somebody else's music. Empty
      // means the shell does not know (or predates the field); a cast
      // (`play_media`) never travels this way, so it is unaffected.
      const sounding = String(cmd.sounding || "");
      if (sounding && sounding !== "spotify") return;
      const action = String(cmd.action || "");
      if (action === "lyrics") {
        // The player screen is the only one that has them, whichever screen the
        // request arrived on - the box may have been sitting in the library.
        setView("now");
        setLyrics({ state: String(cmd.state || "on"), at: Date.now() });
        return;
      }
      if (action !== "play_media") return;
      const query = String(cmd.query ?? "").trim();
      if (!query) return;
      setView("now"); // whatever it finds, this is the screen that shows it
      setWanted(query);
    });
    return off;
  }, []);

  useEffect(() => {
    // Not until the account is known - see `wanted`.
    if (wanted === null || auth === null) return;
    const query = wanted;
    setWanted(null);
    if (!connected) {
      // Search and play are Web API calls; without an account this app is a
      // speaker somebody else casts to, and there is nothing here to search.
      setAsked(t("spotify.voiceNoAccount"));
      return;
    }
    setAsked(t("spotify.voiceSearching", { query }));
    void search(query).then(async (r) => {
      if (!r.tracks.length) {
        setAsked(t("spotify.voiceNoMatch", { query }));
        return;
      }
      // The result list is the running order, so what was asked for is followed
      // by more of the same rather than by silence.
      const out = await play({ uris: r.tracks.slice(0, URIS_MAX).map((x) => x.uri) });
      setAsked(out.ok ? "" : playErrorText(t, out.error || ""));
    });
  }, [wanted, auth, connected, t]);

  // The box's screensaver, over this app. While an app is in front the launcher's
  // window is hidden and its idle timer is suppressed there on purpose - so
  // nothing would ever come up over this screen, and "nothing is playing" is a
  // static picture the box would hold all night. So we ask, on the same delay the
  // person chose for the launcher, and only from the screen that has nothing to
  // show: not while music is playing (that screen IS what to show), and not in
  // the library or the settings, where somebody is in the middle of something.
  //
  // The keys land in this window, so this is where the counting has to happen -
  // and the shell refuses the request unless this app really is the one on
  // screen. Absent on a shell that predates the request, where it no-ops.
  const ambient = useConfigStore((s) => s.config?.ambient);
  const playing = useSpotifyStore((s) => !!s.state?.is_playing);
  useEffect(() => {
    const minutes = ambient?.idleMinutes ?? 0;
    if (!ambient?.enabled || minutes <= 0 || view !== "now" || playing) return;
    let last = Date.now();
    const bump = () => {
      last = Date.now();
    };
    window.addEventListener("keydown", bump, true);
    window.addEventListener("pointermove", bump, true);
    const id = setInterval(() => {
      // A hidden window is not the screen anybody is looking at, and it receives
      // none of the keys that would reset this - so its time does not count.
      if (document.visibilityState !== "visible") return bump();
      if (Date.now() - last < minutes * 60000) return;
      last = Date.now(); // asked; start counting again rather than asking every tick
      tvbox().ambient?.request();
    }, 5000);
    return () => {
      window.removeEventListener("keydown", bump, true);
      window.removeEventListener("pointermove", bump, true);
      clearInterval(id);
    };
  }, [ambient?.enabled, ambient?.idleMinutes, view, playing]);

  // Not enabled yet: offer the one-tap enable screen, with a Settings entry so
  // the device name / account can be prepared first if desired.
  if (view !== "settings" && !enabled) {
    return <SpotifyEnable onEnable={() => loadConfig()} onSettings={() => setView("settings")} onExit={onExit} />;
  }

  if (view === "settings") return <SpotifySettings onBack={() => setView("now")} />;
  if (view === "browse")
    return (
      <Browser
        onBack={() => {
          setFromBrowse(false);
          setView("now");
        }}
        onPlayed={() => {
          setFromBrowse(true);
          setView("now");
        }}
        account={auth?.user || ""}
      />
    );
  return (
    <NowPlaying
      connected={connected}
      note={asked}
      lyrics={lyrics}
      onLyricsDone={() => setLyrics(null)}
      onNoteDone={() => setAsked("")}
      onSettings={() => setView("settings")}
      onBrowse={() => {
        setFromBrowse(false);
        setView("browse");
      }}
      onExit={() => {
        // One press back to the list that started this, and only once: a second
        // Back from the library leaves the app, as it always did.
        if (fromBrowse) {
          setFromBrowse(false);
          setView("browse");
          return;
        }
        onExit();
      }}
    />
  );
}
