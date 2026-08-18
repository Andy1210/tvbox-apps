import { useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useI18n } from "@sdk";
import { useFocusFallback, useInitialFocus } from "./focus";
import { useApp } from "./state";
import { PlaybackSettings } from "./PlaybackSettings";
import { HomeRows } from "./HomeRows";
import { usePrefs } from "./prefs";
import { deviceName } from "./identity";

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
  const cast = usePrefs((s) => s.cast);
  // What the phone lists this box under: its hostname, which is also what
  // its Plex client and its Spotify device are named after.
  const boxName = deviceName(useApp((s) => s.identity?.host) || "");
  const setPref = usePrefs((s) => s.set);
  const setAutologin = useApp((s) => s.setAutologin);
  const go = useApp((s) => s.go);

  const [panel, setPanel] = useState<null | "playback" | "rows">(null);
  const { ref, focusKey } = useFocusable({ focusKey: "settings", saveLastFocusedChild: true });
  // The setting someone came here to change, not the one that logs them out.
  useInitialFocus("settings-autologin", true);
  // Disabled while a panel is up, or it fights the panel for every press the
  // panel could not resolve - and armed again on close, which is the moment the
  // cursor has nowhere to be.
  useFocusFallback("settings-autologin", (k) => k.startsWith("settings-"), !panel);

  return (
    <FocusContext.Provider value={focusKey}>
      {/* Over the screen, never instead of it: replacing it unmounted every
          focusable underneath, and on close the cursor was left on a key that
          no longer existed - a Settings screen with no highlight and a dead
          remote. */}
      {panel === "playback" && <PlaybackSettings onClose={() => setPanel(null)} />}
      {panel === "rows" && <HomeRows onClose={() => setPanel(null)} />}
      <div ref={ref} className="flex h-full flex-col overflow-y-auto gap-[3vh] px-[6vw] py-[5vh]">
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

        {/* Not in the box's own "Extra app settings" - that is where an app with
            no screen of its own has to put a switch, and this app has one.
            Plex only: both halves of the receiver refuse a Jellyfin session, so
            the row would promise a household something that can never happen. */}
        {session?.kind !== "jellyfin" && (
          <div className="flex flex-col gap-[1vh]">
            <FocusButton
              focusKey="settings-cast"
              onEnter={() => void setPref("cast", !cast)}
              className="self-start rounded-[1vh] bg-white/12 px-[2.4vw] py-[1.3vh] text-[2.1vh]"
            >
              {`${t("settings.cast")} · ${t(cast ? "settings.on" : "settings.off")}`}
            </FocusButton>
            {/* Names the box, because a household with two of them has to know
              which one this is, and the phone lists it under this name. */}
            <p className="max-w-[60vw] text-[1.7vh] text-fg-dim">
              {cast ? t("settings.castOnHint", { name: boxName }) : t("settings.castOffHint")}
            </p>
          </div>
        )}

        {/* Named for what it opens and marked as leading somewhere. On its own
            the word "Playback" reads as a status line rather than a way in. */}
        <div className="flex flex-col gap-[1vh]">
          <FocusButton
            focusKey="settings-playback"
            onEnter={() => setPanel("playback")}
            className="self-start rounded-[1vh] bg-white/12 px-[2.4vw] py-[1.3vh] text-[2.1vh]"
          >
            {`${t("settings.playbackOpen")} \u203a`}
          </FocusButton>
          <p className="max-w-[60vw] text-[1.9vh] text-fg-dim">{t("settings.playbackHint")}</p>

          <FocusButton
            focusKey="settings-rows"
            onEnter={() => setPanel("rows")}
            className="mt-[1vh] self-start rounded-[1vh] bg-white/12 px-[2.4vw] py-[1.3vh] text-[2.1vh]"
          >
            {`${t("settings.homeRows")} \u203a`}
          </FocusButton>
          <p className="max-w-[60vw] text-[1.9vh] text-fg-dim">{t("settings.homeRowsHint")}</p>
        </div>

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
