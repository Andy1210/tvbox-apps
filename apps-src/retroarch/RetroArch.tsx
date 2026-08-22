import { useCallback, useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, useConfigStore, useFocusableItem, tvbox } from "@sdk";
import { fetchGames, fetchSystems, play, type Entry, type SystemRow } from "./api";
import { FAVOURITES, RECENT, isVirtual, useLibrary, type GameRef } from "./library";
import {
  ART_PAGE,
  CONSOLES_PAGE,
  EMPTY_ACTION,
  FOLDERS_PAGE,
  RAIL,
  SAVES_PAGE,
  SCAN_PAGE,
  SEARCH,
  TABS,
  TILES,
  focusLost,
  jump,
} from "./focus";
import { GameGrid, type RailRow } from "./GameGrid";
import { Consoles } from "./Consoles";
import { Artwork } from "./Artwork";
import { Scan } from "./Scan";
import { Folders } from "./Folders";
import { Saves } from "./Saves";

type View = "games" | "consoles" | "art" | "scan" | "folders" | "saves";
const LAST_SYSTEM = "tvbox.retroarch.system";
// Where "down out of the tabs" lands, per view: the first of these that is actually
// mounted. For the games view that is the covers, falling back to the console list
// when a console has none - NOT the page container, whose children are containers
// themselves, which is why the tabs used to be a one-way street.
const VIEW_CONTENT: Record<View, string[]> = {
  games: [TILES, RAIL, EMPTY_ACTION, SEARCH],
  consoles: [CONSOLES_PAGE],
  art: [ART_PAGE],
  scan: [SCAN_PAGE],
  folders: [FOLDERS_PAGE],
  saves: [SAVES_PAGE],
};

function Tab({
  id,
  view,
  label,
  active,
  onPick,
}: {
  id: View;
  view: View;
  label: string;
  active: boolean;
  onPick: (v: View) => void;
}) {
  const { ref, focused } = useFocusableItem({
    focusKey: "tab-" + id,
    onEnterPress: () => onPick(id),
    // Geometry cannot connect a tab to the content below it (see GameGrid), so the
    // way back in is explicit.
    onArrowPress: (dir) => {
      if (dir !== "down") return true;
      // Swallow the press only if it landed somewhere, or the tab row would eat a
      // press that could still have moved by geometry.
      return !jump(...VIEW_CONTENT[view]);
    },
  });
  return (
    <div
      ref={ref}
      onClick={() => onPick(id)}
      className={[
        "px-[1.4vw] py-[0.9vh] rounded-[1vh] text-[1.8vh] font-semibold",
        focused ? "bg-white text-[#06090d]" : active ? "bg-white/15" : "bg-white/5 text-fg-dim",
      ].join(" ")}
    >
      {label}
    </div>
  );
}

// The screen while a game is starting. The emulator takes a couple of seconds to map
// its window and the shell hides this one behind it, so without a word here the TV
// would just sit on the grid as if nothing had been pressed.
function Starting({ label }: { label: string }) {
  const { t } = useI18n();
  return (
    <div className="absolute inset-0 bg-bg-0/80 flex flex-col items-center justify-center gap-[1.5vh] z-20">
      <div className="text-[2.6vh] font-semibold text-center px-[10vw]">{label}</div>
      <div className="text-[1.8vh] text-fg-dim">{t("retroarch.starting")}</div>
    </div>
  );
}

export function RetroArchApp({ onExit }: { onExit: () => void }) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "retroarch-app" });
  const [view, setView] = useState<View>("games");
  const [systems, setSystems] = useState<SystemRow[]>([]);
  const [system, setSystem] = useState("");
  const [games, setGames] = useState<Entry[]>([]);
  const favourites = useLibrary((s) => s.favourites);
  const recent = useLibrary((s) => s.recent);
  const notePlayed = useLibrary((s) => s.notePlayed);
  /**
   * One console's list, kept while this screen is up.
   *
   * The two categories span consoles, so opening one would otherwise be a
   * request per console every time the cursor passed over it. Cleared whenever
   * the consoles are re-read, which is what a scan or a finished game does.
   */
  const listCache = useRef(new Map<string, Entry[]>());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState("");
  /**
   * Marking favourites rather than starting games.
   *
   * Here rather than in the grid, because the two things that end a mode are
   * both here: Back, which used to leave the APP with it still set (the window
   * is hidden, not destroyed, so it came back armed), and changing tab, which
   * used to end it silently by unmounting the grid. A mode that outlives leaving
   * and dies on a tab change is the wrong way round in both halves.
   */
  const [marking, setMarking] = useState(false);

  const loadSystems = useCallback(() => {
    return fetchSystems()
      .then((d) => {
        listCache.current.clear();
        setSystems(d.systems);
        // Whatever console was last looked at, if it is still there.
        setSystem((cur) => {
          if (cur && (isVirtual(cur) || d.systems.some((s) => s.system === cur))) return cur;
          const saved = localStorage.getItem(LAST_SYSTEM) || "";
          const first = d.systems.find((s) => s.games > 0) || d.systems[0];
          // A category is only a place to open on while it still HOLDS
          // something: unfavourite the last game and the app would otherwise
          // start on a screen headed "Kedvencek", reading "this console has no
          // games", offering a full library rescan - with no rail row for the
          // category it claims to be in.
          const stocked = saved === FAVOURITES ? favourites.length > 0 : saved === RECENT ? recent.length > 0 : false;
          if (stocked || d.systems.some((s) => s.system === saved)) return saved;
          return first ? first.system : "";
        });
      })
      .catch(() => setError(t("retroarch.stateError")));
  }, [t, favourites.length, recent.length]);

  useEffect(() => {
    loadSystems();
  }, [loadSystems]);

  /** One console's list, from the cache or from the plugin. */
  const listOf = useCallback(async (sys: string): Promise<Entry[]> => {
    const hit = listCache.current.get(sys);
    if (hit) return hit;
    const d = await fetchGames(sys);
    const rows = d.games.map((g) => ({ ...g, system: sys }));
    listCache.current.set(sys, rows);
    return rows;
  }, []);

  /**
   * What the grid shows.
   *
   * A console is its own playlist. A category is a list of remembered games, and
   * each one has to be found again in its console's CURRENT playlist: the index
   * a game had moves when that playlist is rescanned, so a stored index would
   * quietly start the wrong game. One matched by nothing has been removed from
   * the library, and is left out rather than drawn as a tile that cannot start.
   */
  const refs: GameRef[] | null = system === FAVOURITES ? favourites : system === RECENT ? recent : null;
  // The identity of the list, so the effect below does not re-run on every
  // render just because the array is a new one.
  const refsKey = refs ? refs.map((r) => r.system + "\u0000" + r.label).join("\u0001") : "";
  useEffect(() => {
    if (!system) {
      setGames([]);
      setLoading(false);
      return;
    }
    localStorage.setItem(LAST_SYSTEM, system);
    setLoading(true);
    let alive = true;
    const wanted = refs;
    (async () => {
      try {
        if (!wanted) {
          const rows = await listOf(system);
          if (!alive) return;
          setGames(rows);
        } else {
          const lists = new Map<string, Entry[]>();
          for (const sys of new Set(wanted.map((r) => r.system))) lists.set(sys, await listOf(sys));
          if (!alive) return;
          setGames(
            wanted
              .map((r) => (lists.get(r.system) || []).find((g) => g.label === r.label))
              .filter((g): g is Entry => Boolean(g)),
          );
        }
        if (alive) setError("");
      } catch {
        if (alive) setError(t("retroarch.gamesError"));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // `refs` is read through `refsKey`, which is what says the list really changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [system, refsKey, listOf, t]);

  // Back: out of a subview to the games, and from the games out of the app. The app
  // is left through the shell (window.tvbox.home()), which is also what the Home
  // button does - so there is exactly one way out and it always works.
  useBackspace(() => {
    // A mode where OK does something else is the first thing Back should undo -
    // and leaving the app with it set is how the next visit surprises somebody.
    if (marking) {
      setMarking(false);
      return;
    }
    if (view !== "games") {
      setView("games");
      setFocus("tab-games");
      return;
    }
    onExit();
  });

  const onPlay = (game: Entry) => {
    setStarting(game.label);
    play(game.system, game.i)
      .then((r) => {
        if (r.ok) {
          // Only a launch the box ACCEPTED. Filing it before the answer put
          // covers that cannot start - no core, missing rom - into "recently
          // played", which is a row of dead ends. This window is hidden a moment
          // later, but the store has already been written by then.
          notePlayed({ system: game.system, label: game.label });
          return; // the shell is taking the screen; this window is about to be hidden
        }
        setStarting("");
        setError(
          r.error === "no_core"
            ? t("retroarch.noCoreFor", { system: game.system })
            : r.error === "rom_missing"
              ? t("retroarch.romMissing")
              : r.error === "shell_too_old"
                ? t("retroarch.shellTooOld")
                : t("retroarch.playFailed"),
        );
      })
      .catch(() => {
        setStarting("");
        setError(t("retroarch.playFailed"));
      });
  };

  // The window is hidden while the game runs and shown again when it exits, so the
  // "starting" overlay has to be cleared on the way back in - and the lists reread,
  // because a game that just ran may have been the first one to get a save file, a
  // cover, or (after Close Content) nothing at all.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") {
        // Leaving by the remote's HOME button hides this window rather than
        // destroying it, so the mode would still be set on the way back in -
        // Back clears it, and this is the other way out.
        setMarking(false);
        return;
      }
      setStarting("");
      loadSystems();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadSystems]);

  // Nothing to browse means nothing to focus: a box with no games has an empty grid,
  // an empty console rail, and therefore not one focusable element in this view - and
  // with the arrows dead there is no way to reach the tabs and install an emulator.
  // Whenever focus has nowhere to be, it goes to the content, or failing that the tabs.
  useEffect(() => {
    const id = setTimeout(() => {
      if (focusLost()) jump(...VIEW_CONTENT[view], TABS);
    }, 60); // after the render that changed what exists
    return () => clearTimeout(id);
  }, [view, systems, games, loading, starting]);

  // Off the games view there is nothing to mark, and the banner that says what
  // OK does is not drawn there either.
  useEffect(() => {
    if (view !== "games" && marking) setMarking(false);
  }, [view, marking]);

  const total = systems.reduce((n, s) => n + s.games, 0);
  /**
   * The rail: the two categories first, then the consoles.
   *
   * A category with nothing in it is left out. Empty, it is a row that leads to
   * a blank grid with nothing focusable in it - and the way to put the first
   * game in one is the star on the grid, not the rail.
   */
  const rail: RailRow[] = [
    ...(favourites.length
      ? [{ system: FAVOURITES, title: t("retroarch.favourites"), games: favourites.length } as RailRow]
      : []),
    ...(recent.length
      ? [{ system: RECENT, title: t("retroarch.recentlyPlayed"), games: recent.length } as RailRow]
      : []),
    ...systems,
  ];
  const railTitle =
    system === FAVOURITES ? t("retroarch.favourites") : system === RECENT ? t("retroarch.recentlyPlayed") : undefined;

  /**
   * The box's screensaver, over this app.
   *
   * The launcher owns it and its window is hidden while an app is in front, so
   * its idle timer cannot arm behind this one - a grid of covers left on screen
   * is a still picture the box would hold all night. The keys land in this
   * window, so the counting has to be here, on the delay the person chose for the
   * launcher.
   *
   * A running game is not a problem to guard against separately: the shell hides
   * this window for the whole of it, and a hidden window's time does not count.
   * It refuses the request anyway while a native program is on screen.
   */
  const ambient = useConfigStore((s) => s.config?.ambient);
  useEffect(() => {
    const minutes = ambient?.idleMinutes ?? 0;
    if (!ambient?.enabled || minutes <= 0) return;
    let last = Date.now();
    const bump = (): void => {
      last = Date.now();
    };
    window.addEventListener("keydown", bump, true);
    window.addEventListener("pointermove", bump, true);
    // A hidden renderer's timers are throttled to about one wake a minute and
    // frozen after a while, so the stamp cannot stay fresh while the screensaver
    // (or a game) is up: without this the first tick after coming back compares
    // against a minutes-old stamp and asks again seconds later.
    document.addEventListener("visibilitychange", bump);
    const id = setInterval(() => {
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
  }, [ambient?.enabled, ambient?.idleMinutes]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col relative">
        <div className="flex items-center justify-between gap-[1.5vw] px-[3vw] pt-[3vh] pb-[2vh]">
          <div>
            <div className="text-[3vh] font-semibold">{t("retroarch.title")}</div>
            <div className="text-[1.6vh] text-fg-dim">
              {t("retroarch.subtitle", {
                games: String(total),
                consoles: String(systems.filter((s) => s.games).length),
              })}
            </div>
          </div>
          <div className="flex gap-[0.8vw]">
            <Tab id="games" view={view} label={t("retroarch.tabGames")} active={view === "games"} onPick={setView} />
            <Tab
              id="consoles"
              view={view}
              label={t("retroarch.tabConsoles")}
              active={view === "consoles"}
              onPick={setView}
            />
            <Tab id="art" view={view} label={t("retroarch.tabArt")} active={view === "art"} onPick={setView} />
            <Tab id="scan" view={view} label={t("retroarch.tabScan")} active={view === "scan"} onPick={setView} />
            <Tab
              id="folders"
              view={view}
              label={t("retroarch.tabFolders")}
              active={view === "folders"}
              onPick={setView}
            />
            <Tab id="saves" view={view} label={t("retroarch.tabSaves")} active={view === "saves"} onPick={setView} />
          </div>
        </div>
        <div className="flex-1 min-h-0">
          {view === "games" ? (
            <GameGrid
              systems={rail}
              system={system}
              title={railTitle}
              marking={marking}
              onMarking={setMarking}
              games={games}
              loading={loading}
              error={error}
              onSystem={setSystem}
              onPlay={onPlay}
              onEmptyAction={() => {
                // No games at all: the way out is a scan, or an emulator if none is
                // installed yet - the scan screen says which, so start there.
                setView("scan");
                setTimeout(() => jump(SCAN_PAGE, TABS), 60);
              }}
            />
          ) : view === "consoles" ? (
            <Consoles systems={systems} onChanged={loadSystems} />
          ) : view === "scan" ? (
            <Scan onScanned={loadSystems} />
          ) : view === "folders" ? (
            <Folders />
          ) : view === "saves" ? (
            <Saves />
          ) : (
            <Artwork />
          )}
        </div>
        {starting && <Starting label={starting} />}
      </div>
    </FocusContext.Provider>
  );
}
