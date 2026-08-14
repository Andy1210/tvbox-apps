import { useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useI18n } from "@sdk";
import { useFocusFallback, useInitialFocus } from "./focus";
import type { MediaVersion, Track } from "./backends/types";

export type Choice = { version: number; audio?: number; subtitle?: number | "none" };

export interface TrackMenuProps {
  versions: MediaVersion[];
  current: Choice;
  onChoose: (next: Choice) => void;
  onClose: () => void;
  /** Look for subtitles the server could fetch. Absent when unsupported. */
  onSearchSubtitles?: () => void;
  /** What the search turned up, for the user to choose from. */
  found?: Track[];
  /** Fetch one onto the item. */
  onDownloadSubtitle?: (t: Track) => void;
  searchState?: "idle" | "searching" | "unavailable" | "none";
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
  onClose,
  onSearchSubtitles,
  found,
  onDownloadSubtitle,
  searchState = "idle",
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
  const firstKey =
    versions.length > 1 ? `ver-${choice.version}` : audio.length ? `aud-${audio[0].ordinal}` : "sub-off";
  useInitialFocus(firstKey, true);
  useFocusFallback(
    firstKey,
    (k) => k.startsWith("ver-") || k.startsWith("aud-") || k.startsWith("sub-") || k === "tracks-close",
  );

  const apply = (next: Choice): void => {
    setChoice(next);
    onChoose(next);
  };

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="absolute inset-0 flex items-end justify-center bg-black/70 pb-[6vh]">
        <div className="flex max-h-[64vh] w-[86vw] flex-col gap-[2vh] rounded-[1.4vh] bg-[#0c1219]/95 p-[3vh]">
          <div className="flex flex-1 gap-[2vw] overflow-hidden">
          {versions.length > 1 && (
            <Column title={t("tracks.version")}>
              {versions.map((v) => (
                <Option
                  key={v.index}
                  focusKey={`ver-${v.index}`}
                  active={v.index === choice.version}
                  label={v.label}
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
  const bits = [s.forced ? t("tracks.forced") : undefined, s.external ? t("tracks.external") : undefined].filter(Boolean);
  return bits.join(" · ");
}

function Column({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="flex min-w-[20vw] flex-1 flex-col gap-[1vh] overflow-y-auto">
      <h3 className="text-[2vh] font-semibold tracking-tight text-fg-dim">{title}</h3>
      <div className="flex flex-col gap-[0.6vh]">{children}</div>
    </section>
  );
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return <p className="text-[1.7vh] text-fg-dim">{text}</p>;
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
      className={`flex flex-col rounded-[0.8vh] px-[1.2vw] py-[0.9vh] text-left ${active ? "bg-white/20" : "bg-white/5"}`}
    >
      <span className="text-[2.4vh]">
        {/* A mark rather than a fill: a focused button turns white, so a white
            "selected" background says nothing about which one is chosen. Fixed
            width, because two literal spaces collapse to one and leave the
            column with a ragged left edge. */}
        <span className="inline-block w-[1.4vw]">{active ? "•" : ""}</span>
        {label}
      </span>
      {/* Reduced opacity of the inherited colour, not a fixed grey: a focused
          button turns white, and a fixed grey on white is 3:1 - unreadable
          exactly when someone is looking at it. */}
      {hint && <span className="text-[1.7vh] opacity-60">{hint}</span>}
    </FocusButton>
  );
}
