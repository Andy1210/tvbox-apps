import { useState, type ReactNode } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton } from "@sdk";

/** The action row itself. Nothing outside needs it by name; the page aims at
 *  the buttons, which it names explicitly. */
export const ACTIONS_KEY = "detail-actions";

export interface Action {
  /** The focus key, which the page also uses to put the cursor back. */
  key: string;
  /** What pressing it does, in words. The accessible name, and what an
   *  icon-only button shows while it is focused. */
  label: string;
  /** Drawn before the label. */
  icon?: ReactNode;
  /**
   * The icon carries the button on its own, and the label appears only while
   * it is focused.
   *
   * For the controls a row has no width to spell out. Play keeps its words
   * whatever else does: a row of glyphs with no anchor cannot be read from a
   * sofa, and the rarely-used actions are behind the overflow button rather
   * than shrunk into glyphs of their own.
   */
  iconOnly?: boolean;
  /** The one button the eye should land on first, drawn a shade brighter. */
  primary?: boolean;
  onEnter: () => void;
  onFocused?: () => void;
}

/**
 * The buttons above the rows, on one line.
 *
 * They were three lines - play and marking, then audio and subtitles, then the
 * versions - and on a season screen that pushed the synopsis off the top as
 * soon as the cursor reached the episodes. The synopsis there describes the
 * HIGHLIGHTED episode, so it is the one thing on the screen that has to survive
 * that scroll, which is what the line count was costing.
 *
 * A container of its own rather than a bare flex row, for one reason:
 * `hasFocusedChild`. An icon-only button spells itself out while it is focused,
 * and without knowing that the cursor has left the row altogether that label
 * stays open behind it - the SDK's button reports focus but has no blur.
 */
export function Actions({ actions }: { actions: Action[] }): React.JSX.Element | null {
  const { ref, focusKey, hasFocusedChild } = useFocusable({
    focusKey: ACTIONS_KEY,
    // Never a landing place itself: the page aims at the buttons by name, and a
    // container that could take the cursor would swallow a press with nothing
    // to show for it.
    focusable: false,
    trackChildren: true,
    // Re-entered from below by name (`ABOVE_ROWS`), so a remembered child adds
    // nothing - and would put the cursor on whatever was pressed last rather
    // than on Play.
    saveLastFocusedChild: false,
  });
  /**
   * Which button the cursor is on, for the label an icon cannot carry.
   *
   * Every button in the row sets it, so it is only ever stale once focus has
   * left the row entirely - which is what `hasFocusedChild` answers.
   */
  const [at, setAt] = useState<string | null>(null);

  if (actions.length === 0) return null;

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="mt-[1vh] flex items-stretch gap-[1.2vw]">
        {actions.map((a) => {
          const open = a.iconOnly && hasFocusedChild && at === a.key;
          return (
            <FocusButton
              key={a.key}
              focusKey={a.key}
              onEnter={a.onEnter}
              onFocused={() => {
                setAt(a.key);
                a.onFocused?.();
              }}
              // The words, for a button that draws a glyph. Without it the only
              // name this control has is its shape.
              label={a.label}
              className={`flex items-center gap-[0.8vw] rounded-[1vh] py-[1.4vh] text-[2.1vh] whitespace-nowrap ${
                a.primary ? "bg-white/15 px-[2.4vw]" : "bg-white/10 px-[2vw]"
              }`}
            >
              {a.icon}
              {/* Spelled out only while the cursor is on it, so the row keeps
                  its width the rest of the time. A glyph that has to be guessed
                  at is the one thing a remote cannot ask about. */}
              {(!a.iconOnly || open) && <span>{a.label}</span>}
            </FocusButton>
          );
        })}
      </div>
    </FocusContext.Provider>
  );
}
