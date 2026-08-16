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

/**
 * The loop, marked in the middle for repeat-one - which is a different mode, not
 * a brighter version of the same one.
 *
 * A dot rather than the `1` every other player draws, for the reason set out on
 * the steppers below: rendered at the size it is really drawn, a digit inside
 * this loop has about four pixels of height and merges into the strokes above
 * and below it. A disc is the one mark that still reads there. Nothing is lost
 * by not spelling it, because the line under the row names the mode in words -
 * without that line this would have to stay a `1` and be illegible.
 */
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
      {one && <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />}
    </svg>
  );
}

/**
 * Ten seconds either way: the number, and a chevron saying which way.
 *
 * NOT the circular arrow every player draws, and that was decided by rendering
 * these at the size they are actually drawn - about thirty pixels - rather than
 * at the magnification an icon is designed at. Enclosed in a ring, the digits
 * have four or five pixels of height to live in and turn into a smudge; the ring
 * survives and says nothing, because the ring is the half that carries no
 * meaning. Given the whole box the digits are legible, and a thin chevron is in
 * no danger of being read as the filled triangle-and-bar next to it.
 *
 * The number leads in the direction of travel - chevron first going back, digits
 * first going forward - so the pair mirror each other rather than both reading
 * left to right.
 */
export function Back10Icon({ className = "h-[2.6vh] w-[2.6vh]" }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} {...STROKE} strokeWidth={2.1} aria-hidden="true">
      <path d="M7.5 6 3.5 12l4 6" />
      <text x="16.5" y="16.4" textAnchor="middle" fontSize="11.5" fontWeight="700" fill="currentColor" stroke="none">
        10
      </text>
    </svg>
  );
}

export function Forward10Icon({ className = "h-[2.6vh] w-[2.6vh]" }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className={className} {...STROKE} strokeWidth={2.1} aria-hidden="true">
      <text x="7.5" y="16.4" textAnchor="middle" fontSize="11.5" fontWeight="700" fill="currentColor" stroke="none">
        10
      </text>
      <path d="M16.5 6 20.5 12l-4 6" />
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
