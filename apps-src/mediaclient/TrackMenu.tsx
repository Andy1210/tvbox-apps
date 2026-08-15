import { useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useFocusableItem, useI18n } from "@sdk";
import { useFocusFallback, useInitialFocus } from "./focus";
import type { MediaVersion, Track } from "./backends/types";

export type Choice = { version: number; audio?: number; subtitle?: number | "none"; maxBitrateKbps?: number };

/**
 * What the quality column offers.
 *
 * Named for what each one buys, with the bandwidth as the second line. A raw
 * "720 kbps" is one character from "720p" and will be read as a resolution by
 * anyone who is not looking for a bitrate; the number still has to be there,
 * because it is the only thing that can be compared against a connection.
 *
 * Original is first and is the default: it is the only entry that can avoid a
 * conversion entirely.
 */
/** Offered to the subtitle search. Kept short: a wall of codes is not a menu. */
export const SEARCH_LANGUAGES = ["hu", "en", "de"];

export const QUALITIES: { label: string; kbps?: number }[] = [
  { label: "player.q0" },
  { label: "player.q1", kbps: 20_000 },
  { label: "player.q2", kbps: 12_000 },
  { label: "player.q3", kbps: 8_000 },
  { label: "player.q4", kbps: 4_000 },
  { label: "player.q5", kbps: 2_000 },
  { label: "player.q6", kbps: 720 },
];

export interface TrackMenuProps {
  versions: MediaVersion[];
  current: Choice;
  onChoose: (next: Choice) => void;
  onClose: () => void;
  /**
   * Shift the subtitles in time, in seconds. Absent before playback, where
   * there is nothing running to shift.
   */
  onNudgeSubDelay?: (deltaSec: number) => void;
  /** The shift currently in force, for the row to show. */
  subDelaySec?: number;
  /** Look for subtitles the server could fetch. Absent when unsupported. */
  onSearchSubtitles?: () => void;
  /** What the search turned up, for the user to choose from. */
  found?: Track[];
  /** Fetch one onto the item. */
  onDownloadSubtitle?: (t: Track) => void;
  searchState?: "idle" | "searching" | "unavailable" | "none";
  /** Which language the search should ask for, and how to change it. */
  searchLanguage?: string;
  onSearchLanguage?: (code: string) => void;
  /** Which column takes focus. The overlay has a button per column. */
  initial?: "version" | "audio" | "subtitles" | "quality";
}

/**
 * Picking the version, the audio and the subtitles.
 *
 * Version first, and it is not a quality ladder. A household's second copy of a
 * film is as often a different language as a different resolution - the same
 * title dubbed and original as two whole files rather than two tracks - so
 * changing version can change everything below it, which is why the columns are
 * ordered this way and why the track lists are rebuilt when it changes.
 *
 * Three columns rather than a menu with submenus: on a remote, every level of
 * nesting is a press in and a press back out, and there are only ever three
 * things to decide here.
 */
export function TrackMenu({
  versions,
  current,
  onChoose,
  onNudgeSubDelay,
  subDelaySec,
  onClose,
  onSearchSubtitles,
  found,
  onDownloadSubtitle,
  searchState = "idle",
  searchLanguage = "hu",
  onSearchLanguage,
  initial = "version",
}: TrackMenuProps): React.JSX.Element {
  const { t } = useI18n();
  const [choice, setChoice] = useState<Choice>(current);
  const { ref, focusKey } = useFocusable({ focusKey: "trackmenu", saveLastFocusedChild: true, isFocusBoundary: true });

  const version = versions[choice.version] ?? versions[0];
  const audio = version?.audio ?? [];
  const subtitles = version?.subtitles ?? [];

  // The first key that will actually EXIST. Focusing one that does not leaves
  // the library with no origin and every later press is discarded - and a file
  // with no audio track is not hypothetical. "Off" is unconditional, so it is
  // always a valid floor.
  // The column the overlay's button asked for, falling back to the first key
  // that will actually EXIST. Focusing one that does not leaves the library with
  // no origin and every later press is discarded - and a file with no audio
  // track is not hypothetical. "Off" is unconditional, so it is always a valid
  // floor, and the quality column is always rendered.
  const firstKey =
    initial === "quality"
      ? `q-${QUALITIES.findIndex((q) => q.kbps === choice.maxBitrateKbps) >= 0 ? QUALITIES.findIndex((q) => q.kbps === choice.maxBitrateKbps) : 0}`
      : initial === "subtitles"
        ? "sub-off"
        : initial === "audio" && audio.length
          ? `aud-${audio[0].ordinal}`
          : versions.length > 1
            ? `ver-${choice.version}`
            : audio.length
              ? `aud-${audio[0].ordinal}`
              : "sub-off";
  useInitialFocus(firstKey, true);
  useFocusFallback(
    firstKey,
    (k) =>
      k.startsWith("ver-") ||
      k.startsWith("aud-") ||
      k.startsWith("sub-") ||
      k.startsWith("q-") ||
      k.startsWith("lang-") ||
      k === "tracks-close",
  );

  const apply = (next: Choice): void => {
    setChoice(next);
    onChoose(next);
  };

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="absolute inset-0 flex items-end justify-center bg-black/70 pb-[6vh]">
        <div // A fixed height, not a maximum: the panel would otherwise change size as
          // a search adds rows to one column, and the whole overlay jumps under
          // whatever the person is reading.
          className="flex h-[64vh] w-[86vw] flex-col gap-[2vh] rounded-[1.4vh] bg-[#0c1219]/95 p-[3vh]"
        >
          <div className="flex flex-1 gap-[2vw] overflow-hidden">
            {versions.length > 1 && (
              <Column title={t("tracks.version")}>
                {versions.map((v) => (
                  <Option
                    key={v.index}
                    focusKey={`ver-${v.index}`}
                    active={v.index === choice.version}
                    label={
                      v.parts > 1
                        ? `${v.label} · ${t("tracks.part", { n: String(v.partIndex + 1), of: String(v.parts) })}`
                        : v.label
                    }
                    hint={versionHint(v)}
                    // Changing the file invalidates the track choices made against
                    // the old one, so they go back to the server's own selection.
                    onEnter={() => apply({ version: v.index })}
                  />
                ))}
              </Column>
            )}

            <Column title={t("tracks.audio")}>
              {audio.length === 0 && <Empty text={t("tracks.noAudio")} />}
              {audio.map((a) => (
                <Option
                  key={a.id}
                  focusKey={`aud-${a.ordinal}`}
                  active={choice.audio === undefined ? Boolean(a.selected) : choice.audio === a.ordinal}
                  label={a.label}
                  onEnter={() => apply({ ...choice, audio: a.ordinal })}
                />
              ))}
            </Column>

            <Column title={t("tracks.subtitles")}>
              {/* At the TOP of the column, not under the tracks: it applies to
                  whichever subtitle is on, and a film with fifteen embedded
                  tracks would otherwise bury it past the fold. */}
              {onNudgeSubDelay && (
                <Offset value={subDelaySec ?? 0} onNudge={onNudgeSubDelay} label={t("tracks.subOffset")} />
              )}
              <Option
                focusKey="sub-off"
                active={choice.subtitle === "none"}
                label={t("tracks.subtitlesOff")}
                onEnter={() => apply({ ...choice, subtitle: "none" })}
              />
              {subtitles.map((s) => (
                <Option
                  key={s.id}
                  focusKey={`sub-${s.ordinal}`}
                  active={choice.subtitle === undefined ? Boolean(s.selected) : choice.subtitle === s.ordinal}
                  label={s.label}
                  hint={subtitleHint(s, t)}
                  onEnter={() => apply({ ...choice, subtitle: s.ordinal })}
                />
              ))}

              {onSearchSubtitles && (
                <>
                  {/* Above the tracks, not below them. A film with fifteen
                    embedded subtitles would otherwise bury it past the fold of a
                    scrolling column. */}
                  {/* Which language, before looking. A film often has only an
                    English subtitle available, and someone may want that one on
                    purpose - the button used to decide for them, silently, from
                    the interface language. */}
                  {onSearchLanguage && (
                    <div className="flex flex-wrap gap-[0.6vw] pb-[0.6vh]">
                      {SEARCH_LANGUAGES.map((code) => (
                        <FocusButton
                          key={code}
                          focusKey={`lang-${code}`}
                          onEnter={() => onSearchLanguage(code)}
                          className={`rounded-[0.7vh] px-[1.1vw] py-[0.6vh] text-[1.8vh] uppercase ${
                            code === searchLanguage ? "bg-white text-black" : "bg-white/10"
                          }`}
                        >
                          {code}
                        </FocusButton>
                      ))}
                    </div>
                  )}
                  <Option
                    focusKey="sub-search"
                    active={false}
                    label={t(searchState === "searching" ? "tracks.searching" : "tracks.search")}
                    onEnter={onSearchSubtitles}
                  />
                  {searchState === "unavailable" && <Empty text={t("tracks.searchUnavailable")} />}
                  {searchState === "none" && <Empty text={t("tracks.searchNone")} />}
                  {/* Finding them is half the job: each one is pressable, and
                    pressing it is what actually fetches it onto the item. */}
                  {(found ?? []).map((f) => (
                    <Option
                      key={`found-${f.id}`}
                      focusKey={`sub-found-${f.id}`}
                      active={false}
                      label={f.label}
                      hint={t("tracks.download")}
                      onEnter={() => onDownloadSubtitle?.(f)}
                    />
                  ))}
                </>
              )}
            </Column>

            <Column title={t("player.quality")} note={t("player.qualityHint")}>
              {QUALITIES.map((q, i) => (
                <Option
                  key={i}
                  focusKey={`q-${i}`}
                  active={choice.maxBitrateKbps === q.kbps}
                  label={t(q.label)}
                  // The number under the name, on every row that has one. It used
                  // to be a single warning parked on "Original" - the one row it
                  // does not describe.
                  hint={q.kbps ? (q.kbps >= 1000 ? `${q.kbps / 1000} Mbps` : `${q.kbps} kbps`) : undefined}
                  // A ceiling is baked into the stream when it is built, so this
                  // restarts playback where it stands rather than adjusting
                  // anything that is already running.
                  onEnter={() => apply({ ...choice, maxBitrateKbps: q.kbps })}
                />
              ))}
            </Column>
          </div>

          {/* In the panel rather than floating over the film in a corner. A
              focusable out of flow is navigated to by whatever happens to be
              measurable above it, and it reads as belonging to another screen.
              It is also the only thing on screen that says Back closes this. */}
          <FocusButton
            focusKey="tracks-close"
            onEnter={onClose}
            className="self-center rounded-[1vh] bg-white/12 px-[3vw] py-[1vh] text-[2vh]"
          >
            {t("tracks.close")}
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

function versionHint(v: MediaVersion): string {
  const bits = [
    v.resolution && v.resolution !== "sd" && v.resolution !== "sdp" ? v.resolution : undefined,
    v.videoCodec?.toUpperCase(),
    v.sizeBytes ? `${(v.sizeBytes / 1e9).toFixed(1)} GB` : undefined,
  ].filter(Boolean);
  return bits.join(" · ");
}

function subtitleHint(s: Track, t: (k: string) => string): string {
  const bits = [s.forced ? t("tracks.forced") : undefined, s.external ? t("tracks.external") : undefined].filter(
    Boolean,
  );
  return bits.join(" · ");
}

function Column({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  // The width floor is low enough that four columns fit: at 20vw each, four plus
  // their gaps came to more than the panel is wide, and the last one was clipped
  // by overflow-hidden - which reads as "there is more to the right" while Right
  // does nothing.
  return (
    <section className="no-scrollbar flex min-w-[17vw] flex-1 flex-col gap-[1vh] overflow-y-auto">
      <h3 className="text-[2.1vh] font-semibold tracking-tight text-fg-dim">{title}</h3>
      {note && <p className="text-[1.8vh] leading-snug text-fg-dim">{note}</p>}
      <div className="flex flex-col gap-[0.6vh]">{children}</div>
    </section>
  );
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return <p className="text-[1.7vh] text-fg-dim">{text}</p>;
}

/**
 * Shift the subtitles in time.
 *
 * Left and Right adjust rather than moving between columns, which is the one
 * place in this menu where that is true - and it is the right trade: an offset
 * is found by nudging until the line lands on the mouth, and a pair of buttons
 * would mean a press per step with the value two columns away from the eye.
 * Up and Down still leave, so it is a detour and not a trap.
 *
 * OK sets it back to zero. A row that answers OK with nothing is a dead press,
 * and returning to zero is the only other thing this row can mean.
 */
const STEP_SEC = 0.25;

function Offset({
  value,
  onNudge,
  label,
}: {
  value: number;
  onNudge: (deltaSec: number) => void;
  label: string;
}): React.JSX.Element {
  const { locale } = useI18n();
  const { ref, focused } = useFocusableItem({
    focusKey: "sub-offset",
    onArrowPress: (direction: string) => {
      if (direction === "left") {
        onNudge(-STEP_SEC);
        return false;
      }
      if (direction === "right") {
        onNudge(STEP_SEC);
        return false;
      }
      return true;
    },
    onEnterPress: () => onNudge(-value),
  });

  // Signed and to two places, so a change of a quarter second is visible - and
  // formatted for the locale, because a Hungarian television writes 0,25.
  const shown = new Intl.NumberFormat(locale ?? "en", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: "exceptZero",
  }).format(value);

  return (
    <div
      ref={ref}
      className={`flex items-center justify-between rounded-[0.8vh] px-[1.2vw] py-[0.9vh] ${
        focused ? "bg-white text-black" : "bg-white/5"
      }`}
    >
      <span className="text-[2.4vh]">{label}</span>
      <span className="flex items-center gap-[0.8vw] text-[2.4vh] tabular-nums">
        {/* Triangles, not words: they say which key moves the value, and the
            row is only reachable with a remote that has those two keys. */}
        <span aria-hidden="true">&#9666;</span>
        <span className="min-w-[4.2vw] text-center">{shown}s</span>
        <span aria-hidden="true">&#9656;</span>
      </span>
    </div>
  );
}

function Option({
  focusKey,
  active,
  label,
  hint,
  onEnter,
}: {
  focusKey: string;
  active: boolean;
  label: string;
  hint?: string;
  onEnter: () => void;
}): React.JSX.Element {
  return (
    <FocusButton
      focusKey={focusKey}
      onEnter={onEnter}
      // One background for every row. A lighter fill for the active one was
      // the same language the focus uses - a focused row turns solid white - so
      // two rows looked chosen at once and neither said which was which.
      className="flex flex-col rounded-[0.8vh] bg-white/5 px-[1.2vw] py-[0.9vh] text-left"
    >
      <span className="flex items-baseline gap-[0.6vw] text-[2.4vh]">
        {/* A mark, never a fill: the fill is what focus means everywhere in this
            app, so it cannot also mean "this is the current setting". Fixed
            width, or the rows sit at two different left edges depending on
            which one is active. */}
        <span className="inline-block w-[1.6vw] shrink-0 text-center">{active ? "✓" : ""}</span>
        <span className="min-w-0">{label}</span>
      </span>
      {/* Reduced opacity of the inherited colour, not a fixed grey: a focused
          button turns white, and a fixed grey on white is 3:1 - unreadable
          exactly when someone is looking at it. */}
      {hint && <span className="pl-[2.2vw] text-[1.9vh] opacity-65">{hint}</span>}
    </FocusButton>
  );
}
