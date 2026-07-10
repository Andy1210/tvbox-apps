import { useCallback, useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, verifyPin, postNowPlaying, useConfigStore, FocusButton, PinPad, isBackKey } from "@sdk";
import { fetchChannels, fetchEpg, groupChannels, type Channel, type ChannelGroup, type EpgEntry } from "./api";
import { ChannelBrowser } from "./ChannelBrowser";
import { PlayerOverlay } from "./PlayerOverlay";
import { TrackMenu } from "./TrackMenu";
import { LiveTvSettings } from "./LiveTvSettings";
import { EpgGuide } from "./EpgGuide";

interface Playing {
  list: Channel[];
  idx: number;
}

// Error screen. "not_configured" -> set up; "unreachable"/other -> retry. Both
// actions offered; the relevant one is focused.
function LiveTvError({ error, onConfigure, onRetry }: { error: string; onConfigure: () => void; onRetry: () => void }) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "livetv-error" });
  const notConfigured = error === "not_configured";
  const msg = notConfigured
    ? t("livetv.notConfigured")
    : error === "unreachable"
      ? t("livetv.unreachable")
      : t("livetv.error");
  useEffect(() => {
    setFocus(notConfigured ? "livetv-configure" : "livetv-retry");
  }, [notConfigured]);
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col items-center justify-center gap-[2.5vh] px-[8vw] text-center">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          className="w-[7vh] h-[7vh] text-white/45"
        >
          <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
          <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" />
        </svg>
        <div className="text-[2.4vh] font-semibold">{msg}</div>
        <div className="flex gap-[1.5vw]">
          <FocusButton
            focusKey="livetv-retry"
            onEnter={onRetry}
            className="px-[2.5vw] py-[1.6vh] rounded-[1.2vh] bg-white/10 text-[2.1vh] font-semibold"
          >
            {t("livetv.retry")}
          </FocusButton>
          <FocusButton
            focusKey="livetv-configure"
            onEnter={onConfigure}
            className="px-[2.5vw] py-[1.6vh] rounded-[1.2vh] bg-white/10 text-[2.1vh] font-semibold"
          >
            {t("livetv.configure")}
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

// Built-in Live TV app: browse channels (category + grid), play a stream through
// the shell's mpv service (window.tvbox.play), zap, and show a now/next banner.
// Back exits playback -> browse -> HOME; the remote Home button (shell) always
// returns to the launcher.
export function LiveTV({ onExit }: { onExit: () => void }) {
  const { t } = useI18n();
  const [groups, setGroups] = useState<ChannelGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<Playing | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [epg, setEpg] = useState<EpgEntry[]>([]);
  const [banner, setBanner] = useState(false);
  // audio/subtitle tracks of the playing stream (window.tvbox.tracks; [] on old
  // shells or before mpv loads) + whether the picker panel is open
  const [tracks, setTracks] = useState<TvboxTrack[]>([]);
  const [trackMenu, setTrackMenu] = useState(false);
  const epgReq = useRef(0);
  // parental lock — locked categories come from the config store (auto-updates
  // when changed in settings). Select the STABLE `config` ref and derive the
  // array in render: a `?? []` inside the selector returns a fresh array every
  // call, which makes zustand's useSyncExternalStore see a change on every render
  // and loop forever (React #185 "maximum update depth") while config is still
  // null — the standalone app renders LiveTV before config finishes loading.
  const config = useConfigStore((s) => s.config);
  const lockedGroups = config?.parental.lockedGroups ?? [];
  const [unlocked, setUnlocked] = useState(false);
  const [gate, setGate] = useState<Channel | null>(null);
  const [pinError, setPinError] = useState<string | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guideChannels, setGuideChannels] = useState<Channel[] | null>(null);
  const [surf, setSurf] = useState(false); // browsing the list while the current channel plays in a PiP

  const loadChannels = useCallback(() => {
    setLoading(true);
    fetchChannels().then(({ channels, error }) => {
      if (error || !channels.length) setError(error || "error");
      else {
        setGroups(groupChannels(channels));
        setError(null);
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  // re-query the stream's track list (safe no-op on shells without the API)
  const refreshTracks = useCallback(() => {
    window.tvbox
      ?.tracks?.()
      ?.then(setTracks)
      .catch(() => {});
  }, []);

  // player events from the shell (subscribe once; functional updates avoid stale state)
  useEffect(() => {
    if (!window.tvbox?.onPlayer) return;
    return window.tvbox.onPlayer((ev) => {
      if (ev.type === "buffering") setBuffering(!!ev.on);
      else if (ev.type === "playing") {
        setBuffering(false);
        refreshTracks(); // mpv has the stream loaded -> track list is meaningful now
      } else if (ev.type === "finished" || ev.type === "error") setPlaying(null); // stream dropped -> back to browse
    });
  }, [refreshTracks]);

  // publish now-playing (channel) to the shell -> MQTT/HA; idle on stop + unmount
  useEffect(() => {
    const ch = playing ? playing.list[playing.idx] : null;
    postNowPlaying(ch ? { app: "livetv", state: "playing", title: ch.name } : { app: "livetv", state: "idle" });
  }, [playing]);
  useEffect(() => () => postNowPlaying({ app: "livetv", state: "idle" }), []);

  const startPlay = useCallback((list: Channel[], idx: number) => {
    const ch = list[idx];
    if (!ch) return;
    window.tvbox?.play?.(ch.url);
    setPlaying({ list, idx });
    setBuffering(true);
    setBanner(true);
    setTracks([]); // stale tracks belong to the previous channel; refreshed on "playing"
    setEpg([]);
    const req = ++epgReq.current;
    fetchEpg(ch.id).then((e) => {
      if (req === epgReq.current) setEpg(e);
    });
  }, []);

  const doPlay = useCallback(
    (ch: Channel) => {
      const g = groups.find((x) => x.group === ch.group);
      const list = g ? g.channels : [ch];
      const idx = Math.max(
        0,
        list.findIndex((c) => c.id === ch.id),
      );
      startPlay(list, idx);
    },
    [groups, startPlay],
  );

  // parental gate: a channel in a locked category needs the PIN (once per session)
  const play = useCallback(
    (ch: Channel) => {
      if (!unlocked && lockedGroups.includes(ch.group)) {
        setPinError(undefined);
        setGate(ch);
        return;
      }
      doPlay(ch);
    },
    [unlocked, lockedGroups, doPlay],
  );

  const stop = useCallback(() => {
    window.tvbox?.stop?.();
    setPlaying(null);
    setTracks([]);
    setEpg([]);
  }, []);

  // auto-hide the info banner
  useEffect(() => {
    if (!playing || !banner) return;
    const id = setTimeout(() => setBanner(false), 5000);
    return () => clearTimeout(id);
  }, [playing, banner, epg]);

  // the track picker only exists over a live stream (also covers finished/error)
  useEffect(() => {
    if (!playing) setTrackMenu(false);
  }, [playing]);

  // the picker is worth opening only when there is a real choice
  const audioCount = tracks.filter((x) => x.type === "audio").length;
  const subCount = tracks.filter((x) => x.type === "sub").length;
  const trackMenuAvailable = audioCount >= 2 || subCount >= 1;

  // enter surf: just show the browser; it measures the PiP placeholder and calls
  // pipToRect, which positions mpv exactly there. exit: restore fullscreen.
  const enterSurf = useCallback(() => setSurf(true), []);
  const exitSurf = useCallback(() => {
    setSurf(false);
    window.tvbox?.pip?.(false);
  }, []);
  const pipToRect = useCallback(
    (r: { x: number; y: number; w: number; h: number }) => window.tvbox?.pip?.(true, r),
    [],
  );

  // remote keys: Back (exit playback->browse->home), Left (open the list while
  // watching -> PiP), and zapping while playing. While surfing, the browser owns
  // navigation; only Back is handled here (restore fullscreen). While the track
  // picker is open it owns the keys (its own useBackspace + spatial nav).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (gate || settingsOpen || trackMenu || (guideChannels && !playing)) return; // those views handle their own keys
      if (surf) {
        // isBackKey, not a bare Backspace check: BT remotes report Back as
        // Escape/BrowserBack/GoBack (same set the sdk's useBackspace accepts)
        if (isBackKey(ev)) {
          ev.preventDefault();
          exitSurf();
        }
        return;
      }
      if (isBackKey(ev)) {
        ev.preventDefault();
        if (playing) stop();
        else onExit();
        return;
      }
      if (!playing) return;
      if (ev.key === "ArrowLeft") {
        ev.preventDefault();
        enterSurf();
      } else if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
        ev.preventDefault();
        const dir = ev.key === "ArrowDown" ? 1 : -1;
        const n = (playing.idx + dir + playing.list.length) % playing.list.length;
        startPlay(playing.list, n);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        // first press: info banner; second press while it shows: track picker
        // (only when there is something to pick - otherwise Enter just re-arms
        // the banner). refreshTracks keeps the availability/hint current for
        // streams that expose tracks late.
        if (banner && trackMenuAvailable) {
          setBanner(false);
          setTrackMenu(true);
        } else {
          setBanner(true);
          refreshTracks();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    playing,
    stop,
    startPlay,
    onExit,
    gate,
    settingsOpen,
    guideChannels,
    surf,
    enterSurf,
    exitSurf,
    trackMenu,
    banner,
    trackMenuAvailable,
    refreshTracks,
  ]);

  if (loading) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-[2vh]">
        <div className="w-[6vh] h-[6vh] rounded-full border-[0.5vh] border-white/20 border-t-white animate-spin" />
        <div className="text-[2vh] text-fg-dim">{t("livetv.loading")}</div>
      </div>
    );
  }

  if (settingsOpen) {
    return (
      <LiveTvSettings
        groups={groups.map((g) => g.group)}
        onExit={() => {
          setSettingsOpen(false);
          loadChannels();
        }}
      />
    );
  }

  if (playing && surf) {
    // browse the list while the current channel keeps playing in a top-right PiP
    return (
      <ChannelBrowser
        groups={groups}
        onPlay={(ch) => {
          // exitSurf (not a bare setSurf(false)): restore fullscreen mpv too -
          // play() may divert to the PIN gate instead of starting a stream,
          // which would otherwise leave mpv parked in the PiP rectangle
          exitSurf();
          play(ch);
        }}
        lockedGroups={lockedGroups}
        onOpenSettings={() => {
          exitSurf();
          setSettingsOpen(true);
        }}
        onOpenGuide={(chs) => {
          exitSurf();
          setGuideChannels(chs);
        }}
        pipActive
        onPipRect={pipToRect}
      />
    );
  }

  // The PIN gate renders BEFORE the player: surf-zapping onto a locked channel
  // sets `gate` while the previous channel keeps playing - the PinPad must win
  // that render (its own Back handler works; the raw key handler above is
  // gated off), otherwise the screen goes key-dead behind the player overlay.

  if (gate) {
    return (
      <PinPad
        title={t("parental.enterPin")}
        error={pinError}
        onCancel={() => setGate(null)}
        onSubmit={async (pin) => {
          if (await verifyPin(pin)) {
            setUnlocked(true);
            const ch = gate;
            setGate(null);
            doPlay(ch);
          } else {
            setPinError(t("parental.wrongPin"));
          }
        }}
      />
    );
  }

  if (playing) {
    const ch = playing.list[playing.idx];
    return (
      <>
        <PlayerOverlay
          channel={ch}
          epg={epg}
          buffering={buffering}
          bannerVisible={banner}
          trackHint={trackMenuAvailable}
        />
        {trackMenu && (
          <TrackMenu
            tracks={tracks}
            onClose={() => {
              setTrackMenu(false);
              refreshTracks(); // pull mpv's view so a reopened picker shows the confirmed selection
            }}
          />
        )}
      </>
    );
  }


  if (guideChannels) {
    return <EpgGuide channels={guideChannels} onPlay={play} onExit={() => setGuideChannels(null)} />;
  }

  if (error) {
    return <LiveTvError error={error} onConfigure={() => setSettingsOpen(true)} onRetry={() => loadChannels()} />;
  }

  return (
    <ChannelBrowser
      groups={groups}
      onPlay={play}
      lockedGroups={lockedGroups}
      onOpenSettings={() => setSettingsOpen(true)}
      onOpenGuide={(chs) => setGuideChannels(chs)}
    />
  );
}
