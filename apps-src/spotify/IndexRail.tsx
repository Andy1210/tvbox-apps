import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useFocusableItem } from "@sdk";
import { RAIL, ROWS, TOOLS, jump } from "./focus";

// The jump rail beside the list. A thousand tracks are a thousand D-pad presses
// from top to bottom, so the rail is what makes the middle and the END of a list
// reachable at all.
//
// It carries whichever index the list is currently ordered by, and that is the
// point rather than a detail: a playlist is in the order its owner built it, so
// A-Z over it would be 26 buckets in no order, each one repeating. In playlist
// order the useful index is POSITION; sorted by title or artist it is the letter.
export interface Bucket {
  label: string;
  at: number | undefined; // undefined = nothing under this label (dimmed, and skipped by the D-pad)
}

export const OTHER = "#";
const LETTERS = [OTHER, ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")];

// Which bucket a name belongs to. Accents are folded first, so "Álom" files under
// A rather than under "#" - a Hungarian library would otherwise pile up in one
// bucket.
export function bucketOf(label: string): string {
  const first = String(label || "")
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .charAt(0);
  return first >= "A" && first <= "Z" ? first : OTHER;
}

// A-Z buckets over a sorted list: label -> the position where it starts.
export function alphaBuckets(names: string[]): Bucket[] {
  const at = new Map<string, number>();
  names.forEach((n, i) => {
    const b = bucketOf(n);
    if (!at.has(b)) at.set(b, i);
  });
  return LETTERS.map((l) => ({ label: l, at: at.get(l) }));
}

// A round step (1, 2 or 5 times a power of ten) that divides the list into at
// most `max` jumps. Round numbers because the labels are read off a rail from
// three metres away: "100, 200, 300" is a scale, "84, 167, 250" is noise.
function niceStep(count: number, max: number): number {
  const raw = Math.max(1, Math.ceil(count / Math.max(1, max)));
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return raw;
}

// Position buckets for a list in its own order.
// 20, not a dozen: on a thousand tracks a dozen leaves a hundred rows between
// stops, which is a hundred presses. The A-Z rail is 27 entries and fits the
// column, so this does too.
export function positionBuckets(count: number, max = 20): Bucket[] {
  if (count <= 0) return [];
  const out: Bucket[] = [{ label: "1", at: 0 }];
  const step = niceStep(count, max);
  // Never label "1" twice: with a step of one, the first iteration would land on
  // position 0 again, and a repeated label is both a duplicate React key and a
  // duplicate spatial-navigation focus key. Two focusables cannot share a name.
  for (let n = Math.max(step, 2); n < count; n += step) out.push({ label: String(n), at: n - 1 });
  // The last entry is the LAST track, not the start of the last block. Getting to
  // the end is the one jump a long list most needs, and a rounded block start
  // would always leave it short.
  if (count > 1 && out[out.length - 1].at !== count - 1) out.push({ label: String(count), at: count - 1 });
  return out;
}

function Entry({
  bucket,
  current,
  first,
  onPreview,
  onCommit,
}: {
  bucket: Bucket;
  current: boolean;
  first: boolean; // the topmost entry with anything under it
  onPreview: (pos: number) => void;
  onCommit: (pos: number) => void;
}) {
  const has = bucket.at !== undefined;
  // An empty bucket is not focusable at all - that is what makes the D-pad skip
  // it instead of stopping on a dead entry.
  const { ref, focused } = useFocusableItem(
    {
      focusKey: "rail-" + bucket.label,
      focusable: has,
      // Moving over an entry scrolls the list to it and leaves focus here, so the
      // rail can be walked; OK (or left) is what puts focus on the rows.
      onFocus: () => has && onPreview(bucket.at as number),
      onEnterPress: () => has && onCommit(bucket.at as number),
      onArrowPress: (dir) => {
        if (dir === "left") {
          onCommit(has ? (bucket.at as number) : -1);
          return false;
        }
        if (dir === "right") return false; // nothing further right
        // Up out of the rail belongs to the tools row. It has to be decided HERE
        // rather than on the rail container: norigin calls onArrowPress on the
        // focused leaf only, and a container is never the focused thing.
        if (dir === "up" && first) return !jump(TOOLS);
        return true;
      },
    },
    { block: "nearest" },
  );
  return (
    <div
      ref={ref}
      className={[
        "h-[2.5vh] leading-[2.5vh] text-center rounded-[0.5vh] text-[1.4vh] font-semibold tabular-nums px-[0.2vw]",
        !has ? "text-white/15" : focused ? "bg-white text-[#06090d]" : current ? "bg-white/15 text-fg" : "text-fg-dim",
      ].join(" ")}
    >
      {bucket.label}
    </div>
  );
}

export function IndexRail({
  buckets,
  current,
  onPreview,
  onCommit,
}: {
  buckets: Bucket[];
  current: string;
  onPreview: (pos: number) => void;
  onCommit: (pos: number) => void;
}) {
  const { ref, focusKey } = useFocusable({ focusKey: RAIL });
  // An empty bucket is not focusable, so "the first one" is the first that has
  // something under it, not the first in the list.
  const firstWithItems = buckets.findIndex((b) => b.at !== undefined);
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="w-[3.4vw] shrink-0 flex flex-col justify-center gap-[0.15vh]">
        {buckets.map((b, k) => (
          <Entry
            key={b.label}
            bucket={b}
            current={b.label === current}
            first={k === firstWithItems}
            onPreview={onPreview}
            onCommit={(pos) => (pos < 0 ? jump(ROWS) : onCommit(pos))}
          />
        ))}
      </div>
    </FocusContext.Provider>
  );
}
