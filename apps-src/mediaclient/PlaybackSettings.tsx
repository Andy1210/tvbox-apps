import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useBackspace, useI18n } from "@sdk";
import { useFocusFallback, useInitialFocus } from "./focus";
import { usePrefs } from "./prefs";

/**
 * Subtitle appearance and what to do about markers.
 *
 * A panel showing every option at once, rather than buttons that cycle. Cycling
 * fits a settings LIST, where each row is one line and the value is a word - but
 * subtitle size is a thing you compare, and a control that reveals its choices
 * one press at a time hides how many there are and offers no way back past the
 * one you wanted.
 */
export function PlaybackSettings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const p = usePrefs();

  const { ref, focusKey } = useFocusable({
    focusKey: "playbackset",
    saveLastFocusedChild: true,
    isFocusBoundary: true,
  });
  useInitialFocus("ps-size-1", true);
  useFocusFallback("ps-close", (k) => k.startsWith("ps-"), true);
  useBackspace(onClose, true);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="absolute inset-0 z-40 flex items-center justify-center bg-black/80">
        <div className="flex h-[80vh] w-[86vw] flex-col gap-[2vh] overflow-hidden rounded-[1.4vh] bg-[#0c1219]/97 p-[3vh]">
          <div className="flex items-center justify-between">
            <h2 className="text-[2.6vh] font-semibold tracking-tight">{t("settings.playback")}</h2>
            <FocusButton
              focusKey="ps-close"
              onEnter={onClose}
              className="rounded-[1vh] bg-white/10 px-[2vw] py-[1vh] text-[2vh]"
            >
              {t("common.done")}
            </FocusButton>
          </div>

          <div className="no-scrollbar flex flex-col gap-[2.6vh] overflow-y-auto">
            <Group title={t("settings.subSize")}>
              {[0.8, 1, 1.25, 1.5, 2].map((v, i) => (
                <Choice
                  key={v}
                  focusKey={`ps-size-${i}`}
                  active={p.subScale === v}
                  onEnter={() => void p.set("subScale", v)}
                >
                  {/* Each option previews itself at its own size, so the choice
                      is made by looking rather than by reading a percentage. */}
                  <span style={{ fontSize: `${v * 2.2}vh` }}>{t("settings.subSample")}</span>
                </Choice>
              ))}
            </Group>

            <Group title={t("settings.subPos")}>
              {[
                { v: 100, key: "settings.posBottom" },
                { v: 90, key: "settings.posHigher" },
                { v: 80, key: "settings.posHigh" },
                { v: 70, key: "settings.posMiddle" },
              ].map((o, i) => (
                <Choice
                  key={o.v}
                  focusKey={`ps-pos-${i}`}
                  active={p.subPos === o.v}
                  onEnter={() => void p.set("subPos", o.v)}
                >
                  {t(o.key)}
                </Choice>
              ))}
            </Group>

            <Group title={t("settings.subColor")}>
              {["#ffffff", "#ffe680", "#c8c8c8"].map((v, i) => (
                <Choice
                  key={v}
                  focusKey={`ps-col-${i}`}
                  active={p.subColor === v}
                  onEnter={() => void p.set("subColor", v)}
                >
                  {/* The sample carries the colour AND names it: a swatch alone
                      is a few arc-minutes at three metres, and two of these are
                      pale enough to be told apart only side by side. */}
                  <span style={{ color: v }}>{t("settings.subSample")}</span>
                </Choice>
              ))}
            </Group>

            <Group title={t("settings.autoSkip")} note={t("settings.autoSkipHint")}>
              <Choice focusKey="ps-skip-off" active={!p.autoSkip} onEnter={() => void p.set("autoSkip", false)}>
                {t("settings.off")}
              </Choice>
              <Choice focusKey="ps-skip-on" active={p.autoSkip} onEnter={() => void p.set("autoSkip", true)}>
                {t("settings.on")}
              </Choice>
            </Group>
          </div>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

function Group({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-[1vh]">
      <h3 className="text-[2.2vh] font-semibold text-fg-dim">{title}</h3>
      {note && <p className="max-w-[70vw] text-[1.9vh] text-fg-dim">{note}</p>}
      <div className="flex flex-wrap items-center gap-[1vw]">{children}</div>
    </section>
  );
}

/** Fill means focused; the check means chosen. Same rule as everywhere else. */
function Choice({
  focusKey,
  active,
  onEnter,
  children,
}: {
  focusKey: string;
  active: boolean;
  onEnter: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <FocusButton
      focusKey={focusKey}
      onEnter={onEnter}
      className="flex min-h-[7vh] items-center rounded-[0.8vh] bg-white/8 px-[1.6vw] py-[1vh] text-[2.1vh]"
    >
      <span className="inline-block w-[1.6vw] shrink-0 text-center">{active ? "✓" : ""}</span>
      {children}
    </FocusButton>
  );
}
