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
  const { t } = useI18n();
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

  // Not every failure is the other box's. The known codes come from the shell's
  // own answer; anything else falls back to the general sentence.
  const reason = (code: string) => {
    const known = ["rclone_missing", "unknown_peer", "unknown_share", "busy", "pull_failed"];
    return t(known.includes(code) ? "retroarch.savesErr." + code : "retroarch.savesErr.failed");
  };

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
        const r = await window.tvbox?.shares?.pull(peer.id, s.id).catch(() => ({ ok: false, error: "failed" }));
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

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full overflow-y-auto no-scrollbar px-[3vw] pb-[3vh] flex flex-col gap-[1.2vh]">
        <div className="text-[1.7vh] text-fg-dim">{t("retroarch.savesIntro")}</div>
        {note && <div className="text-[1.7vh] text-[#ffb3b3]">{note}</div>}
        {done && <div className="text-[1.7vh] text-[#b6f0c0]">{done}</div>}

        <div className="text-[1.6vh] font-semibold text-fg-dim uppercase tracking-wide">
          {t("retroarch.savesFromBox")}
        </div>
        {/* A row rather than a sentence, even when there is nothing to list: a
            screen with no focusable element on it is a dead remote - Down out of
            the tabs lands on the empty page and the highlight disappears. */}
        {ready && !peers.length && (
          <Row
            focusKey="peer-none"
            title={t("retroarch.savesNoBoxes")}
            subtitle={t("retroarch.savesNoBoxesHint")}
            action={t("retroarch.savesRecheck")}
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
                  : t("retroarch.savesBringHint")
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
