import { useFocusableItem, useI18n } from "@sdk";
import type { Title } from "./api";

// One game. The art is the whole tile: a Game Pass tile image is a 1:1 square
// with the name burnt into it, so a caption under it repeats what the picture
// already says - it appears only for a title the catalogue had no row for.
//
// `loading="lazy"` is what makes holding the whole library affordable: 2500 rows
// of metadata are 1.45 MB, but 2500 images are not, and the browser fetches only
// what is on screen.
export function Tile({ title, focusKey, onEnter }: { title: Title; focusKey: string; onEnter: () => void }) {
  const { t } = useI18n();
  const { ref, focused } = useFocusableItem<HTMLButtonElement>(
    { focusKey, onEnterPress: onEnter },
    { block: "nearest", inline: "nearest" },
  );

  return (
    <button
      ref={ref}
      onClick={onEnter}
      aria-label={title.name || title.titleId}
      // The focus key, in the DOM, the way FocusButton carries its own: without a
      // marker a navigation check cannot say WHICH tile the focus is on, and an
      // assertion about focus with nothing to anchor it is decided by nothing.
      data-sfocus={focusKey}
      data-focused={focused ? "1" : undefined}
      className={
        // The focus has to be readable from a sofa, which a thin ring is not: a
        // white outline OUTSIDE the tile (so it is not lost against pale box art),
        // a visible lift, and everything unfocused dimmed so the bright one is the
        // one being looked at.
        "relative w-[13vw] shrink-0 overflow-hidden rounded-xl bg-bg-1 text-left transition-all duration-100 " +
        (focused
          ? "z-10 scale-110 outline outline-[6px] outline-offset-[3px] outline-focus brightness-110"
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
