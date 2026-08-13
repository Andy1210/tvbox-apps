import { FocusButton, useI18n } from "@sdk";
import { useInitialFocus } from "./focus";
import { useApp, type Failure } from "./state";

export interface MessageAction {
  key: string;
  label: string;
  onEnter: () => void;
}

export interface MessageProps {
  loading?: boolean;
  text?: string;
  failure?: Failure;
  /** Extra controls beyond the ones a failure implies. */
  actions?: MessageAction[];
  /** Retry the thing that failed. Rendered for the failures where it helps. */
  onRetry?: () => void;
}

/**
 * Anything that is not content: loading, empty, and the ways a server can let
 * the app down.
 *
 * There is one of these rather than a spinner in each screen because the app is
 * the only thing on the television. "Nothing happened" with no explanation is
 * indistinguishable from a broken box, and nobody is going to open a console.
 *
 * Every failure that a person can act on carries a button, and one of them takes
 * focus. A screen that says "sign in again" beside no way to sign in is worse
 * than saying nothing: the remote has nowhere to go, Back returns to a screen
 * that immediately fails the same way, and the only recourse left is
 * reinstalling the app.
 */
export function Message({ loading, text, failure, actions, onRetry }: MessageProps): React.JSX.Element {
  const { t } = useI18n();
  const signOut = useApp((s) => s.signOut);

  const body = failure
    ? t(
        failure.kind === "unreachable"
          ? "error.unreachable"
          : failure.kind === "signed-out"
            ? "error.signedOut"
            : failure.kind === "no-server"
              ? "error.noServer"
              : "error.unknown",
      )
    : (text ?? t("common.loading"));

  const buttons: MessageAction[] = [
    ...(failure?.kind === "signed-out"
      ? [{ key: "msg-signin", label: t("error.signInAgain"), onEnter: () => void signOut() }]
      : []),
    ...(onRetry && failure?.kind !== "signed-out" ? [{ key: "msg-retry", label: t("error.retry"), onEnter: onRetry }] : []),
    ...(actions ?? []),
  ];

  useInitialFocus(buttons[0]?.key, buttons.length > 0);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-[2vh] px-[10vw] text-center">
      {loading && (
        <svg
          viewBox="0 0 24 24"
          className="h-[4vh] w-[4vh] animate-spin"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
        </svg>
      )}

      <p className="text-[2.2vh] text-fg-dim">{body}</p>
      {failure?.detail && <p className="max-w-[60vw] text-[1.7vh] text-fg-dim">{failure.detail}</p>}

      {buttons.length > 0 && (
        <div className="mt-[1vh] flex gap-[1.2vw]">
          {buttons.map((b) => (
            <FocusButton
              key={b.key}
              focusKey={b.key}
              onEnter={b.onEnter}
              className="rounded-[1vh] bg-white/12 px-[2.4vw] py-[1.3vh] text-[2vh]"
            >
              {b.label}
            </FocusButton>
          ))}
        </div>
      )}
    </div>
  );
}
