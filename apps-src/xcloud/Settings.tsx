import { useCallback, useEffect, useState } from "react";
import { FocusButton, useI18n } from "@sdk";
import { setFocus } from "@noriginmedia/norigin-spatial-navigation";
import * as api from "./api";

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
export function Settings({ status, onClose, onSignedOut }: {
  status: api.Status | null;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState<api.SettingsValues | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .getSettings()
      .then((r) => setValues(r.settings))
      .catch(() => setError(t("errors.generic")));
  }, [t]);

  useEffect(() => {
    if (!values) return;
    const id = setTimeout(() => setFocus("set-quality-0"), 0);
    return () => clearTimeout(id);
  }, [values]);

  const put = useCallback(
    async (patch: Partial<api.SettingsValues>) => {
      setBusy(true);
      try {
        const r = await api.putSettings(patch);
        setValues(r.settings);
        setError(null);
      } catch (e) {
        // The plugin names the key it refused, which beats "could not save" - but
        // it is our own message about our own field, so it is bounded before it
        // goes on a television.
        setError(String((e as api.ApiError).message || e).slice(0, 200));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  if (error && !values) return <Panel><p className="text-2xl text-warn">{error}</p></Panel>;
  if (!values) return <Panel><p className="text-2xl text-fg-dim">{t("library.loading")}</p></Panel>;

  return (
    <Panel>
      <h2 className="mb-[2vh] text-3xl font-semibold">{t("settings.title")}</h2>

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
        onPick={(v) => void put({ maxVideoKbps: v as number })}
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
        onPick={(v) => void put({ maxHeight: v as number })}
      />

      <Choice
        id="sound"
        label={t("settings.sound")}
        value={values.stereo ? 1 : 0}
        options={[
          { value: 1, label: t("settings.stereo") },
          { value: 0, label: t("settings.mono") },
        ]}
        onPick={(v) => void put({ stereo: v === 1 })}
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
        onPick={(v) => void put({ gameLocale: v as string })}
      />

      {error && <p className="mb-[1vh] text-xl text-warn">{error}</p>}

      <div className="mt-[2vh] flex flex-wrap items-center gap-4">
        <FocusButton
          focusKey="set-refresh"
          className="rounded-xl bg-bg-1 px-8 py-3 text-xl"
          onEnter={() =>
            void api.refreshLibrary().then(() => setRefreshed(true)).catch(() => setError(t("errors.generic")))
          }
        >
          {refreshed ? t("settings.refreshed") : t("settings.refresh")}
        </FocusButton>
        <FocusButton
          focusKey="set-signout"
          className="rounded-xl bg-bg-1 px-8 py-3 text-xl"
          onEnter={() => void api.signOut().then(onSignedOut)}
        >
          {t("library.signOut")}
        </FocusButton>
        <FocusButton focusKey="set-close" className="rounded-xl bg-accent px-8 py-3 text-xl" onEnter={onClose}>
          {t("settings.close")}
        </FocusButton>
        {busy && <span className="text-lg text-fg-dim">…</span>}
      </div>

      {/* What the account is, which is the other thing anyone opens a settings
          screen for. Read-only: none of it is ours to change. */}
      {status?.signedIn && (
        <p className="mt-[2.5vh] text-lg text-fg-dim">
          {[status.gamertag, status.market, status.region, offeringName(status.offering, t)]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
    </Panel>
  );
}

// `xgpuweb` is Microsoft's own id for the offering and means nothing to anyone
// reading it off a television; what it actually says is which subscription this
// account streams under.
function offeringName(offering: string | undefined, t: (k: string) => string): string {
  if (offering === "xgpuweb") return t("settings.ultimate");
  if (offering === "xgpuwebf2p") return t("settings.freeToPlay");
  return offering || "";
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
        <span className="text-2xl">{label}</span>
        {hint && <span className="text-lg text-fg-dim">{hint}</span>}
      </div>
      <div className="flex flex-wrap gap-3">
        {options.map((o, i) => (
          <FocusButton
            key={String(o.value)}
            focusKey={`set-${id}-${i}`}
            // The chosen one has to stay readable when it is NOT focused, so it
            // is marked by its fill rather than by the focus ring.
            className={
              "rounded-full px-6 py-2 text-xl " +
              (o.value === value ? "bg-accent text-fg" : "bg-bg-0 text-fg-dim")
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
