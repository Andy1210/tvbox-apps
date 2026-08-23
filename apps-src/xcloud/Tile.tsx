import { useEffect, useRef } from "react";
import { useFocusableItem, useI18n } from "@sdk";
import type { Title } from "./api";

// One game. The art is the whole tile: a Game Pass tile image is a 1:1 square with
// the name burnt into it, so a caption under it repeats what the picture already
// says - it appears only for a title the catalogue had no row for.
//
// `loading="lazy"` is what makes holding the whole library affordable: 2500 rows of
// metadata are 1.45 MB, but 2500 images are not, and the browser fetches only what
// is on screen.
//
// It reports its own element when it takes focus, because the page moves ITSELF -
// there is no scrolling container to ask. See moveTo.ts for why.
export function Tile({
  title,
  focusKey,
  onEnter,
  onFocused,
}: {
  title: Title;
  focusKey: string;
  onEnter: () => void;
  onFocused?: (el: HTMLElement) => void;
}) {
  const { t } = useI18n();
  const node = useRef<HTMLButtonElement | null>(null);
  // No scrollIntoView: the page is moved by a transform, so a native scroll here
  // would fight it and repaint the grid while it does.
  const { ref, focused } = useFocusableItem<HTMLButtonElement>({ focusKey, onEnterPress: onEnter });

  useEffect(() => {
    if (focused && node.current) onFocused?.(node.current);
  }, [focused, onFocused]);

  return (
    <button
      ref={(el) => {
        node.current = el;
        ref(el);
      }}
      onClick={onEnter}
      aria-label={title.name || title.titleId}
      // The focus key, in the DOM, the way FocusButton carries its own: without a
      // marker a navigation check cannot say WHICH tile the focus is on, and an
      // assertion about focus with nothing to anchor it is decided by nothing.
      data-sfocus={focusKey}
      data-focused={focused ? "1" : undefined}
      className={
        "relative w-[13vw] shrink-0 overflow-hidden rounded-xl bg-bg-1 text-left transition-all duration-100 " +
        (focused ? "z-10 scale-[1.04] brightness-110" : "brightness-[0.65]")
      }
      // The focus has to be readable from a sofa, which a thin inset ring is not -
      // so the outline sits OUTSIDE the tile. Everything that clips then has to
      // reserve room for how far it reaches, which is three things added together:
      // half the scale growth, the offset, and the outline's own width.
      // `--focus-reach` in index.css is that sum and the row, the grid and the
      // page column all pad by it - a reserve short by a few pixels is exactly the
      // "still clipped a little" this went through twice.
      //
      // Inline rather than Tailwind classes because an arbitrary-value outline is
      // easy to get subtly wrong, and a class that does not compile means NO
      // outline - worse than a clipped one.
      style={
        focused
          ? {
              outlineStyle: "solid",
              outlineColor: "var(--color-focus)",
              outlineWidth: "var(--focus-outline)",
              outlineOffset: "var(--focus-offset)",
            }
          : undefined
      }
    >
      <div className="aspect-square w-full">
        {title.tile ? (
          <img src={title.tile} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center p-3 text-center text-[1.7vh] text-fg-dim">
            {title.name || title.titleId}
          </span>
        )}
      </div>
      {/* A time-limited title has to say so before somebody settles in with it -
          but as a BADGE, not as the sentence the stream screen uses. Measured, the
          full sentence was 234 px wide on a 250 px tile, 94% of its width, laid
          over art that has the game's own name burnt into it. */}
      {title.maxPlaySeconds > 0 && (
        <span className="absolute left-0 top-0 m-2 rounded bg-warn px-2 py-1 text-[1.6vh] font-semibold text-bg-0">
          {t("library.trialBadge", { minutes: Math.round(title.maxPlaySeconds / 60) })}
        </span>
      )}
      {/* Search is the only place a title outside the subscription appears - the
          grid is `owned` only - and it looked exactly like one that is included,
          so pressing it went to the waiting screen and then to a bare failure. */}
      {!title.owned && (
        <span className="absolute bottom-0 left-0 right-0 bg-bg-0/85 px-2 py-1 text-center text-[1.5vh] text-fg-dim">
          {t("library.notIncluded")}
        </span>
      )}
    </button>
  );
}
