import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useBackspace, useI18n } from "@sdk";
import { useFocusFallback, useInitialFocus } from "./focus";

/**
 * A question in front of an action that cannot be taken back.
 *
 * The only one in this app, and it earns its place: every other control here
 * moves one item, while marking a season moves every episode in it at once -
 * and on the server that is lossy, because a scrobble clears each episode's
 * resume point. From the sofa the button sits one press right of Play, which is
 * where a film screen puts "mark this watched", so the gesture that means one
 * thing on one screen meant twenty on another.
 *
 * The safe answer takes the focus, and that is the whole design rather than
 * politeness: a remote repeats and it bounces, so the press that opens this can
 * arrive again by itself - measured on the box, twice within 180 ms. Landing on
 * "no" means a doubled press cancels, and a held button cancels.
 */
export function Confirm({
  title,
  detail,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  detail?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "confirm", saveLastFocusedChild: true, isFocusBoundary: true });
  useInitialFocus("confirm-no", true);
  useFocusFallback("confirm-no", (k) => k.startsWith("confirm-"), true);
  useBackspace(onClose, true);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="absolute inset-0 z-40 flex items-center justify-center bg-black/80">
        <div className="flex w-[60vw] flex-col gap-[2vh] rounded-[1.4vh] bg-[#0c1219]/97 p-[3vh]">
          <h2 className="text-[2.6vh] font-semibold tracking-tight">{title}</h2>
          {detail ? <p className="text-[2vh] text-fg-dim">{detail}</p> : null}
          {/* "No" first, so it is both the focused answer and the one the eye
              reaches first reading left to right. */}
          <div className="mt-[1vh] flex gap-[1.2vw]">
            <FocusButton
              focusKey="confirm-no"
              onEnter={onClose}
              className="rounded-[1vh] bg-white/10 px-[2.4vw] py-[1.4vh] text-[2.1vh]"
            >
              {t("common.cancel")}
            </FocusButton>
            <FocusButton
              focusKey="confirm-yes"
              onEnter={onConfirm}
              className="rounded-[1vh] bg-white/10 px-[2.4vw] py-[1.4vh] text-[2.1vh]"
            >
              {confirmLabel}
            </FocusButton>
          </div>
        </div>
      </div>
    </FocusContext.Provider>
  );
}
