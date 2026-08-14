import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useI18n } from "@sdk";
import { useInitialFocus } from "./focus";
import { useApp } from "./state";
import { usePrefs, type Prefs } from "./prefs";

/**
 * Which server, which account, and how to leave.
 *
 * Small on purpose. What it has to answer is the question a household with
 * several people on one server actually asks - whose library am I looking at -
 * and the one thing that was previously impossible from the remote: signing out.
 * Without that, a rejected token left the app with no way forward at all.
 */
export function Settings(): React.JSX.Element {
  const { t } = useI18n();
  const session = useApp((s) => s.session);
  const signOut = useApp((s) => s.signOut);
  const autologin = useApp((s) => s.autologin);
  const setAutologin = useApp((s) => s.setAutologin);
  const go = useApp((s) => s.go);

  const { ref, focusKey } = useFocusable({ focusKey: "settings", saveLastFocusedChild: true });
  // The setting someone came here to change, not the one that logs them out.
  useInitialFocus("settings-autologin", true);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="flex h-full flex-col gap-[3vh] px-[6vw] py-[5vh]">
        <h1 className="text-[3vh] font-semibold tracking-tight">{t("settings.title")}</h1>

        <dl className="flex flex-col gap-[1.4vh] text-[2vh]">
          <Field label={t("settings.server")} value={session?.serverName || "—"} />
          <Field
            label={t("settings.connection")}
            // Worth surfacing: reached from outside, a server caps the bitrate,
            // and the picture is worse for a reason nobody can see otherwise.
            value={t(session?.location === "wan" ? "settings.remote" : "settings.local")}
          />
          <Field label={t("settings.profile")} value={session?.profileName || t("settings.owner")} />
        </dl>

        <div className="flex flex-col gap-[1vh]">
          <FocusButton
            focusKey="settings-autologin"
            onEnter={() => void setAutologin(!autologin)}
            className="self-start rounded-[1vh] bg-white/12 px-[2.4vw] py-[1.3vh] text-[2.1vh]"
          >
            {`${t("settings.autologin")} · ${t(autologin ? "settings.on" : "settings.off")}`}
          </FocusButton>
          {/* Says what the setting DOES rather than restating its name: "on"
              alone does not tell anyone which of the five people it will pick. */}
          <p className="max-w-[60vw] text-[1.7vh] text-fg-dim">
            {autologin
              ? t("settings.autologinOnHint", { who: session?.profileName || t("settings.owner") })
              : t("settings.autologinOffHint")}
          </p>
        </div>

        <Playback />

        <div className="mt-[2vh] flex gap-[1.2vw]">
          <FocusButton
            focusKey="settings-switch"
            onEnter={() => go({ name: "profiles" })}
            className="rounded-[1vh] bg-white/12 px-[2.4vw] py-[1.4vh] text-[2.1vh]"
          >
            {t("settings.switchUser")}
          </FocusButton>
          <FocusButton
            focusKey="settings-signout"
            onEnter={() => void signOut()}
            className="rounded-[1vh] bg-white/12 px-[2.4vw] py-[1.4vh] text-[2.1vh]"
          >
            {t("settings.signOut")}
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex gap-[1.4vw]">
      <dt className="w-[18vw] text-fg-dim">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * How playback looks and behaves, as opposed to who is watching.
 *
 * Each row cycles through a short list rather than offering a slider: a D-pad
 * has no gesture for a continuous value, and three or four steps is all anyone
 * adjusts subtitle size by.
 */
function Playback(): React.JSX.Element {
  const { t } = useI18n();
  const p = usePrefs();

  const cycle = <K extends "subScale" | "subPos" | "subColor">(key: K, steps: Prefs[K][]): void => {
    const i = steps.findIndex((v) => v === p[key]);
    void p.set(key, steps[(i + 1) % steps.length]);
  };

  const row = "rounded-[1vh] bg-white/12 px-[2.4vw] py-[1.3vh] text-[2.1vh]";

  return (
    <div className="flex flex-col gap-[1vh]">
      <h2 className="text-[2.3vh] font-semibold tracking-tight text-fg-dim">{t("settings.playback")}</h2>
      <div className="flex flex-wrap gap-[1vw]">
        <FocusButton
          focusKey="settings-subscale"
          onEnter={() => cycle("subScale", [0.8, 1, 1.25, 1.5, 2])}
          className={row}
        >
          {`${t("settings.subSize")} · ${Math.round(p.subScale * 100)}%`}
        </FocusButton>
        <FocusButton focusKey="settings-subpos" onEnter={() => cycle("subPos", [100, 90, 80, 70])} className={row}>
          {`${t("settings.subPos")} · ${p.subPos}`}
        </FocusButton>
        <FocusButton
          focusKey="settings-subcolor"
          onEnter={() => cycle("subColor", ["#ffffff", "#ffe680", "#c8c8c8"])}
          className={row}
        >
          <span
            className="mr-[0.6vw] inline-block h-[1.6vh] w-[1.6vh] rounded-full align-middle"
            style={{ background: p.subColor }}
          />
          {t("settings.subColor")}
        </FocusButton>
        <FocusButton focusKey="settings-autoskip" onEnter={() => void p.set("autoSkip", !p.autoSkip)} className={row}>
          {`${t("settings.autoSkip")} · ${t(p.autoSkip ? "settings.on" : "settings.off")}`}
        </FocusButton>
      </div>
      {/* Says what it costs, because the failure is silent and looks like a bug:
          a marker that is a minute out jumps past the opening of an episode. */}
      <p className="max-w-[60vw] text-[1.9vh] text-fg-dim">{t("settings.autoSkipHint")}</p>
    </div>
  );
}
