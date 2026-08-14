import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useBackspace, useI18n } from "@sdk";
import { useFocusFallback, useInitialFocus } from "./focus";
import { usePrefs, type HomeRowId } from "./prefs";

/**
 * Row id to its locale key, spelled out.
 *
 * Not built with a template: the locale-usage test reads the source for `t()`
 * calls, and an interpolated key is invisible to it - which is how a set of
 * hardcoded English strings got shipped once already.
 */
const ROW_LABEL: Record<HomeRowId, string> = {
  ondeck: "home.row.ondeck",
  recent: "home.row.recent",
  playlists: "home.row.playlists",
};

/**
 * Which rows the home screen has, in which order.
 *
 * Every household fills this screen differently: one has nothing but films and
 * wants what it was watching first, another keeps a playlist it starts every
 * evening. Rather than guess, the order is theirs - and a row nobody uses can
 * be taken off entirely, which is the part a default order cannot express.
 *
 * The library rows are a single entry, not one per library: a household adds a
 * library rarely and would then find an unordered newcomer with no obvious
 * place, which is a worse answer than "the libraries, together, here".
 */
export function HomeRows({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const rows = usePrefs((s) => s.homeRows);
  const hidden = usePrefs((s) => s.hiddenRows);
  const set = usePrefs((s) => s.set);

  const { ref, focusKey } = useFocusable({ focusKey: "homerows", saveLastFocusedChild: true, isFocusBoundary: true });
  useInitialFocus("hr-0-up", true);
  useFocusFallback("hr-close", (k) => k.startsWith("hr-"), true);
  useBackspace(onClose, true);

  const move = (i: number, by: number): void => {
    const to = i + by;
    if (to < 0 || to >= rows.length) return;
    const next = [...rows];
    [next[i], next[to]] = [next[to], next[i]];
    void set("homeRows", next);
  };

  const toggle = (id: HomeRowId): void => {
    void set("hiddenRows", hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id]);
  };

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="absolute inset-0 z-40 flex items-center justify-center bg-black/80">
        <div className="flex h-[80vh] w-[76vw] flex-col gap-[2vh] overflow-hidden rounded-[1.4vh] bg-[#0c1219]/97 p-[3vh]">
          <div className="flex items-center justify-between">
            <h2 className="text-[2.6vh] font-semibold tracking-tight">{t("settings.homeRows")}</h2>
            <FocusButton
              focusKey="hr-close"
              onEnter={onClose}
              className="rounded-[1vh] bg-white/10 px-[2vw] py-[1vh] text-[2vh]"
            >
              {t("common.done")}
            </FocusButton>
          </div>

          <div className="no-scrollbar flex flex-col gap-[1vh] overflow-y-auto">
            {rows.map((id, i) => {
              const off = hidden.includes(id);
              return (
                <div key={id} className="flex items-center gap-[1vw] rounded-[0.8vh] bg-white/5 px-[1.6vw] py-[1.2vh]">
                  <span className={`flex-1 text-[2.2vh] ${off ? "text-fg-dim line-through" : ""}`}>
                    {t(ROW_LABEL[id])}
                  </span>
                  {/* Up, down and a visibility toggle per row, each its own
                      focusable: a D-pad has no drag, so moving something is
                      pressing the direction you want it to go. */}
                  <FocusButton
                    focusKey={`hr-${i}-up`}
                    label={t("settings.moveUp")}
                    onEnter={() => move(i, -1)}
                    className={`rounded-[0.6vh] bg-white/10 px-[1.2vw] py-[0.7vh] text-[2vh] ${
                      i === 0 ? "opacity-30" : ""
                    }`}
                  >
                    {"↑"}
                  </FocusButton>
                  <FocusButton
                    focusKey={`hr-${i}-down`}
                    label={t("settings.moveDown")}
                    onEnter={() => move(i, 1)}
                    className={`rounded-[0.6vh] bg-white/10 px-[1.2vw] py-[0.7vh] text-[2vh] ${
                      i === rows.length - 1 ? "opacity-30" : ""
                    }`}
                  >
                    {"↓"}
                  </FocusButton>
                  <FocusButton
                    focusKey={`hr-${i}-hide`}
                    onEnter={() => toggle(id)}
                    className="rounded-[0.6vh] bg-white/10 px-[1.4vw] py-[0.7vh] text-[2vh]"
                  >
                    {t(off ? "settings.rowHidden" : "settings.rowShown")}
                  </FocusButton>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </FocusContext.Provider>
  );
}
