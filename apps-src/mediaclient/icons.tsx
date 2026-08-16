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

export function StopIcon({ className = "h-[2.6vh] w-[2.6vh]" }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M6.5 6.5h11v11h-11z" />
    </svg>
  );
}

/**
 * The rest are drawn with strokes rather than filled.
 *
 * Solid for what MOVES the music (play, pause, the steppers, stop) and outlined
 * for what changes a MODE or opens something (shuffle, repeat, save) - so the
 * two kinds are told apart by weight before either shape is read. Every one of
 * them keeps a 2-unit stroke on the 24-unit grid, which is about 4 screen pixels
 * at the size they are drawn at here: thinner ones disappeared at three metres.
 */
const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function ShuffleIcon({ className = "h-[2.6vh] w-[2.6vh]" }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} {...STROKE} aria-hidden="true">
      <path d="M3 7h3.2c2 0 3.1 1.4 4.3 3.2l3.4 5.6C15.1 17.6 16.2 19 18.2 19H20" />
      <path d="M3 19h3.2c2 0 3.1-1.4 4.3-3.2l3.4-5.6C15.1 8.4 16.2 7 18.2 7H20" />
      <path d="M17.5 4.5 20 7l-2.5 2.5" />
      <path d="M17.5 16.5 20 19l-2.5 2.5" />
    </svg>
  );
}

/** The loop, with a `1` inside it for repeat-one - which is a different mode,
 *  not a brighter version of the same one. */
export function RepeatIcon({
  one = false,
  className = "h-[2.6vh] w-[2.6vh]",
}: {
  one?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} {...STROKE} aria-hidden="true">
      <path d="M4 10V9a3 3 0 0 1 3-3h10" />
      <path d="M14.5 3.5 17.5 6l-3 2.5" />
      <path d="M20 14v1a3 3 0 0 1-3 3H7" />
      <path d="M9.5 20.5 6.5 18l3-2.5" />
      {one && (
        // Smaller than it wants to be, and lifted: the loop encloses twelve
        // units and a digit sized to fill them sits ON its lower stroke -
        // rendered and looked at, not reasoned about. It is a mark that says
        // "not the other one" rather than something read across a room; what
        // says WHICH mode at that distance is the accent fill and the line
        // naming the focused button.
        <text
          x="12"
          y="14.6"
          textAnchor="middle"
          fontSize="8"
          fontWeight="700"
          fill="currentColor"
          stroke="none"
          // The box's UI font, not a family name that may not be installed: a
          // missing one falls back per-glyph and the digit changes size between
          // the two states, which reads as the icon jumping.
          fontFamily="inherit"
        >
          1
        </text>
      )}
    </svg>
  );
}

/**
 * Ten seconds either way: the circular arrow everything else uses, with the
 * number inside it.
 *
 * The number carries the meaning and the arc only says which way, so the arc is
 * left almost closed - a gap wide enough for the head and nothing more. Without
 * the digits these were two more triangles next to the steppers, which is the
 * confusion the thick end bar above already exists to prevent.
 */
export function Back10Icon({ className = "h-[2.6vh] w-[2.6vh]" }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} {...STROKE} aria-hidden="true">
      <path d="M12 4A8 8 0 1 1 9.9 4.3" />
      <path d="M14 2l-2 2 2 2" />
      <text x="12" y="15.4" textAnchor="middle" fontSize="9" fontWeight="700" fill="currentColor" stroke="none">
        10
      </text>
    </svg>
  );
}

export function Forward10Icon({ className = "h-[2.6vh] w-[2.6vh]" }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} {...STROKE} aria-hidden="true">
      <path d="M12 4A8 8 0 1 0 14.1 4.3" />
      <path d="M10 2l2 2-2 2" />
      <text x="12" y="15.4" textAnchor="middle" fontSize="9" fontWeight="700" fill="currentColor" stroke="none">
        10
      </text>
    </svg>
  );
}

/** Save the running order: a list, and a plus. */
export function PlaylistAddIcon({ className = "h-[2.6vh] w-[2.6vh]" }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} {...STROKE} aria-hidden="true">
      <path d="M4 7h12M4 12h12M4 17h7" />
      <path d="M17 14v6M14 17h6" />
    </svg>
  );
}
