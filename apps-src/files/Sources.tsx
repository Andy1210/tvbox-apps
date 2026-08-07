import { useEffect } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useFocusableItem } from "@sdk";
import { formatSize, type Source } from "./api";
import { useFocusFallback } from "./focus";

// Where to look: the box's own folders and whatever is plugged into a USB port.
//
// A stick appears here the moment it is plugged in, not when it is mounted -
// nothing on this box auto-mounts, so opening one IS the mount. That is why a
// removable row can be busy, and why it carries a second button (eject) once it
// is mounted: pulling a stick out mid-write is the one thing a TV cannot undo.

function FolderIcon({ kind }: { kind: Source["kind"] }) {
  if (kind === "removable")
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-[3vh] h-[3vh] shrink-0">
        <rect x="8" y="9" width="8" height="12" rx="1.5" />
        <path d="M10 9V4.5h4V9M12 12.5v4" strokeLinecap="round" />
      </svg>
    );
  if (kind === "network")
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-[3vh] h-[3vh] shrink-0">
        <rect x="3" y="5" width="18" height="7" rx="1.5" />
        <path d="M7 8.5h.01M12 16v3M7 19h10" strokeLinecap="round" />
        <path d="M6 16h12" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-[3vh] h-[3vh] shrink-0">
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  );
}

function EjectIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-[2.4vh] h-[2.4vh]">
      <path d="M12 5l7 9H5z" strokeLinejoin="round" />
      <path d="M5 19h14" strokeLinecap="round" />
    </svg>
  );
}

function SourceRow({
  source,
  busy,
  onOpen,
  onEject,
}: {
  source: Source;
  busy: boolean;
  onOpen: () => void;
  onEject: () => void;
}) {
  const { t } = useI18n();
  const { ref, focused } = useFocusableItem(
    { focusKey: "src-" + source.id, onEnterPress: onOpen },
    { block: "center" },
  );
  const eject = useFocusableItem<HTMLButtonElement>({ focusKey: "eject-" + source.id, onEnterPress: onEject });
  const detail =
    source.kind === "removable"
      ? [source.mounted ? t("files.mounted") : t("files.pluggedIn"), formatSize(source.size || 0), source.fstype]
          .filter(Boolean)
          .join(" · ")
      : source.kind === "network"
        ? t("files.networkShare")
        : source.path || "";

  return (
    <div className="flex items-stretch gap-[0.8vw]">
      <div
        ref={ref}
        onClick={onOpen}
        className={[
          "flex-1 min-w-0 flex items-center gap-[1.2vw] px-[1.6vw] py-[1.6vh] rounded-[1.2vh] transition-transform duration-150",
          focused ? "bg-white text-[#06090d] scale-[1.01]" : "bg-white/5",
        ].join(" ")}
      >
        <FolderIcon kind={source.kind} />
        <div className="min-w-0 flex-1">
          <div className="text-[2.3vh] font-semibold truncate">{source.name}</div>
          <div className={["text-[1.6vh] truncate", focused ? "opacity-70" : "text-fg-dim"].join(" ")}>
            {busy ? t("files.opening") : detail}
          </div>
        </div>
      </div>
      {source.kind === "removable" && source.mounted && (
        <button
          ref={eject.ref}
          onClick={onEject}
          aria-label={t("files.eject")}
          className={[
            "px-[1.4vw] rounded-[1.2vh] flex items-center gap-[0.6vw] text-[1.7vh] font-semibold transition-transform duration-150",
            eject.focused ? "bg-white text-[#06090d] scale-[1.03]" : "bg-white/5",
          ].join(" ")}
        >
          <EjectIcon />
          <span>{t("files.eject")}</span>
        </button>
      )}
    </div>
  );
}

export function Sources({
  sources,
  removable,
  loading,
  busyId,
  note,
  onOpen,
  onEject,
}: {
  sources: Source[];
  removable: { supported: boolean; error: string | null };
  loading: boolean;
  busyId: string;
  note: string;
  onOpen: (s: Source) => void;
  onEject: (s: Source) => void;
}) {
  const { t } = useI18n();
  // Grouping container, not a target: a focusable one is a full-screen rectangle
  // above the first row, so Up from the top row lands on it - nothing highlights,
  // and the D-pad then measures from a rect covering the screen, with no way back.
  // The launcher's own pages are `focusable: false` for the same reason; the
  // boundary is because there is nothing outside this screen to reach.
  const { ref, focusKey } = useFocusable({
    focusKey: "sources-page",
    focusable: false,
    isFocusBoundary: true,
    saveLastFocusedChild: true,
  });

  // Focus the first source once there is one. The list can arrive after a poll
  // (a stick plugged in while this screen is open), so this waits for content
  // rather than running on mount.
  const first = sources[0]?.id;
  useFocusFallback(first ? "src-" + first : undefined);
  useEffect(() => {
    if (!first) return;
    const id = setTimeout(() => setFocus("src-" + first), 0);
    return () => clearTimeout(id);
  }, [first]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col px-[4vw] py-[3vh]">
        <div className="text-[3.4vh] font-bold mb-[0.6vh]">{t("files.title")}</div>
        <div className="text-[1.8vh] text-fg-dim mb-[2.5vh]">{t("files.subtitle")}</div>

        <div className="flex-1 overflow-y-auto no-scrollbar flex flex-col gap-[1.2vh] pr-[0.5vw]">
          {sources.map((s) => (
            <SourceRow
              key={s.id}
              source={s}
              busy={busyId === s.id}
              onOpen={() => onOpen(s)}
              onEject={() => onEject(s)}
            />
          ))}
          {!sources.length && !loading && <div className="text-[2vh] text-fg-dim">{t("files.noSources")}</div>}
        </div>

        {note && <div className="text-[1.8vh] mt-[2vh] text-[#ffb3b3]">{note}</div>}
        {removable.error && <div className="text-[1.6vh] mt-[1.5vh] text-fg-dim">{t("files.errFailed")}</div>}
        {!removable.supported && (
          // A box provisioned before this feature has no udisks2, and OTA can
          // never add it - saying so is the difference between "no stick found"
          // and "this box cannot read sticks yet".
          <div className="text-[1.6vh] mt-[1.5vh] text-fg-dim">{t("files.usbUnavailable")}</div>
        )}
      </div>
    </FocusContext.Provider>
  );
}
