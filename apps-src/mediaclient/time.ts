/**
 * A duration as a person reads it: 3:07, or 1:02:11 once there is an hour.
 *
 * Minutes are only padded when an hour is shown, because "3:07" is a song and
 * "03:07" is a stopwatch. Shared rather than copied: the player, the chapter
 * strip and now the music screens all print the same thing, and three copies of
 * a formatter drift in exactly the small ways nobody notices until two numbers
 * on one screen disagree.
 */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
