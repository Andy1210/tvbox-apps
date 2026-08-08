import { useEffect, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useFocusableItem } from "@sdk";
import type { Photo } from "./api";
import { useFocusFallback } from "./focus";

// The photos of one folder, as pictures rather than as filenames.
//
// A row list works for films because a film's name is what identifies it. A photo's
// does not - `20250920_163613.jpg` says nothing - so this screen shows the picture
// and no label at all, and the name only appears in the viewer where there is room
// for it.
//
// Like the RetroArch cover grid, only a WINDOW of rows is mounted: a holiday folder
// is hundreds of photos, and hundreds of <img> tiles is what makes a 4 GB box swap
// instead of scroll. The window is much larger than the shift so that the focused
// tile survives the move - if its key were unmounted, focus would fall to nothing
// and the D-pad would be dead.
const COLS = 5;
const WINDOW_ROWS = 8;
const SHIFT_ROWS = 3;
const EDGE_ROWS = 2; // shift once focus comes this close to the mounted edge
// A row is exactly this tall - 24vh of tile plus a 1.5vh gap - and the number is
// load-bearing rather than cosmetic: the spacers standing in for unmounted rows
// are computed from it, so the tile height and the vertical gap below must keep
// adding up to it.
//
// The tile is deliberately nearer square than a film's cover would be. A cell has
// to hold portrait and landscape photos side by side without either being cropped
// to a strip, and a phone folder is mostly portrait.
const ROW_VH = 25.5;

const KEY = (i: number) => "ph-" + i;

function Tile({
  photo,
  pos,
  onOpen,
  onFocusPos,
}: {
  photo: Photo;
  pos: number;
  onOpen: () => void;
  onFocusPos: (pos: number) => void;
}) {
  const { ref, focused } = useFocusableItem(
    { focusKey: KEY(pos), onEnterPress: onOpen, onFocus: () => onFocusPos(pos) },
    { block: "nearest" },
  );
  return (
    <div
      ref={ref}
      onClick={onOpen}
      className={[
        "h-[24vh] rounded-[1vh] overflow-hidden bg-white/5",
        "transition-[transform,outline-color] duration-150 outline outline-[3px] outline-transparent outline-offset-2",
        focused ? "scale-[1.06] outline-[var(--color-focus)] z-10" : "",
      ].join(" ")}
    >
      {/* Async decode, but not `loading="lazy"`: the window above is already the
          virtualization, and lazy would wait for Chromium's intersection check,
          which lands a frame behind the scroll a keypress just caused - so tiles
          crossing into view would paint empty and fill in on the NEXT press.
          Cropped rather than fitted, because a grid of mixed portrait and landscape
          photos reads as a grid only if the cells are the same shape. */}
      <img src={photo.thumb} alt="" decoding="async" className="w-full h-full object-cover" />
    </div>
  );
}

export function PhotoGrid({
  title,
  photos,
  startIndex,
  onOpen,
}: {
  title: string;
  photos: Photo[];
  startIndex: number;
  onOpen: (index: number) => void;
}) {
  const { t } = useI18n();
  // A grouping container, not a target: a focusable one is a full-screen rectangle
  // above the first row, and landing on it leaves the D-pad measuring from a rect
  // that covers the screen, with nothing highlighted and no way back.
  const { ref, focusKey } = useFocusable({
    focusKey: "photo-grid",
    focusable: false,
    isFocusBoundary: true,
    saveLastFocusedChild: true,
  });
  const rows = Math.ceil(photos.length / COLS);
  const last = Math.max(0, rows - WINDOW_ROWS);
  // Opened at the photo it was left on. The viewer replaces this screen rather
  // than covering it, so coming back is a fresh mount - and starting again at the
  // top would lose the place on every photo closed in a folder of hundreds.
  const at = Math.min(Math.max(0, startIndex), Math.max(0, photos.length - 1));
  const [start, setStart] = useState(() => Math.min(last, Math.max(0, Math.floor(at / COLS) - 1))); // first MOUNTED row

  const end = Math.min(rows, start + WINDOW_ROWS);
  const mounted = photos.slice(start * COLS, end * COLS);

  useFocusFallback(photos.length ? KEY(at) : undefined, (k) => k.startsWith("ph-"));

  // Once, on the way in. NOT when the list grows: a cast gallery fills up while it
  // is on screen, and re-running this on every arriving photo would drag the
  // cursor back to where the screen opened, mid-scroll. `useFocusFallback` above
  // is what covers the case of the cursor ending up nowhere.
  useEffect(() => {
    if (!photos.length) return;
    const id = setTimeout(() => setFocus(KEY(at)), 0);
    return () => clearTimeout(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Move the mounted window when focus comes near its edge. The tile that has focus
  // is inside the window both before and after, which is what keeps the cursor.
  const onFocusPos = (pos: number) => {
    const row = Math.floor(pos / COLS);
    if (row >= end - EDGE_ROWS && start < last) setStart(Math.min(last, start + SHIFT_ROWS));
    else if (row <= start + EDGE_ROWS - 1 && start > 0) setStart(Math.max(0, start - SHIFT_ROWS));
  };

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="h-full flex flex-col px-[4vw] py-[3vh]">
        <div className="text-[3vh] font-bold truncate">{title}</div>
        <div className="text-[1.6vh] text-fg-dim mb-[2vh]">{t("files.photoCount", { n: photos.length })}</div>
        {/* The focusable container is the SCROLLER and not the page: it is the node
            the tiles live in, and it is what each tile's scrollIntoView moves.

            The negative margin and the padding that cancels it are what keep a
            focused tile whole. `overflow-y-auto` makes the OTHER axis a clip
            boundary too (a non-visible overflow on one axis computes the other to
            auto), so a tile grown to 1.06 with an outline around it has its
            rounded corners sliced flat against the edge of this box - which is
            most obvious on the leftmost column, where there is nothing else to
            hide it. The pair moves the clip outwards without moving the tiles. */}
        <div ref={ref} className="flex-1 overflow-y-auto no-scrollbar -mx-[1vw] px-[1vw] -my-[1vh] py-[1vh]">
          {/* Spacers stand in for the rows that are not mounted, so the scroll
              position does not jump when the window shifts. */}
          <div style={{ height: start * ROW_VH + "vh" }} />
          <div className="grid grid-cols-5 gap-x-[1vw] gap-y-[1.5vh]">
            {mounted.map((p, k) => (
              <Tile
                key={p.key}
                photo={p}
                pos={start * COLS + k}
                onOpen={() => onOpen(start * COLS + k)}
                onFocusPos={onFocusPos}
              />
            ))}
          </div>
          <div style={{ height: Math.max(0, rows - end) * ROW_VH + "vh" }} />
        </div>
      </div>
    </FocusContext.Provider>
  );
}
