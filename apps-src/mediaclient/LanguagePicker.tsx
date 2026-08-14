import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useBackspace, useI18n } from "@sdk";
import { useFocusFallback, useInitialFocus } from "./focus";
import type { MediaVersion } from "./backends/types";

/**
 * Audio and subtitles, before anything starts.
 *
 * A panel rather than chips on the page. A film with fifteen embedded subtitles
 * turned the detail screen into a wall of them, above the synopsis and the cast
 * - and the choice is made once, if at all, which is not what belongs in front
 * of everything else.
 *
 * One column each, as lists. Subtitles especially: they are many, their names
 * are long ("Magyar (SRT External Forced)"), and a list reads down where a
 * wrapped row of chips reads in neither direction.
 */
export function LanguagePicker({
  version,
  audio,
  subtitle,
  onAudio,
  onSubtitle,
  onClose,
}: {
  version: MediaVersion | undefined;
  audio: number | undefined;
  subtitle: number | "none" | undefined;
  onAudio: (ordinal: number) => void;
  onSubtitle: (ordinal: number | "none") => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "langpicker", saveLastFocusedChild: true, isFocusBoundary: true });
  useInitialFocus("lp-close", true);
  useFocusFallback("lp-close", (k) => k.startsWith("lp-"), true);
  useBackspace(onClose, true);

  const tracks = version?.audio ?? [];
  const subs = version?.subtitles ?? [];

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="absolute inset-0 z-40 flex items-center justify-center bg-black/80">
        <div className="flex h-[80vh] w-[80vw] flex-col gap-[2vh] overflow-hidden rounded-[1.4vh] bg-[#0c1219]/97 p-[3vh]">
          <div className="flex items-center justify-between">
            <h2 className="text-[2.6vh] font-semibold tracking-tight">{t("tracks.title")}</h2>
            <FocusButton
              focusKey="lp-close"
              onEnter={onClose}
              className="rounded-[1vh] bg-white/10 px-[2vw] py-[1vh] text-[2vh]"
            >
              {t("common.done")}
            </FocusButton>
          </div>

          <div className="flex flex-1 gap-[2vw] overflow-hidden">
            <Column title={t("tracks.audio")}>
              {tracks.length === 0 && <Empty text={t("tracks.noAudio")} />}
              {tracks.map((a) => (
                <Line
                  key={a.id}
                  focusKey={`lp-aud-${a.ordinal}`}
                  active={audio === undefined ? Boolean(a.selected) : audio === a.ordinal}
                  label={a.label}
                  onEnter={() => onAudio(a.ordinal)}
                />
              ))}
            </Column>

            <Column title={t("tracks.subtitles")}>
              <Line
                focusKey="lp-sub-off"
                active={subtitle === "none"}
                label={t("tracks.subtitlesOff")}
                onEnter={() => onSubtitle("none")}
              />
              {subs.map((sub) => (
                <Line
                  key={sub.id}
                  focusKey={`lp-sub-${sub.ordinal}`}
                  active={subtitle === undefined ? Boolean(sub.selected) : subtitle === sub.ordinal}
                  label={sub.label}
                  onEnter={() => onSubtitle(sub.ordinal)}
                />
              ))}
            </Column>
          </div>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

function Column({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="no-scrollbar flex min-w-0 flex-1 flex-col gap-[1vh] overflow-y-auto">
      <h3 className="text-[2.1vh] font-semibold text-fg-dim">{title}</h3>
      {/* A column of full-width lines: one thing per row, in one direction, so
          Up and Down mean what they look like they mean. */}
      <div className="-mx-[0.6vw] flex flex-col gap-[0.6vh] px-[0.6vw]">{children}</div>
    </section>
  );
}

function Line({
  focusKey,
  active,
  label,
  onEnter,
}: {
  focusKey: string;
  active: boolean;
  label: string;
  onEnter: () => void;
}): React.JSX.Element {
  return (
    <FocusButton
      focusKey={focusKey}
      onEnter={onEnter}
      className="flex w-full items-center rounded-[0.8vh] bg-white/5 px-[1.4vw] py-[1vh] text-left text-[2.1vh]"
    >
      <span className="inline-block w-[1.6vw] shrink-0 text-center">{active ? "✓" : ""}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </FocusButton>
  );
}

function Empty({ text }: { text: string }): React.JSX.Element {
  return <p className="px-[1.4vw] text-[1.9vh] text-fg-dim">{text}</p>;
}
