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
        // The focus has to be readable from a sofa, which a thin inset ring is
        // not. The outline sits OUTSIDE the tile, so the row and the page both
        // reserve room for it - a clipped highlight is what a container with
        // `overflow: hidden` does to it otherwise.
        "relative w-[13vw] shrink-0 overflow-hidden rounded-xl bg-bg-1 text-left transition-all duration-100 " +
        (focused
          ? "z-10 scale-105 outline outline-[0.5vh] outline-offset-[0.35vh] outline-focus brightness-110"
          : "brightness-[0.65]")
      }
    >
      <div className="aspect-square w-full">
        {title.tile ? (
          <img src={title.tile} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center p-3 text-center text-lg text-fg-dim">
            {title.name || title.titleId}
          </span>
        )}
      </div>
      {/* A time-limited title has to say so before somebody settles in with it. */}
      {title.maxPlaySeconds > 0 && (
        <span className="absolute left-0 top-0 m-2 rounded bg-warn px-2 py-1 text-sm font-semibold text-bg-0">
          {t("stream.trial", { minutes: Math.round(title.maxPlaySeconds / 60) })}
        </span>
      )}
    </button>
  );
}
