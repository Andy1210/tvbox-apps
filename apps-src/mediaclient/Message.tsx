import { useI18n } from "@sdk";
import type { Failure } from "./state";

export interface MessageProps {
  loading?: boolean;
  text?: string;
  failure?: Failure;
}

/**
 * Anything that is not content: loading, empty, and the ways a server can let
 * the app down.
 *
 * There is one of these rather than a spinner in each screen because the app is
 * the only thing on the television. "Nothing happened" with no explanation is
 * indistinguishable from a broken box, and nobody is going to open a console.
 */
export function Message({ loading, text, failure }: MessageProps): React.JSX.Element {
  const { t } = useI18n();

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

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-[1.6vh] px-[10vw] text-center">
      {loading && (
        <svg viewBox="0 0 24 24" className="h-[4vh] w-[4vh] animate-spin" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
        </svg>
      )}
      <p className="text-[2.2vh] text-fg-dim">{body}</p>
      {failure?.detail && <p className="text-[1.6vh] text-fg-dim/60">{failure.detail}</p>}
    </div>
  );
}
