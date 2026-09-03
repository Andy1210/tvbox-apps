import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useBackspace, useI18n } from "@sdk";
import { useFocusFallback, useInitialFocus } from "./focus";

export interface MoreItem {
  /** Unique within the menu; the focus key is this, prefixed. */
  key: string;
  label: string;
  onEnter: () => void;
}

const itemKey = (key: string): string => `more-${key}`;

/**
 * The actions that are not worth a button.
 *
 * Audio and subtitles are chosen once for a film, if at all, and a whole season
 * is marked by hand only when it was watched on somebody else's television.
 * Both had a button of their own on every screen, and between them they cost
 * the synopsis its place on a season screen - which is read on every episode.
 *
 * A list rather than a row: these are read before they are pressed, and the
 * count is small enough that Down through them is one press each.
 */
export function MoreMenu({
  items,
  onClose,
}: {
  items: MoreItem[];
  onClose: () => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "more", saveLastFocusedChild: true, isFocusBoundary: true });
  const first = items[0] ? itemKey(items[0].key) : "more-close";
  useInitialFocus(first, true);
  useFocusFallback(first, (k) => k.startsWith("more-"), true);
  useBackspace(onClose, true);

  if (items.length === 0) return null;

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="absolute inset-0 z-40 flex items-center justify-center bg-black/80">
        <div className="flex w-[52vw] flex-col gap-[1.6vh] rounded-[1.4vh] bg-[#0c1219]/97 p-[3vh]">
          <h2 className="text-[2.6vh] font-semibold tracking-tight">{t("detail.more")}</h2>
          <div className="flex flex-col gap-[1vh]">
            {items.map((item) => (
              <FocusButton
                key={item.key}
                focusKey={itemKey(item.key)}
                onEnter={item.onEnter}
                className="rounded-[1vh] bg-white/10 px-[2vw] py-[1.4vh] text-left text-[2.1vh]"
              >
                {item.label}
              </FocusButton>
            ))}
          </div>
          {/* A way out that is visible, not only remembered. Back closes this
              too, but a menu whose only exit is a key nobody pressed to get in
              is one people leave by pressing something. */}
          <FocusButton
            focusKey="more-close"
            onEnter={onClose}
            className="mt-[0.6vh] self-start rounded-[1vh] bg-white/10 px-[2vw] py-[1vh] text-[2vh]"
          >
            {t("tracks.close")}
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}
