import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFocusableItem } from "@sdk";

/**
 * The synopsis, at a height that does not depend on how long it is.
 *
 * On a season screen the description belongs to whichever episode the cursor is
 * on, so moving along the row rewrote it - and a two-line blurb followed by a
 * six-line one moved everything under it, the artwork included. The page jumped
 * on every press. A fixed box is the whole fix: three lines, occupied whether
 * the text fills them or not.
 *
 * What does not fit is reachable rather than lost. The box takes focus and OK
 * opens it - but ONLY when there is something hidden, because a stop on the way
 * to the buttons that answers OK with nothing is worse than no stop at all.
 * That is why `focusable` is measured rather than assumed.
 *
 * Opening it moves the page, which is the one thing the fixed height exists to
 * prevent - and that is the difference between a press somebody chose and a
 * side effect of moving the cursor.
 */
const LINES = 3;
/** text-[2vh] at leading-relaxed (1.625). */
const LINE_VH = 3.25;
/**
 * Where the cut is softened.
 *
 * 92%, not 62%: three lines occupy 9.75vh and the third line's descenders end
 * at about 9.1vh, so anything earlier fades the glyphs themselves rather than
 * the space under them.
 */
const FADE = "linear-gradient(to bottom, #000 92%, transparent 100%)";

export function Summary({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  const box = useRef<HTMLParagraphElement | null>(null);

  // Collapsed again whenever the text changes: an episode's synopsis opened by
  // hand must not decide the height of the next one's.
  useEffect(() => setOpen(false), [text]);

  // Measured, not guessed. Whether three lines are enough depends on the text,
  // the panel and the font - and being wrong in the generous direction is what
  // puts a dead stop in front of the play button.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = (): void => setClipped(el.scrollHeight > el.clientHeight + 1);
    measure();
    // The box is sized in vh, so a resolution change resizes it.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);

  const interactive = clipped || open;
  const { ref, focused } = useFocusableItem({
    focusKey: "detail-summary",
    // Registered either way so the key is stable, but only a destination when
    // there is something to open. norigin filters candidates on this, so an
    // arrow cannot land here when OK would do nothing.
    focusable: interactive,
    onEnterPress: () => setOpen((v) => !v),
  });

  return (
    <div
      ref={ref}
      className={`max-w-[62vw] rounded-[0.8vh] transition-[box-shadow] ${
        focused ? "ring-[0.3vh] ring-white" : "ring-0"
      }`}
    >
      <p
        ref={box}
        className={`overflow-hidden text-[2vh] leading-relaxed ${open ? "overflow-y-auto" : ""}`}
        style={
          open
            ? {
                maxHeight: "34vh",
                // The same fade when even the opened box does not hold it all.
                // Nothing in here is focusable, so the D-pad cannot scroll it -
                // a flush cut was the one state with no cue at all.
                maskImage: clipped ? FADE : undefined,
                WebkitMaskImage: clipped ? FADE : undefined,
              }
            : {
                height: `${LINES * LINE_VH}vh`,
                // Fades the cut line instead of ending on a sliced letter. A
                // mask rather than a gradient overlay, because what is behind
                // this text is artwork, not a known colour.
                // Opaque through the third line's descenders and fading only
                // in the gap under it. At 62% the ramp began at 6.05vh, which
                // is above that line's cap height - so its baseline sat at
                // 2.3:1 and the box gave two readable lines out of three.
                maskImage: clipped ? FADE : undefined,
                WebkitMaskImage: clipped ? FADE : undefined,
              }
        }
      >
        {text}
      </p>
    </div>
  );
}
