// The A-Z column down the side of a long list.
//
// Lifted out of Library.tsx when the music screens needed the same thing. The
// only part that differed between them is where Up from the first letter goes,
// so that is a prop; everything else - the sizing, the no-scroll rule, the way
// focus enters at the letter the list is already on - is the same problem in
// both places and is deliberately not duplicated.

import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton } from "@sdk";

export interface Letter {
  key: string;
  title: string;
  size: number;
}

export function LetterStrip({
  letters,
  onPick,
  active,
  upTargetKey,
  focusKey: key = "letters",
}: {
  letters: Letter[];
  onPick: (key: string) => void;
  active: string | null;
  /** Where Up from the top letter goes. Geometry would say "the grid", which is
   *  beside the strip rather than above it. */
  upTargetKey: string;
  /** The strip's own key. Its LETTERS keep one naming across screens, because
   *  focus fallbacks and tests both match on the `letter-` prefix. */
  focusKey?: string;
}): React.JSX.Element {
  const { ref, focusKey } = useFocusable({
    focusKey: key,
    // NOT remembered. Measured on the box: after the strip had been used once,
    // arriving at it again landed on whatever letter was pressed last - Right
    // from the top of the list went to Z - because the remembered child beats
    // the preferred one. The letter the list is actually on is always the right
    // place to enter, which is what `preferredChildFocusKey` below names.
    saveLastFocusedChild: false,
    // Enter where the list already is, not at the top of the alphabet. From the
    // M's, reaching M otherwise cost up to twenty-six presses down a strip whose
    // whole purpose is to be faster than scrolling.
    preferredChildFocusKey: active ? `letter-${active}` : undefined,
  });
  return (
    <FocusContext.Provider value={focusKey}>
      <div
        // Every letter at once, and no scrolling. A strip you have to scroll
        // through is slower than scrolling the list it is meant to shortcut - so
        // the letters shrink to fit the height instead, which they can because
        // each is one character.
        // overflow-y-auto is a backstop, not the plan: 29 letters fit, but a
        // library with every Hungarian accented bucket would exceed the column
        // and the ends would otherwise be clipped while still focusable - which
        // is a dead remote rather than a cosmetic problem.
        className="no-scrollbar flex h-full flex-col items-stretch justify-center gap-[0.1vh] overflow-y-auto py-[1vh] pr-[1vw] pl-[0.4vw]"
        ref={ref}
      >
        {letters.map((l, i) => (
          <FocusButton
            key={l.key}
            focusKey={`letter-${l.key}`}
            onEnter={() => onPick(l.key)}
            onArrowPress={(dir) => {
              if (dir === "up" && i === 0) {
                setFocus(upTargetKey);
                return false;
              }
              return true;
            }}
            // A bare character, not a button-shaped box: thirty of those made a
            // second column down the side of the screen. Focus still fills, as
            // it does everywhere else.
            // Bigger than it was, and tighter, because those trade against each
            // other: 29 letters have to fit the column height without scrolling,
            // and at leading 1.35 that capped the size below the 24px floor a
            // television wants for body text. Tighter leading buys the size.
            className={`rounded-[0.5vh] px-[0.6vw] text-center text-[2.4vh] leading-[1.15] ${
              l.key === active ? "font-bold" : "text-fg-dim"
            }`}
          >
            {l.title}
          </FocusButton>
        ))}
      </div>
    </FocusContext.Provider>
  );
}
