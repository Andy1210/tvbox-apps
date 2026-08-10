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
type Sides = { here: number | null; there: number | null; arriving: number; olderThere: number };
// Per emulator, under the box it came from. The name is the folder the emulator
// keeps its saves in - RetroArch already writes one per core, so it is a name a
// person recognises ("Snes9x", "dolphin-emu") and the app needs no list of its own.
type Group = Sides & { name: string };
type Cmp = (Sides & { groups: Group[] }) | "checking" | "off";

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
    ms === null
      ? t("retroarch.savesNever")
      : new Intl.DateTimeFormat(tag, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(
          new Date(ms),
        );

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
    const latest = (a: number | null, b: number | null | undefined) =>
      typeof b === "number" ? (a === null ? b : Math.max(a, b)) : a;
    (async () => {
      for (const peer of peers) {
        let here: number | null = null;
        let there: number | null = null;
        let arriving = 0;
        let olderThere = 0;
        let answered = false;
        // An emulator's saves and its save states are two shares on the box and one
        // thing to a person, so the groups are summed across them by name.
        const byName = new Map<string, Group>();
        for (const s of shares) {
          if (!alive) return; // the screen is gone; stop asking the network for it
          const r = await bridge.compare?.(peer.id, s.id)?.catch(() => null);
          if (!r || !r.ok) continue;
          answered = true;
          here = latest(here, r.here?.newest);
          there = latest(there, r.there?.newest);
          // What a copy would actually move: newer over there, missing here, and
          // the same second but a different size - rclone checks size as well as
          // time, so that last one is copied too.
          arriving += (r.newerThere || 0) + (r.sameTimeDiffers || 0);
          olderThere += r.olderThere || 0;
          for (const g of r.groups || []) {
            const cur = byName.get(g.name) || { name: g.name, here: null, there: null, arriving: 0, olderThere: 0 };
            cur.here = latest(cur.here, g.here?.newest);
            cur.there = latest(cur.there, g.there?.newest);
            cur.arriving += (g.newerThere || 0) + (g.sameTimeDiffers || 0);
            cur.olderThere += g.olderThere || 0;
            byName.set(g.name, cur);
          }
        }
        // What there is to gain first, then what it would cost, then the rest by
        // name: the emulator someone came here for is the one with something to
        // bring, and on a TV it should not be third in an alphabetical list.
        const groups = [...byName.values()].sort(
          (x, y) => y.arriving - x.arriving || y.olderThere - x.olderThere || x.name.localeCompare(y.name),
        );
        if (!alive) return;
        // A box that did not answer gets no verdict rather than a wrong one - the
        // row still works, it just says nothing about dates.
        setCmp((cur) => ({ ...cur, [peer.id]: answered ? { here, there, arriving, olderThere, groups } : "off" }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [peers, shares]);

  // `group` names one emulator's folder; without it the whole share travels. Both
  // arm first, and they arm on their own key - pressing an emulator must not leave
  // the box row one press from copying everything.
  const bring = (peer: Peer, group?: string) => {
    const key = peer.id + (group ? "/" + group : "");
    if (arm !== key) {
      setArm(key);
      return;
    }
    setArm("");
    setNote("");
    setDone("");
    // Nothing declared means nothing to ask for. Without this the loop below runs
    // zero times and reports a success for a copy that never happened.
    if (!shares.length) return setNote(t("retroarch.savesNothing"));
    setBusy(key);
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
        const r = await window.tvbox?.shares?.pull(peer.id, s.id, group)?.catch(() => ({ ok: false, error: "failed" }));
        // An emulator with saves but no states (or the other way round) is
        // ordinary, and the box says unknown_group. Not a failure worth putting on
        // the screen - the half that exists still arrived.
        if (r && !r.ok && group && r.error === "unknown_group") continue;
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
      else setDone(t("retroarch.savesBrought", { box: group ? group + " · " + peer.name : peer.name }));
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
  const sides = (c: Sides) => {
    const parts = [t("retroarch.savesDates", { there: when(c.there), here: when(c.here) })];
    // Both halves when both apply: files newer in each room is the normal state
    // after two people played, and hearing only the warning hides what there is to
    // gain - hearing only the gain hides what it costs.
    if (c.arriving) parts.push(t("retroarch.savesArriving", { n: String(c.arriving) }));
    if (c.olderThere) parts.push(t("retroarch.savesWouldReplace", { n: String(c.olderThere) }));
    if (!c.arriving && !c.olderThere) parts.push(t("retroarch.savesSame"));
    return parts.join(" · ");
  };

  const verdict = (peer: Peer) => {
    const c = cmp[peer.id];
    if (!c) return t("retroarch.savesBringHint");
    if (c === "checking") return t("retroarch.savesChecking");
    if (c === "off") return t("retroarch.savesBringHint");
    return sides(c);
  };

  // The emulators under a box, once its answer is in.
  const groupsOf = (peer: Peer): Group[] => {
    const c = cmp[peer.id];
    return c && c !== "checking" && c !== "off" ? c.groups : [];
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
          <div key={p.id} className="flex flex-col gap-[0.6vh]">
            <Row
              focusKey={"peer-" + p.id}
              title={p.name}
              subtitle={
                busy === p.id
                  ? t("retroarch.savesBringing")
                  : arm === p.id
                    ? t("retroarch.savesReplaceWarn")
                    : verdict(p)
              }
              action={busy === p.id ? "…" : arm === p.id ? t("retroarch.savesBringSure") : t("retroarch.savesBringAll")}
              onEnter={() => !busy && bring(p)}
            />
            {/* One emulator at a time, for the case the box-level line cannot
                answer: the SNES played in one room and the GameCube in the other,
                where each box is "newer" and neither date helps. */}
            {groupsOf(p).map((g) => {
              const key = p.id + "/" + g.name;
              return (
                <div key={key} className="pl-[2vw]">
                  <Row
                    focusKey={"group-" + key}
                    title={g.name}
                    subtitle={
                      busy === key
                        ? t("retroarch.savesBringing")
                        : arm === key
                          ? t("retroarch.savesReplaceWarn")
                          : sides(g)
                    }
                    action={
                      busy === key ? "…" : arm === key ? t("retroarch.savesBringSure") : t("retroarch.savesBring")
                    }
                    onEnter={() => !busy && bring(p, g.name)}
                  />
                </div>
              );
            })}
          </div>
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
