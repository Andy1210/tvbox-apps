import { useEffect } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useFocusableItem } from "@sdk";
import { baseName, formatSize, isPlayable, mediaKind, type Entry, type Listing } from "./api";
import { useFocusFallback } from "./focus";

// One folder. Folders first, then what this box can play - the shell lists
// everything a directory holds and the filtering happens here, because "what is a
// film" is this app's opinion and not the shell's.
//
// Files that are not playable are counted rather than listed: a folder of films
// usually also holds subtitles, artwork and an nfo, and a TV list of those is
// noise. An empty-looking folder that HAS such files says so, so nobody is left
// wondering where their file went.

function EntryIcon({ entry }: { entry: Entry }) {
  const cls = "w-[2.8vh] h-[2.8vh] shrink-0";
  if (entry.dir)
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={cls}>
        <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5z" />
      </svg>
    );
  if (mediaKind(entry.name) === "audio")
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={cls}>
        <path d="M9 18V6l10-2v12" strokeLinejoin="round" />
        <circle cx="6.5" cy="18" r="2.5" />
        <circle cx="16.5" cy="16" r="2.5" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={cls}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M10 9.5v5l4.5-2.5z" strokeLinejoin="round" />
    </svg>
  );
}

function EntryRow({ entry, index, onOpen }: { entry: Entry; index: number; onOpen: () => void }) {
  const { ref, focused } = useFocusableItem({ focusKey: "entry-" + index, onEnterPress: onOpen }, { block: "center" });
  return (
    <div
      ref={ref}
      onClick={onOpen}
      className={[
        "flex items-center gap-[1.2vw] px-[1.6vw] py-[1.3vh] rounded-[1.2vh] transition-transform duration-150",
        focused ? "bg-white text-[#06090d] scale-[1.01]" : "bg-white/5",
      ].join(" ")}
    >
      <EntryIcon entry={entry} />
      <div className="min-w-0 flex-1 text-[2.1vh] font-medium truncate">
        {entry.dir ? entry.name : baseName(entry.name)}
      </div>
      {!entry.dir && (
        <div className={["text-[1.6vh] shrink-0", focused ? "opacity-70" : "text-fg-dim"].join(" ")}>
          {formatSize(entry.size)}
        </div>
      )}
    </div>
  );
}

export function Browser({
  listing,
  loading,
  onOpen,
}: {
  listing: Listing;
  loading: boolean;
  onOpen: (entry: Entry, playable: Entry[]) => void;
}) {
  const { t } = useI18n();
  // The page GROUPS its rows, it is not a target itself. A focusable container is
  // a full-screen rectangle sitting above the first row, so Up from the top row
  // lands ON it: nothing highlights, and every arrow after that measures from a
  // rect that covers the screen - the cursor is gone with no way back, which on a
  // TV is a dead end. The launcher's own pages are `focusable: false` for exactly
  // this reason. The boundary is the other half: there is nothing outside this
  // screen to reach.
  const { ref, focusKey } = useFocusable({
    focusKey: "browser-page",
    focusable: false,
    isFocusBoundary: true,
    saveLastFocusedChild: true,
  });

  const shown = listing.entries.filter((e) => e.dir || isPlayable(e));
  const playable = shown.filter(isPlayable);
  const hidden = listing.entries.length - shown.length;

  useFocusFallback(shown.length ? "entry-0" : undefined);

  // Focus the first row of THIS folder: the key includes the path, so walking
  // into a folder re-runs it and focus never stays on the row that was pressed.
  useEffect(() => {
    if (!shown.length) return;
    const id = setTimeout(() => setFocus("entry-0"), 0);
    return () => clearTimeout(id);
  }, [listing.path, shown.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col px-[4vw] py-[3vh]">
        <div className="text-[3vh] font-bold truncate">{listing.name}</div>
        <div className="text-[1.6vh] text-fg-dim mb-[2vh] truncate">{listing.path}</div>

        <div className="flex-1 overflow-y-auto no-scrollbar flex flex-col gap-[0.9vh] pr-[0.5vw]">
          {shown.map((e, i) => (
            <EntryRow key={e.path} entry={e} index={i} onOpen={() => onOpen(e, playable)} />
          ))}
          {!shown.length && !loading && (
            <div className="text-[2vh] text-fg-dim">
              {hidden > 0 ? t("files.onlyOtherFiles", { n: hidden }) : t("files.emptyFolder")}
            </div>
          )}
        </div>

        {listing.truncated && <div className="text-[1.6vh] text-fg-dim mt-[1.5vh]">{t("files.tooManyFiles")}</div>}
      </div>
    </FocusContext.Provider>
  );
}
