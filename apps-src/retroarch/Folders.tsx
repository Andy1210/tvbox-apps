import { useCallback, useEffect, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useFocusableItem, Osk } from "@sdk";
import {
  addFolder,
  fetchFolders,
  fetchSources,
  listFolder,
  removeFolder,
  type BrowseEntry,
  type BrowseSource,
  type LinkedFolder,
} from "./api";
import { FOLDERS_PAGE } from "./focus";
import { Phone } from "./Phone";

// Games that are already on this box but not in the library: a stick, a folder on
// a network share the box mounts, anything dropped in over the file server.
//
// Nothing is copied and nothing is mounted here. The box knows what it has
// mounted (the shell's own sources), this screen picks a folder out of that, and
// the app links it into the library under a name. The scanner follows symlinks,
// so a linked folder is scanned, played and given artwork like any other.
//
// The NAME is asked for rather than derived, because it is a path segment in
// every playlist entry RetroArch writes: it is chosen once and then kept, which
// is also why an existing name re-points instead of adding a second entry.

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

export function Folders() {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: FOLDERS_PAGE, focusable: false, saveLastFocusedChild: true });
  const [linked, setLinked] = useState<LinkedFolder[]>([]);
  const [max, setMax] = useState(12);
  const [sources, setSources] = useState<BrowseSource[] | null>(null);
  const [browsing, setBrowsing] = useState<{ path: string; name: string; parent: string | null } | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [naming, setNaming] = useState<string | null>(null); // the path being named
  const [note, setNote] = useState("");
  const [unsupported, setUnsupported] = useState(false);
  const [phone, setPhone] = useState(false);
  // Removing a link is one press away from adding one, so it arms first.
  const [arm, setArm] = useState("");

  const load = useCallback(() => {
    fetchFolders().then((d) => {
      setLinked(d.folders);
      setMax(d.max);
    });
  }, []);
  useEffect(load, [load]);

  // The box's own sources: its folders, every plugged-in stick, every mounted
  // share. A shell too old to answer says so instead of showing an empty picker.
  const openSources = useCallback(() => {
    setNote("");
    fetchSources().then((s) => {
      setUnsupported(!!s.unsupported);
      setSources(s.sources);
      setBrowsing(null);
      setTimeout(() => setFocus("src-0"), 0);
    });
  }, []);

  const open = useCallback((path: string, name: string) => {
    listFolder(path).then((l) => {
      if (!l.ok) return setNote(t("retroarch.folderUnreadable"));
      setBrowsing({ path: l.path, name: name || l.name, parent: l.parent });
      setEntries(l.entries.filter((e) => e.dir));
      setTimeout(() => setFocus("dir-use"), 0);
    });
    // `t` is stable enough here; the note is the only thing it feeds
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (name: string) => {
    const path = naming;
    setNaming(null);
    if (!path) return;
    addFolder(name.trim().toLowerCase(), path).then((r) => {
      if (!r.ok) return setNote(t("retroarch.folderErr." + (r.error || "failed")));
      setSources(null);
      setBrowsing(null);
      setNote("");
      load();
      setTimeout(() => setFocus("add"), 0);
    });
  };

  if (phone)
    return (
      <Phone
        kind="roms"
        title={t("retroarch.phoneUpload")}
        hint={t("retroarch.phoneUploadHint")}
        onClose={() => {
          setPhone(false);
          setTimeout(() => setFocus("upload"), 0);
        }}
      />
    );

  if (naming !== null)
    return (
      <Osk
        title={t("retroarch.folderName")}
        initial={(naming.split("/").pop() || "games").toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}
        onDone={save}
        onCancel={() => setNaming(null)}
      />
    );

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full overflow-y-auto no-scrollbar px-[3vw] pb-[3vh] flex flex-col gap-[1.2vh]">
        {note && <div className="text-[1.7vh] text-[#ffb3b3]">{note}</div>}

        {/* Picking: the box's sources, then the folders inside one. */}
        {sources && !browsing && (
          <>
            <div className="text-[1.6vh] font-semibold text-fg-dim uppercase tracking-wide">
              {t("retroarch.folderPickSource")}
            </div>
            {unsupported && <div className="text-[1.7vh] text-fg-dim">{t("retroarch.folderNoBrowse")}</div>}
            {sources.map((s, i) => (
              <Row
                key={s.id}
                focusKey={"src-" + i}
                title={s.name}
                subtitle={s.mounted ? s.path || "" : t("retroarch.folderNotMounted")}
                action={s.mounted ? t("retroarch.folderOpen") : undefined}
                onEnter={() => s.mounted && s.path && open(s.path, s.name)}
              />
            ))}
          </>
        )}

        {browsing && (
          <>
            <div className="text-[1.6vh] font-semibold text-fg-dim uppercase tracking-wide">{browsing.path}</div>
            <Row
              focusKey="dir-use"
              title={t("retroarch.folderUseThis")}
              subtitle={browsing.path}
              action={t("retroarch.folderAdd")}
              onEnter={() => setNaming(browsing.path)}
            />
            {browsing.parent && (
              <Row
                focusKey="dir-up"
                title={t("retroarch.folderUp")}
                subtitle=""
                onEnter={() => open(browsing.parent as string, "")}
              />
            )}
            {entries.map((e, i) => (
              <Row key={e.path} focusKey={"dir-" + i} title={e.name} subtitle="" onEnter={() => open(e.path, "")} />
            ))}
          </>
        )}

        {/* The library as it stands. */}
        {!sources && !browsing && (
          <>
            <div className="text-[1.6vh] font-semibold text-fg-dim uppercase tracking-wide">
              {t("retroarch.folderLinked", { n: linked.length })}
            </div>
            {!linked.length && <div className="text-[1.7vh] text-fg-dim">{t("retroarch.folderNone")}</div>}
            {linked.map((f) => (
              <Row
                key={f.name}
                focusKey={"linked-" + f.name}
                title={f.name}
                subtitle={f.present ? f.path : t("retroarch.folderMissing", { path: f.path })}
                action={arm === f.name ? t("retroarch.folderRemoveSure") : t("retroarch.folderRemove")}
                onEnter={() => {
                  if (arm !== f.name) return setArm(f.name);
                  setArm("");
                  removeFolder(f.name).then(load);
                }}
              />
            ))}
            {linked.length < max && (
              <Row
                focusKey="add"
                title={t("retroarch.folderAddTitle")}
                subtitle={t("retroarch.folderAddHint")}
                onEnter={openSources}
              />
            )}
            {/* The file picker is the one thing a remote cannot do, so it is the
                one thing that stays on the phone - opened from here rather than
                from a Settings menu nobody finds. */}
            <Row
              focusKey="upload"
              title={t("retroarch.phoneUpload")}
              subtitle={t("retroarch.phoneUploadHint")}
              onEnter={() => setPhone(true)}
            />
          </>
        )}
      </div>
    </FocusContext.Provider>
  );
}
