import { useEffect, type ReactNode } from "react";
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

// A group heading, in the launcher's own idiom (its "Futó appok" / "Alkalmazások"
// rows). Deliberately not focusable and not a row: the D-pad walks sources, and a
// label it could land on would be a stop with nothing to press.
function GroupLabel({ children, first }: { children: ReactNode; first?: boolean }) {
  return (
    <div className={["text-[1.6vh] font-semibold text-fg-dim px-[0.4vw]", first ? "" : "mt-[2vh]"].join(" ")}>
      {children}
    </div>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-[3vh] h-[3vh] shrink-0">
      <rect x="7" y="2.5" width="10" height="19" rx="2" />
      <path d="M11 18.5h2" strokeLinecap="round" />
    </svg>
  );
}

// Photos from a phone. Not a source in the shell's sense - there is no folder
// behind it and nothing to mount - but this is the screen someone is on when they
// want their holiday on the TV, and a feature nobody can find is a feature nobody
// has. It belongs to the top group with the stick and the share: all three are
// somewhere other than this box.
function PhoneRow({ count, onOpen }: { count: number; onOpen: () => void }) {
  const { t } = useI18n();
  const { ref, focused } = useFocusableItem({ focusKey: "src-phone", onEnterPress: onOpen }, { block: "center" });
  return (
    <div
      ref={ref}
      onClick={onOpen}
      className={[
        "flex items-center gap-[1.2vw] px-[1.6vw] py-[1.6vh] rounded-[1.2vh] transition-transform duration-150",
        focused ? "bg-white text-[#06090d] scale-[1.01]" : "bg-white/5",
      ].join(" ")}
    >
      <PhoneIcon />
      <div className="min-w-0 flex-1">
        <div className="text-[2.3vh] font-semibold truncate">{t("files.fromPhone")}</div>
        <div className={["text-[1.6vh] truncate", focused ? "opacity-70" : "text-fg-dim"].join(" ")}>
          {count ? t("files.phoneArrived", { n: count }) : t("files.fromPhoneHint")}
        </div>
      </div>
    </div>
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
  // The button is only RENDERED for a mounted stick, but the hook has to run
  // either way (hooks cannot be conditional) - and a registered focusable whose
  // ref never reached a DOM node is a 0x0 rectangle at the top left of the
  // screen. That is a real target for the D-pad: Up from the first row landed on
  // it, nothing highlighted, and the cursor was gone. `focusable` is what keeps a
  // hook that must run out of the navigation tree.
  const showEject = source.kind === "removable" && source.mounted;
  const eject = useFocusableItem<HTMLButtonElement>({
    focusKey: "eject-" + source.id,
    focusable: showEject,
    onEnterPress: onEject,
  });
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
      {showEject && (
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
  castCount,
  photosSupported,
  onOpen,
  onEject,
  onPhone,
}: {
  sources: Source[];
  removable: { supported: boolean; error: string | null };
  loading: boolean;
  busyId: string;
  note: string;
  castCount: number;
  photosSupported: boolean;
  onOpen: (s: Source) => void;
  onEject: (s: Source) => void;
  onPhone: () => void;
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
  // Two groups, because they are two different questions. A stick, a NAS share and
  // a phone are somewhere ELSE and are what someone came here to reach; the box's
  // own folders are a long, mostly uninteresting list that a home directory
  // decides the length of. Sorted together they read as one list in which the
  // interesting rows happen to sit at position nine.
  const elsewhere = sources.filter((s) => s.kind !== "folder");
  const own = sources.filter((s) => s.kind === "folder");

  // The phone row means this screen has somewhere to put the cursor even on a box
  // with no folders and nothing plugged in - unless the shell is too old to have
  // it, which is the one case that can still leave nothing to focus.
  const firstOf = (list: Source[]) => (list[0] ? "src-" + list[0].id : undefined);
  const first = firstOf(elsewhere) || (photosSupported ? "src-phone" : firstOf(own));
  useFocusFallback(first, (k) => k.startsWith("src-") || k.startsWith("eject-"));
  useEffect(() => {
    if (!first) return;
    const id = setTimeout(() => setFocus(first), 0);
    return () => clearTimeout(id);
  }, [first]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col px-[4vw] py-[3vh]">
        <div className="text-[3.4vh] font-bold mb-[0.6vh]">{t("files.title")}</div>
        <div className="text-[1.8vh] text-fg-dim mb-[2.5vh]">{t("files.subtitle")}</div>

        {/* Room for a focused row to grow into - see the same pair in Browser.tsx:
            this box clips horizontally as well as vertically, so without it a
            scaled row loses its rounded ends against the edge. */}
        <div className="flex-1 overflow-y-auto no-scrollbar flex flex-col gap-[1.2vh] -mx-[1vw] px-[1vw]">
          {(elsewhere.length > 0 || photosSupported) && <GroupLabel first>{t("files.srcElsewhere")}</GroupLabel>}
          {elsewhere.map((s) => (
            <SourceRow
              key={s.id}
              source={s}
              busy={busyId === s.id}
              onOpen={() => onOpen(s)}
              onEject={() => onEject(s)}
            />
          ))}
          {photosSupported && <PhoneRow count={castCount} onOpen={onPhone} />}

          {own.length > 0 && <GroupLabel>{t("files.srcOnBox")}</GroupLabel>}
          {own.map((s) => (
            <SourceRow
              key={s.id}
              source={s}
              busy={busyId === s.id}
              onOpen={() => onOpen(s)}
              onEject={() => onEject(s)}
            />
          ))}
          {!sources.length && !loading && !photosSupported && (
            <div className="text-[2vh] text-fg-dim">{t("files.noSources")}</div>
          )}
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
