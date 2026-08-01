import { useCallback, useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useFocusableItem } from "@sdk";
import {
  fetchScan,
  fetchScanFolders,
  inspectFolder,
  shortSystem,
  startScan,
  stopScan,
  type ScanFolder,
  type ScanInspect,
  type ScanState,
} from "./api";
import { SCAN_PAGE } from "./focus";

// Finding games. A console only exists here once something has read a folder and
// written a playlist - installing an emulator does not do that, and neither does
// anything else on the box, which is why a screen for it had to exist at all.
//
// The list is folders, not consoles: that is how a game library is actually laid out
// (and how the network share arrives), and it is the one thing the box cannot work out
// for itself. What IS worked out is the console - from the file types in the folder and
// what the installed emulators claim - and shown before anything runs, so a scan is
// never a surprise.
const POLL_MS = 1200;

function Row({
  title,
  subtitle,
  action,
  focusKey,
  onEnter,
  onFocus,
  indent,
}: {
  title: string;
  subtitle: string;
  action?: string;
  focusKey: string;
  onEnter: () => void;
  onFocus?: () => void;
  indent?: boolean;
}) {
  const { ref, focused } = useFocusableItem({ focusKey, onEnterPress: onEnter, onFocus }, { block: "nearest" });
  return (
    <div
      ref={ref}
      onClick={onEnter}
      className={[
        "px-[1.4vw] py-[1.2vh] rounded-[1vh] flex items-center justify-between gap-[1vw]",
        indent ? "ml-[2vw]" : "",
        focused ? "bg-white text-[#06090d]" : "bg-white/5",
      ].join(" ")}
    >
      <div className="min-w-0">
        <div className="text-[1.9vh] font-semibold truncate">{title}</div>
        <div className={["text-[1.4vh] truncate", focused ? "opacity-70" : "text-fg-dim"].join(" ")}>{subtitle}</div>
      </div>
      {action && <div className="text-[1.6vh] font-semibold shrink-0">{action}</div>}
    </div>
  );
}

export function Scan({ onScanned }: { onScanned: () => void }) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: SCAN_PAGE });
  const [folders, setFolders] = useState<ScanFolder[]>([]);
  // Every console the installed emulators can file a game under. NOT the consoles that
  // already have games: on a first scan that is the empty set, which is the one moment
  // this choice is needed most.
  const [consoles, setConsoles] = useState<string[]>([]);
  const [picked, setPicked] = useState<string>(""); // the folder the cursor is on
  const [look, setLook] = useState<ScanInspect | null>(null);
  const [state, setState] = useState<ScanState | null>(null);
  const [error, setError] = useState("");
  // Which console to file the games under when the file types cannot say - the same
  // question RetroArch's own manual scan asks. Empty = let the file types decide.
  const [forced, setForced] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchScanFolders()
      .then((d) => {
        setFolders(d.folders);
        setConsoles(d.consoles || []);
      })
      .catch(() => setError(t("retroarch.scanFoldersError")));
  }, [t]);

  // The progress of a running scan. Polled, like the cover sweep: the plugin keeps it
  // in memory and a scan is minutes long.
  // "was it running last time" is kept in a ref, not read from state: the poll
  // SETS state, so depending on it would tear the interval down and build a new
  // one on every tick.
  const wasRunning = useRef(false);
  useEffect(() => {
    const load = () =>
      fetchScan()
        .then((d) => {
          setState(d);
          if (wasRunning.current && !d.running) onScanned(); // the lists changed: reread them
          wasRunning.current = d.running;
        })
        .catch(() => {});
    load();
    timer.current = setInterval(load, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [onScanned]);

  // What is in the folder under the cursor. The walk is the expensive part on a network
  // share, so it happens on focus rather than for every folder up front.
  // The answer is only used if the cursor is still on the folder that asked for
  // it: moving down a list faster than a network share can be walked would
  // otherwise let an earlier reply land last and describe the wrong folder.
  const wanted = useRef("");
  const inspect = useCallback(
    (folder: string) => {
      setPicked(folder);
      setLook(null);
      setForced("");
      setError(""); // last folder's failure is not this folder's
      wanted.current = folder;
      inspectFolder(folder)
        .then((d) => {
          if (wanted.current === folder) setLook(d);
        })
        .catch(() => {
          if (wanted.current === folder) setError(t("retroarch.scanInspectError"));
        });
    },
    [t],
  );

  const running = !!(state && state.running);
  const progress = state && state.progress;
  const last = state && state.last;

  const begin = (folder: string) => {
    setError("");
    startScan(folder, forced || null)
      .then((r) => {
        if (r.ok) return;
        setError(
          r.error === "playing"
            ? t("retroarch.scanBusyGame")
            : r.error === "busy"
              ? t("retroarch.scanBusy")
              : t("retroarch.scanFailed"),
        );
      })
      .catch(() => setError(t("retroarch.scanFailed")));
  };

  const choices = consoles;

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full overflow-y-auto no-scrollbar px-[3vw] pb-[3vh] flex flex-col gap-[1vh]">
        <div className="text-[1.6vh] text-fg-dim pb-[0.5vh]">{t("retroarch.scanHint")}</div>
        {error && <div className="text-[1.7vh] text-fg-dim">{error}</div>}

        {running ? (
          <div className="px-[1.4vw] py-[1.4vh] rounded-[1vh] bg-white/10">
            <div className="text-[1.9vh] font-semibold">
              {progress && progress.stage === "adding"
                ? t("retroarch.scanAdding")
                : t("retroarch.scanReading", { folder: progress ? baseName(progress.folder) : "" })}
            </div>
            <div className="text-[1.5vh] text-fg-dim pt-[0.4vh]">{t("retroarch.scanSlow")}</div>
            <StopButton onPress={() => stopScan().catch(() => {})} />
          </div>
        ) : last && !last.ok ? (
          // A scan can fail in the background, after the progress banner is gone.
          // Rendering only the ok case left the screen with nothing where the
          // answer should be, which reads as "it never ran".
          <div className="px-[1.4vw] py-[1.2vh] rounded-[1vh] bg-white/10 text-[1.7vh]">
            {t("retroarch.scanFailed")}
          </div>
        ) : (
          last &&
          last.ok && (
            <div className="px-[1.4vw] py-[1.2vh] rounded-[1vh] bg-white/10 text-[1.7vh]">
              {/* A stopped scan says so: nothing failed, but it did not finish,
                  so the counts are partial and calling it "done" would be a lie. */}
              {t(last.stopped ? "retroarch.scanStopped" : "retroarch.scanDone", {
                matched: String(last.matched || 0),
                added: String(last.added || 0),
              })}
              {last.skipped ? " · " + t("retroarch.scanSkipped", { n: String(last.skipped) }) : ""}
            </div>
          )
        )}

        <div className="text-[1.6vh] font-semibold text-fg-dim uppercase tracking-wide pt-[0.5vh]">
          {t("retroarch.scanFolders")}
        </div>
        {folders.map((f) => (
          <Row
            key={f.path}
            focusKey={"scan-" + f.path}
            indent={f.depth > 0}
            title={f.depth > 0 ? f.parent + " / " + f.name : f.name}
            subtitle={
              picked === f.path
                ? look
                  ? summary(look, t)
                  : t("retroarch.scanLooking")
                : f.folders.length
                  ? f.folders.slice(0, 6).join(" · ")
                  : t("retroarch.scanFolderPlain")
            }
            action={picked === f.path && !running ? t("retroarch.scanStart") : undefined}
            onFocus={() => picked !== f.path && inspect(f.path)}
            onEnter={() => !running && begin(f.path)}
          />
        ))}

        {picked && look && !look.error && look.ambiguous > 0 && (
          <>
            <div className="text-[1.6vh] font-semibold text-fg-dim uppercase tracking-wide pt-[1vh]">
              {t("retroarch.scanWhichConsole")}
            </div>
            <Row
              focusKey="scan-force"
              title={forced || t("retroarch.scanFromFiles")}
              subtitle={t("retroarch.scanForceHint", { n: String(look.ambiguous) })}
              action={t("retroarch.change")}
              onEnter={() => {
                // Cycle: file types decide -> each console an emulator claims -> back.
                const at = forced ? choices.indexOf(forced) : -1;
                setForced(at + 1 >= choices.length ? "" : choices[at + 1]);
              }}
            />
          </>
        )}
      </div>
    </FocusContext.Provider>
  );
}

function StopButton({ onPress }: { onPress: () => void }) {
  const { t } = useI18n();
  const { ref, focused } = useFocusableItem({ focusKey: "scan-stop", onEnterPress: onPress });
  return (
    <div
      ref={ref}
      onClick={onPress}
      className={[
        "mt-[1vh] inline-block px-[1.6vw] py-[0.9vh] rounded-[1vh] text-[1.7vh] font-semibold",
        focused ? "bg-white text-[#06090d]" : "bg-white/10",
      ].join(" ")}
    >
      {t("retroarch.scanStop")}
    </div>
  );
}

const baseName = (p: string | null | undefined) =>
  String(p || "")
    .split("/")
    .filter(Boolean)
    .pop() || "";

// One line about a folder: how many games, which consoles they would go to, and how
// many are already listed.
function summary(look: ScanInspect, t: (k: string, v?: Record<string, string>) => string): string {
  if (look.error) return t("retroarch.scanUnreadable");
  if (!look.games) return t("retroarch.scanEmpty");
  const consoles = look.systems.map((s) => shortSystem(s.system) + " (" + s.games + ")").join(", ");
  const parts = [t("retroarch.scanFound", { n: String(look.games) })];
  if (consoles) parts.push(consoles);
  if (look.already) parts.push(t("retroarch.scanAlready", { n: String(look.already) }));
  if (look.ambiguous) parts.push(t("retroarch.scanAmbiguous", { n: String(look.ambiguous) }));
  return parts.join(" · ");
}
