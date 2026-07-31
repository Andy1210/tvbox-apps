import { useCallback, useEffect, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, useFocusableItem } from "@sdk";
import { fetchGames, fetchSystems, play, type GameRow, type SystemRow } from "./api";
import { ART_PAGE, CONSOLES_PAGE, RAIL, TILES, jump } from "./focus";
import { GameGrid } from "./GameGrid";
import { Consoles } from "./Consoles";
import { Artwork } from "./Artwork";

type View = "games" | "consoles" | "art";
const LAST_SYSTEM = "tvbox.retroarch.system";
// Where "down out of the tabs" lands, per view: the first of these that is actually
// mounted. For the games view that is the covers, falling back to the console list
// when a console has none - NOT the page container, whose children are containers
// themselves, which is why the tabs used to be a one-way street.
const VIEW_CONTENT: Record<View, string[]> = {
  games: [TILES, RAIL],
  consoles: [CONSOLES_PAGE],
  art: [ART_PAGE],
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
  const [games, setGames] = useState<GameRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState("");

  const loadSystems = useCallback(() => {
    return fetchSystems()
      .then((d) => {
        setSystems(d.systems);
        // Whatever console was last looked at, if it is still there.
        setSystem((cur) => {
          if (cur && d.systems.some((s) => s.system === cur)) return cur;
          const saved = localStorage.getItem(LAST_SYSTEM) || "";
          const first = d.systems.find((s) => s.games > 0) || d.systems[0];
          return d.systems.some((s) => s.system === saved) ? saved : first ? first.system : "";
        });
      })
      .catch(() => setError(t("retroarch.stateError")));
  }, [t]);

  useEffect(() => {
    loadSystems();
  }, [loadSystems]);

  useEffect(() => {
    if (!system) {
      setGames([]);
      setLoading(false);
      return;
    }
    localStorage.setItem(LAST_SYSTEM, system);
    setLoading(true);
    let alive = true;
    fetchGames(system)
      .then((d) => {
        if (!alive) return;
        setGames(d.games);
        setError("");
      })
      .catch(() => alive && setError(t("retroarch.gamesError")))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [system, t]);

  // Back: out of a subview to the games, and from the games out of the app. The app
  // is left through the shell (window.tvbox.home()), which is also what the Home
  // button does - so there is exactly one way out and it always works.
  useBackspace(() => {
    if (view !== "games") {
      setView("games");
      setFocus("tab-games");
      return;
    }
    onExit();
  });

  const onPlay = (game: GameRow) => {
    setStarting(game.label);
    play(system, game.i)
      .then((r) => {
        if (r.ok) return; // the shell is taking the screen; this window is about to be hidden
        setStarting("");
        setError(
          r.error === "no_core"
            ? t("retroarch.noCoreFor", { system })
            : r.error === "rom_missing"
              ? t("retroarch.romMissing")
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
      if (document.visibilityState !== "visible") return;
      setStarting("");
      loadSystems();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadSystems]);

  const total = systems.reduce((n, s) => n + s.games, 0);

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
          </div>
        </div>
        <div className="flex-1 min-h-0">
          {view === "games" ? (
            <GameGrid
              systems={systems}
              system={system}
              games={games}
              loading={loading}
              error={error}
              onSystem={setSystem}
              onPlay={onPlay}
            />
          ) : view === "consoles" ? (
            <Consoles systems={systems} onChanged={loadSystems} />
          ) : (
            <Artwork />
          )}
        </div>
        {starting && <Starting label={starting} />}
      </div>
    </FocusContext.Provider>
  );
}
