import { useCallback, useEffect, useRef, useState } from "react";
import { FocusButton, useBackspace, useI18n } from "@sdk";
import { doesFocusableExist, getCurrentFocusKey, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import * as api from "./api";
import { errorText } from "./errors";

// What this client can decide for itself.
//
// It is a short list on purpose. Most of what a settings screen would like to
// offer is not ours: the account is told `allowRegionSelection: false` and the
// offering lists no selectable server types, so the region and the server are
// Microsoft's choice - measured on this account rather than assumed. What is left
// is what we put in the SDP offer and in the session request, plus the catalogue
// this box keeps for itself.
//
// A choice is applied the moment it is pressed and saved by the plugin. There is
// no OK button: a settings screen with one is a screen you can leave in a state
// the box does not have.
export function Settings({ status, onClose, onSignedOut, onRefreshed }: {
  status: api.Status | null;
  onClose: () => void;
  onSignedOut: () => void;
  onRefreshed: () => void;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState<api.SettingsValues | null>(null);
  // A COUNT, not a flag: two chips pressed in quick succession are two writes, and
  // whichever answered first used to clear the "…" while the other was still out.
  const [busy, setBusy] = useState(0);
  const [refreshed, setRefreshed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Writes are chained rather than fired in parallel: two chips pressed quickly
  // are two PUTs of the whole document, and the one that ANSWERS last wins - so
  // the older answer could put the first choice back. Chaining also means the
  // second write is built on a settings object the box has already accepted.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    void api
      .getSettings()
      .then((r) => setValues(r.settings))
      .catch((e) => setError(errorText(t, (e as api.ApiError).code)));
  }, [t]);

  // ONCE, when the settings first arrive. Every pick replaces `values`, so a
  // dependency on it sent the focus back to the top row after each press - two
  // choices in a row meant scrolling back down through the whole panel.
  const focused = useRef(false);
  useEffect(() => {
    if (!values || focused.current) return;
    focused.current = true;
    const id = setTimeout(() => setFocus("set-quality-0"), 0);
    return () => clearTimeout(id);
  }, [values]);

  // Back closes the panel, as it does everywhere else on the box.
  useBackspace(onClose);

  // Up and Down move ROW BY ROW here, rather than by geometry.
  //
  // The rows hold 5, 3, 2 and 5 chips and nothing lines them up, so norigin picks
  // the nearest focusable below by distance and that is regularly not the next
  // row: measured, Down from "5 Mbps" (the 5th chip of the first row) landed in
  // "Game language" - skipping Resolution and Sound, both on screen - and Down
  // from "720p" skipped Sound. A settings screen where a whole setting can only be
  // reached from some columns is one where you do not know what you have missed.
  //
  // The column is carried across and clamped, which is what a person expects from
  // a grid of chips, and the button row at the bottom is just the last row.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const at = getCurrentFocusKey();
      if (!at) return;
      const here = SETTINGS_ROWS.findIndex((r) => r.includes(at));
      if (here < 0) return; // not one of ours - the notice screens have one button
      // The panel is modal, so there is nothing above the first row or below the
      // last. Swallowed rather than passed on: left to norigin the press moves by
      // geometry instead, which on a wrapped row of chips means sideways.
      e.preventDefault();
      e.stopImmediatePropagation();
      const next = SETTINGS_ROWS[here + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      const col = Math.min(SETTINGS_ROWS[here].indexOf(at), next.length - 1);
      const target = next[col];
      if (doesFocusableExist(target)) setFocus(target);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const put = useCallback((patch: Partial<api.SettingsValues>) => {
    setBusy((n) => n + 1);
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        try {
          const r = await api.putSettings(patch);
          setValues(r.settings);
          setError(null);
        } catch (e) {
          // The plugin names the key it refused, which beats "could not save" - but
          // it is our own message about our own field, so it is bounded before it
          // goes on a television.
          setError(String((e as api.ApiError).message || e).slice(0, 200));
        }
      })
      .finally(() => setBusy((n) => n - 1));
  }, []);

  // Both of these used to be a card with no focusable and no Back: the panel
  // stayed up and the remote did nothing at all. And the loading one said
  // "loading the catalogue" while it was loading settings.
  if (error && !values) return <Notice onClose={onClose} label={t("settings.close")} tone="warn">{error}</Notice>;
  if (!values) return <Notice onClose={onClose} label={t("settings.close")}>{t("settings.loading")}</Notice>;

  return (
    <Panel>
      <h2 className="mb-[2vh] text-[2.8vh] font-semibold">{t("settings.title")}</h2>

      <Choice
        id="quality"
        label={t("settings.quality")}
        hint={t("settings.qualityHint")}
        value={values.maxVideoKbps}
        options={[
          { value: 0, label: t("settings.auto") },
          { value: 30000, label: "30 Mbps" },
          { value: 20000, label: "20 Mbps" },
          { value: 10000, label: "10 Mbps" },
          { value: 5000, label: "5 Mbps" },
        ]}
        onPick={(v) => put({ maxVideoKbps: v as number })}
      />

      <Choice
        id="height"
        label={t("settings.resolution")}
        hint={t("settings.resolutionHint")}
        value={values.maxHeight}
        options={[
          { value: 0, label: t("settings.screen") },
          { value: 1080, label: "1080p" },
          { value: 720, label: "720p" },
        ]}
        onPick={(v) => put({ maxHeight: v as number })}
      />

      <Choice
        id="sound"
        label={t("settings.sound")}
        value={values.stereo ? 1 : 0}
        options={[
          { value: 1, label: t("settings.stereo") },
          { value: 0, label: t("settings.mono") },
        ]}
        onPick={(v) => put({ stereo: v === 1 })}
      />

      <Choice
        id="lang"
        label={t("settings.gameLanguage")}
        hint={t("settings.gameLanguageHint")}
        value={values.gameLocale}
        options={[
          { value: "", label: t("settings.followBox") },
          { value: "hu-HU", label: "Magyar" },
          { value: "en-US", label: "English (US)" },
          { value: "en-GB", label: "English (UK)" },
          { value: "de-DE", label: "Deutsch" },
        ]}
        onPick={(v) => put({ gameLocale: v as string })}
      />

      {error && <p className="mb-[1vh] text-[1.9vh] text-warn">{error}</p>}

      <div className="mt-[2vh] flex flex-wrap items-center gap-4">
        <FocusButton
          focusKey="set-refresh"
          className="rounded-xl bg-bg-1 px-8 py-3 text-[1.9vh]"
          onEnter={() => {
            setBusy((n) => n + 1);
            void api
              .refreshLibrary()
              .then(() => {
                setRefreshed(true);
                onRefreshed();
                // Back to "Refresh" after a moment: a button permanently reading
                // "Refreshed" says nothing about the press you just made.
                setTimeout(() => setRefreshed(false), 4000);
              })
              .catch(() => setError(t("errors.generic")))
              .finally(() => setBusy((n) => n - 1));
          }}
        >
          {refreshed ? t("settings.refreshed") : t("settings.refresh")}
        </FocusButton>
        <FocusButton
          focusKey="set-signout"
          className="rounded-xl bg-bg-1 px-8 py-3 text-[1.9vh]"
          onEnter={() =>
            void api
              .signOut()
              .then(onSignedOut)
              .catch((e) => setError(errorText(t, (e as api.ApiError).code)))
          }
        >
          {t("library.signOut")}
        </FocusButton>
        <FocusButton
          focusKey="set-close"
          className="rounded-xl bg-bg-0 px-8 py-3 text-[1.9vh] ring-1 ring-fg-dim/50"
          onEnter={onClose}
        >
          {t("settings.close")}
        </FocusButton>
        {busy > 0 && <span className="text-[1.7vh] text-fg-dim">…</span>}
      </div>

      {/* What the account is, which is the other thing anyone opens a settings
          screen for. Read-only: none of it is ours to change. */}
      {status?.signedIn && (
        <p className="mt-[2.5vh] text-[1.7vh] text-fg-dim">
          {[status.gamertag, status.market, offeringName(status.offering, t)].filter(Boolean).join(" · ")}
        </p>
      )}
    </Panel>
  );
}

// The panel's rows, in the order the D-pad walks them. Kept beside the markup
// rather than derived from it: deriving would mean reading the DOM, and the
// question is which row a KEY belongs to, which the markup answers only by
// position on screen - the very thing that was wrong.
export const SETTINGS_ROWS: string[][] = [
  ["set-quality-0", "set-quality-1", "set-quality-2", "set-quality-3", "set-quality-4"],
  ["set-height-0", "set-height-1", "set-height-2"],
  ["set-sound-0", "set-sound-1"],
  ["set-lang-0", "set-lang-1", "set-lang-2", "set-lang-3", "set-lang-4"],
  ["set-refresh", "set-signout", "set-close"],
];

// `xgpuweb` is Microsoft's own id for the offering and means nothing to anyone
// reading it off a television; what it actually says is which subscription this
// account streams under.
function offeringName(offering: string | undefined, t: (k: string) => string): string {
  if (offering === "xgpuweb") return t("settings.ultimate");
  if (offering === "xgpuwebf2p") return t("settings.freeToPlay");
  // An id we have no name for is Microsoft's internal string, so it says nothing
  // to the person reading it - better one fewer item on the line than "xgpuwebXYZ".
  return "";
}

function Notice({
  children,
  onClose,
  label,
  tone,
}: {
  children: React.ReactNode;
  onClose: () => void;
  label: string;
  tone?: "warn";
}) {
  useEffect(() => {
    const id = setTimeout(() => setFocus("set-notice-close"), 0);
    return () => clearTimeout(id);
  }, []);
  useBackspace(onClose);
  return (
    <Panel>
      <p className={"mb-[3vh] text-[2.2vh] " + (tone === "warn" ? "text-warn" : "text-fg-dim")}>{children}</p>
      <FocusButton
        focusKey="set-notice-close"
        className="rounded-xl bg-bg-0 px-8 py-3 text-[1.9vh] ring-1 ring-fg-dim/50"
        onEnter={onClose}
      >
        {label}
      </FocusButton>
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-bg-0/95 p-[4vw]">
      <div className="max-h-full w-[64vw] overflow-hidden rounded-2xl bg-bg-1 p-[3vw] text-fg">{children}</div>
    </div>
  );
}

function Choice<T extends string | number>({
  id,
  label,
  hint,
  value,
  options,
  onPick,
}: {
  id: string;
  label: string;
  hint?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onPick: (v: T) => void;
}) {
  return (
    <div className="mb-[2vh]">
      <div className="mb-[0.8vh] flex items-baseline gap-4">
        <span className="text-[2.2vh]">{label}</span>
        {hint && <span className="text-[1.7vh] text-fg-dim">{hint}</span>}
      </div>
      <div className="flex flex-wrap gap-3">
        {options.map((o, i) => (
          <FocusButton
            key={String(o.value)}
            focusKey={`set-${id}-${i}`}
            // The chosen one has to stay readable when it is NOT focused, so it
            // is marked by its fill rather than by the focus ring.
            // The chosen one has to stay legible when it is NOT focused, so it is
            // marked by its fill. Accent green rather than white: white IS the
            // focus fill (FocusButton), and four white pills plus a fifth that is
            // 4% larger is not a cursor anybody finds from a sofa. Green means
            // "this is the one that is set" here and on the library's genre chips,
            // and nothing else in the app uses it.
            className={
              "rounded-full px-6 py-2 text-[1.9vh] " +
              (o.value === value ? "bg-accent text-fg font-semibold" : "bg-bg-0 text-fg-dim")
            }
            onEnter={() => onPick(o.value)}
          >
            {o.label}
          </FocusButton>
        ))}
      </div>
    </div>
  );
}
