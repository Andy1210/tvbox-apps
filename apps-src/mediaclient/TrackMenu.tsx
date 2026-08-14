import { useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useI18n } from "@sdk";
import { useInitialFocus } from "./focus";
import type { MediaVersion, Track } from "./backends/types";

export type Choice = { version: number; audio?: number; subtitle?: number | "none" };

export interface TrackMenuProps {
  versions: MediaVersion[];
  current: Choice;
  onChoose: (next: Choice) => void;
  onClose: () => void;
  /** Look for subtitles the server could fetch. Absent when unsupported. */
  onSearchSubtitles?: () => void;
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
  searchState = "idle",
}: TrackMenuProps): React.JSX.Element {
  const { t } = useI18n();
  const [choice, setChoice] = useState<Choice>(current);
  const { ref, focusKey } = useFocusable({ focusKey: "trackmenu", saveLastFocusedChild: true, isFocusBoundary: true });

  const version = versions[choice.version] ?? versions[0];
  const audio = version?.audio ?? [];
  const subtitles = version?.subtitles ?? [];

  useInitialFocus(versions.length > 1 ? "ver-0" : "aud-0", true);

  const apply = (next: Choice): void => {
    setChoice(next);
    onChoose(next);
  };

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="absolute inset-0 flex items-end justify-center bg-black/70 pb-[6vh]">
        <div className="flex max-h-[64vh] w-[86vw] gap-[2vw] overflow-hidden rounded-[1.4vh] bg-[#0c1219]/95 p-[3vh]">
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
                <Option
                  focusKey="sub-search"
                  active={false}
                  label={t(searchState === "searching" ? "tracks.searching" : "tracks.search")}
                  onEnter={onSearchSubtitles}
                />
                {searchState === "unavailable" && <Empty text={t("tracks.searchUnavailable")} />}
                {searchState === "none" && <Empty text={t("tracks.searchNone")} />}
              </>
            )}
          </Column>
        </div>

        <FocusButton
          focusKey="tracks-close"
          onEnter={onClose}
          className="absolute top-[3vh] right-[4vw] rounded-[1vh] bg-white/12 px-[2vw] py-[1vh] text-[1.9vh]"
        >
          {t("tracks.close")}
        </FocusButton>
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
      <h3 className="text-[1.9vh] font-semibold tracking-tight text-fg-dim">{title}</h3>
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
      <span className="text-[1.9vh]">
        {/* A mark rather than a colour: the focus ring is already white, and two
            whites next to each other say nothing about which is chosen. */}
        {active ? "• " : "  "}
        {label}
      </span>
      {hint && <span className="text-[1.7vh] text-fg-dim">{hint}</span>}
    </FocusButton>
  );
}
