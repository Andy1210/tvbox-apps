import { useEffect } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useFocusableItem } from "@sdk";
import { baseName, formatSize, isPlayable, isViewable, mediaKind, type Entry, type Listing } from "./api";
import { useFocusFallback } from "./focus";

// One folder. Folders first, then what this box can play - the shell lists
// everything a directory holds and the filtering happens here, because "what is a
// film" is this app's opinion and not the shell's.
//
// Files that are not playable are counted rather than listed: a folder of films
// usually also holds subtitles, artwork and an nfo, and a TV list of those is
// noise. An empty-looking folder that HAS such files says so, so nobody is left
// wondering where their file went.
//
// Photos are grouped the same way, for the opposite reason. A film's name is what
// identifies it, so a row per film is right; `20250920_163613.jpg` identifies
// nothing, and two hundred such rows are unreadable. So they get ONE row that
// opens a grid of the pictures themselves - which is the same "count it rather
// than list it" rule, applied where listing is the useless half.

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

function PhotosRow({ count, index, onOpen }: { count: number; index: number; onOpen: () => void }) {
  const { t } = useI18n();
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
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-[2.8vh] h-[2.8vh]">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="8.5" cy="10" r="1.5" />
        <path d="M4 16.5l4.5-4 3.5 3 3-2.5 4.5 4" strokeLinejoin="round" />
      </svg>
      <div className="min-w-0 flex-1 text-[2.1vh] font-medium truncate">{t("files.photos")}</div>
      <div className={["text-[1.6vh] shrink-0", focused ? "opacity-70" : "text-fg-dim"].join(" ")}>{count}</div>
    </div>
  );
}

export function Browser({
  listing,
  loading,
  photosSupported,
  onOpen,
  onPhotos,
}: {
  listing: Listing;
  loading: boolean;
  photosSupported: boolean;
  onOpen: (entry: Entry, playable: Entry[]) => void;
  onPhotos: (photos: Entry[]) => void;
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
  // A box whose shell predates the photo routes cannot render a tile, so it is
  // offered nothing: the photos fall into the "other files" count below, which is
  // what that count is for. An empty grid would be the alternative.
  const photos = photosSupported ? listing.entries.filter(isViewable) : [];
  // The photos row sits between the folders and the files, where the photos
  // themselves would have been. Its focus key continues the same run, so the
  // fallback below and every arrow press treat the list as one column.
  const folders = shown.filter((e) => e.dir);
  const files = shown.filter((e) => !e.dir);
  const rows = photos.length ? folders.length + files.length + 1 : folders.length + files.length;
  const hidden = listing.entries.length - shown.length - photos.length;

  useFocusFallback(rows ? "entry-0" : undefined, (k) => k.startsWith("entry-"));

  // Focus the first row of THIS folder. The keys are positional (`entry-0`), so
  // what re-runs this is the PATH in the dependencies: without it, walking into a
  // folder would leave the focus on the row that was pressed.
  useEffect(() => {
    if (!rows) return;
    const id = setTimeout(() => setFocus("entry-0"), 0);
    return () => clearTimeout(id);
  }, [listing.path, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col px-[4vw] py-[3vh]">
        <div className="text-[3vh] font-bold truncate">{listing.name}</div>
        <div className="text-[1.6vh] text-fg-dim mb-[2vh] truncate">{listing.path}</div>

        {/* The negative margin and the padding cancelling it give a focused row
            somewhere to grow into. `overflow-y-auto` makes this box clip on the
            OTHER axis too (a non-visible overflow on one axis computes the other
            to auto), so a row scaled to 1.01 has its rounded ends sliced flat
            against the edge. The pair moves the clip outwards, not the rows. */}
        <div className="flex-1 overflow-y-auto no-scrollbar flex flex-col gap-[0.9vh] -mx-[1vw] px-[1vw]">
          {folders.map((e, i) => (
            <EntryRow key={e.path} entry={e} index={i} onOpen={() => onOpen(e, playable)} />
          ))}
          {photos.length > 0 && (
            <PhotosRow count={photos.length} index={folders.length} onOpen={() => onPhotos(photos)} />
          )}
          {files.map((e, i) => (
            <EntryRow
              key={e.path}
              entry={e}
              index={folders.length + (photos.length ? 1 : 0) + i}
              onOpen={() => onOpen(e, playable)}
            />
          ))}
          {!rows && !loading && (
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
