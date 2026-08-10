import { useCallback, useEffect, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useFocusableItem } from "@sdk";
import { SAVES_PAGE } from "./focus";

// Carry on in another room. Two boxes, two TVs, one save file - the box brings a
// copy of this app's save folders across from the box that has the newer one.
//
// The box owns the mechanism and the permission: which folders MAY be offered is
// this app's manifest (`shares`), whether they ARE is a switch in Settings, and the
// boxes trust each other by pairing there. What the box does not own is the
// sentence - "continue the game in the other room" is an emulator's sentence, and a
// TV with no emulator on it should never see it. So the action lives here, behind
// the `shares` capability, and this screen is the only place that talks about saves.
//
// It brings, never sends. A pull is the room you are standing in asking for a copy;
// a push would be one room deciding for another, and with two people playing the
// same game in two rooms that is somebody's afternoon overwritten. It follows that
// this is a manual button and not a sync: the box cannot know which side is the one
// you meant to keep, and the file's timestamps do not say either - an emulator
// rewrites a save on exit whether or not anything happened.

type Peer = { id: string; name: string };
type Share = { id: string; name: string; present: boolean; on: boolean };
// What a pull would do, summed over this app's folders: when each side was last
// written, how much would arrive, and how much would be replaced by an older copy.
type Cmp = { here: number | null; there: number | null; newerThere: number; olderThere: number } | "checking" | "off";

function Row({
  title,
  subtitle,
  action,
  focusKey,
  onEnter,
}: {
  title: string;
  subtitle: string;
  action?: string;
  focusKey: string;
  onEnter: () => void;
}) {
  const { ref, focused } = useFocusableItem({ focusKey, onEnterPress: onEnter }, { block: "nearest" });
  return (
    <div
      ref={ref}
      onClick={onEnter}
      className={[
        "px-[1.4vw] py-[1.2vh] rounded-[1vh] flex items-center justify-between gap-[1vw]",
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

export function Saves() {
  const { t, tag } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: SAVES_PAGE, focusable: false, saveLastFocusedChild: true });
  const [peers, setPeers] = useState<Peer[]>([]);
  const [shares, setShares] = useState<Share[]>([]);
  const [ready, setReady] = useState<boolean | null>(null); // null = still asking
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [done, setDone] = useState("");
  // Bringing a save replaces the one here, so it asks first - the same one-press
  // arming a linked folder's removal uses.
  const [arm, setArm] = useState("");
  const [cmp, setCmp] = useState<Record<string, Cmp>>({});

  // Not every failure is the other box's. The known codes come from the shell's
  // own answer; anything else falls back to the general sentence.
  const reason = (code: string) => {
    const known = ["rclone_missing", "unknown_peer", "unknown_share", "busy", "pull_failed"];
    return t(known.includes(code) ? "retroarch.savesErr." + code : "retroarch.savesErr.failed");
  };

  // When a side was last written, in the box's own language. A date rather than
  // "2 hours ago": the person is matching it against an evening they remember.
  const when = (ms: number | null) =>
    ms
      ? new Intl.DateTimeFormat(tag, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(
          new Date(ms),
        )
      : t("retroarch.savesNever");

  const load = useCallback(() => {
    const bridge = window.tvbox?.shares;
    if (!bridge) return setReady(false);
    bridge
      .list()
      .then((r) => {
        setReady(!!r.ok);
        setPeers(r.peers || []);
        setShares(r.shares || []);
      })
      .catch(() => setReady(false));
  }, []);
  useEffect(load, [load]);

  // Ask the box what a pull would actually do, once the two lists are in. Each
  // answer costs a listing over the network, so it happens on opening the screen
  // and after a pull - not on every render.
  useEffect(() => {
    const bridge = window.tvbox?.shares;
    if (!bridge?.compare || !peers.length || !shares.length) return;
    let alive = true;
    setCmp(Object.fromEntries(peers.map((p) => [p.id, "checking" as Cmp])));
    (async () => {
      for (const peer of peers) {
        let here: number | null = null;
        let there: number | null = null;
        let newerThere = 0;
        let olderThere = 0;
        let answered = false;
        for (const s of shares) {
          const r = await bridge.compare?.(peer.id, s.id)?.catch(() => null);
          if (!r || !r.ok) continue;
          answered = true;
          here = Math.max(here || 0, r.here?.newest || 0) || null;
          there = Math.max(there || 0, r.there?.newest || 0) || null;
          newerThere += r.newerThere || 0;
          olderThere += r.olderThere || 0;
        }
        if (!alive) return;
        // A box that did not answer gets no verdict rather than a wrong one - the
        // row still works, it just says nothing about dates.
        setCmp((cur) => ({ ...cur, [peer.id]: answered ? { here, there, newerThere, olderThere } : "off" }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [peers, shares]);

  const bring = (peer: Peer) => {
    if (arm !== peer.id) {
      setArm(peer.id);
      return;
    }
    setArm("");
    setNote("");
    setDone("");
    // Nothing declared means nothing to ask for. Without this the loop below runs
    // zero times and reports a success for a copy that never happened.
    if (!shares.length) return setNote(t("retroarch.savesNothing"));
    setBusy(peer.id);
    // Every folder this app declares, one after another: saves and save states are
    // one thing to a person, and asking twice for one game would be theatre.
    // Sequential rather than parallel - two rclone copies over one wifi link finish
    // no sooner, and a failure in the middle is easier to report about one folder.
    (async () => {
      const failed: string[] = [];
      let why = "";
      for (const s of shares) {
        // Every hop optional: with no bridge, pull() is never called and `.catch`
        // on the undefined it left behind would throw inside the loop.
        const r = await window.tvbox?.shares?.pull(peer.id, s.id)?.catch(() => ({ ok: false, error: "failed" }));
        if (!r || !r.ok) {
          failed.push(s.name);
          why = why || (r && r.error) || "failed";
        }
      }
      setBusy("");
      // The box says WHY, and the reasons are not interchangeable: a missing rclone
      // or a folder that could not be created are problems on this box, and sending
      // someone to check the other TV for them wastes their afternoon.
      if (failed.length) setNote(t("retroarch.savesFailed", { names: failed.join(", ") }) + " " + reason(why));
      else setDone(t("retroarch.savesBrought", { box: peer.name }));
      load();
    })();
  };

  // The capability is missing: either the box's software predates it, or this app
  // was installed from a package that does not ask for it. Nothing here can fix
  // that, so it says so rather than showing buttons that would do nothing.
  if (ready === false)
    return (
      <div className="h-full px-[3vw] pb-[3vh] flex flex-col gap-[1.2vh]">
        <div className="text-[1.9vh]">{t("retroarch.savesUnsupported")}</div>
      </div>
    );

  const offered = shares.filter((s) => s.on).map((s) => s.name);

  // One line under the box's name: when each side was last written, which is
  // ahead, and - the part that decides whether to press - how much of what is here
  // would be replaced by something older. rclone copies whatever differs in the
  // direction asked for; it does not prefer the newer file.
  const verdict = (peer: Peer) => {
    const c = cmp[peer.id];
    if (!c) return t("retroarch.savesBringHint");
    if (c === "checking") return t("retroarch.savesChecking");
    if (c === "off") return t("retroarch.savesBringHint");
    const dates = t("retroarch.savesDates", { there: when(c.there), here: when(c.here) });
    if (c.olderThere) return dates + " · " + t("retroarch.savesWouldReplace", { n: String(c.olderThere) });
    if (c.newerThere) return dates + " · " + t("retroarch.savesNewerThere", { n: String(c.newerThere) });
    return dates + " · " + t("retroarch.savesSame");
  };

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full overflow-y-auto no-scrollbar px-[3vw] pb-[3vh] flex flex-col gap-[1.2vh]">
        <div className="text-[1.7vh] text-fg-dim">{t("retroarch.savesIntro")}</div>
        {note && <div className="text-[1.7vh] text-[#ffb3b3]">{note}</div>}
        {done && <div className="text-[1.7vh] text-[#b6f0c0]">{done}</div>}

        <div className="text-[1.6vh] font-semibold text-fg-dim uppercase tracking-wide">
          {t("retroarch.savesFromBox")}
        </div>
        {/* A row rather than a sentence, even when there is nothing to list, and
            from the first render rather than once the answer is in: a screen with
            no focusable element on it is a dead remote - Down out of the tabs lands
            on the empty page and the highlight disappears. */}
        {!peers.length && (
          <Row
            focusKey="peer-none"
            title={ready === null ? t("retroarch.loading") : t("retroarch.savesNoBoxes")}
            subtitle={ready === null ? "" : t("retroarch.savesNoBoxesHint")}
            action={ready === null ? "" : t("retroarch.savesRecheck")}
            onEnter={load}
          />
        )}
        {peers.map((p) => (
          <Row
            key={p.id}
            focusKey={"peer-" + p.id}
            title={p.name}
            subtitle={
              busy === p.id
                ? t("retroarch.savesBringing")
                : arm === p.id
                  ? t("retroarch.savesReplaceWarn")
                  : verdict(p)
            }
            action={busy === p.id ? "…" : arm === p.id ? t("retroarch.savesBringSure") : t("retroarch.savesBring")}
            onEnter={() => !busy && bring(p)}
          />
        ))}

        {/* What this box gives back. Not a control - the switch is Settings' - but
            without it a one-way pairing looks like a broken one from here. */}
        <div className="text-[1.6vh] font-semibold text-fg-dim uppercase tracking-wide mt-[1vh]">
          {t("retroarch.savesOffered")}
        </div>
        <div className="text-[1.7vh] text-fg-dim">
          {offered.length ? t("retroarch.savesOfferedOn", { names: offered.join(", ") }) : t("retroarch.savesOfferedOff")}
        </div>
      </div>
    </FocusContext.Provider>
  );
}
