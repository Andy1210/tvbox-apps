/**
 * Transport glyphs, drawn rather than typed.
 *
 * Inline SVG, never an emoji or a font glyph: this browser has no colour-emoji
 * font and draws a hollow box in its place, and a word ("Szünet") is both wider
 * and slower to read across a room than the shape everyone already knows.
 *
 * They inherit `currentColor`, so a focused button - which turns its text dark -
 * takes the icon with it.
 *
 * The end bar on the steppers is deliberately thick. At 2px it was the only
 * thing separating "next episode" from a plain forward triangle, and 2px at
 * three metres on a 55" 1080p panel is about 1.5 arc-minutes - the eye's limit.
 * Left and Right in the resting state really do seek, so the two have to be
 * told apart.
 */
export function PlayIcon({ className = "h-[2.6vh] w-[2.6vh]" }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

export function PauseIcon({ className = "h-[2.6vh] w-[2.6vh]" }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  );
}

/** Skip to the next item, not to the next scene: the bar with the triangle. */
export function NextIcon({ className = "h-[2.6vh] w-[2.6vh]" }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M4 5l10 7-10 7zM16.5 5h3.5v14h-3.5z" />
    </svg>
  );
}

export function PreviousIcon({ className = "h-[2.6vh] w-[2.6vh]" }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M20 5L10 12l10 7zM4 5h3.5v14H4z" />
    </svg>
  );
}
