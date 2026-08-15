/**
 * Transport glyphs, drawn rather than typed.
 *
 * Inline SVG, never an emoji or a font glyph: this browser has no colour-emoji
 * font and draws a hollow box in its place, and a word ("Szünet") is both wider
 * and slower to read across a room than the shape everyone already knows.
 *
 * They inherit `currentColor`, so a focused button - which turns its text dark -
 * takes the icon with it.
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
      <path d="M5 5l10 7-10 7zM17 5h2v14h-2z" />
    </svg>
  );
}

export function PreviousIcon({ className = "h-[2.6vh] w-[2.6vh]" }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M19 5L9 12l10 7zM5 5h2v14H5z" />
    </svg>
  );
}
