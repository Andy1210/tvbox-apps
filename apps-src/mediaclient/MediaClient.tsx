import { FocusButton, useBackspace, useI18n } from "@sdk";

export interface MediaClientProps {
  /** Leave the app and return to the launcher. */
  onExit: () => void;
}

/**
 * Root of the media client.
 *
 * Skeleton: it renders, takes focus, and leaves on Back. The player stage is
 * already here because the shell reveals mpv by making this page transparent,
 * and the node it makes transparent is named in the manifest
 * (`transparentSelector`) - so the id has to exist from the first build or the
 * reveal has nothing to act on.
 */
export function MediaClient({ onExit }: MediaClientProps): React.JSX.Element {
  const { t } = useI18n();

  // Back leaves the app. The remote's Back arrives as any of several keys
  // depending on how the shell synthesised it, which is what useBackspace knows.
  useBackspace(onExit);

  return (
    <div className="flex h-full flex-col">
      {/* The film plays behind this element; it must not paint over it. */}
      <div id="player-stage" className="pointer-events-none absolute inset-0" />

      <main className="relative flex flex-1 flex-col items-center justify-center gap-[3vh] px-[6vw]">
        <h1 className="text-[4vh] font-semibold tracking-tight">{t("app.name")}</h1>
        <p className="max-w-[60vw] text-center text-[2.2vh] text-fg-dim">{t("app.empty")}</p>
        <FocusButton focusKey="exit" onEnter={onExit}>
          {t("app.back")}
        </FocusButton>
      </main>
    </div>
  );
}
