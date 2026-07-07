import { useEffect, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, useConfigStore, FocusButton, Osk } from "@sdk";
import { useSpotifyStore } from "./stores/spotify";
import { SpotifyConfig } from "./SpotifyConfig";
import { SpotifyConnect } from "./SpotifyConnect";
import { SpotifyKeysGuide } from "./SpotifyKeysGuide";
import { authStatus, switchAccount, removeAccount, setSpotifyEnabled, type AuthStatus } from "./api";

// In-app Spotify settings: the Connect device name (always) and the OPTIONAL Web
// API account connection (API keys via phone pairing, then on-box OAuth). Renaming
// and connecting need no root — the shell owns librespot and does OAuth itself.
export function SpotifySettings({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const config = useConfigStore((s) => s.config);
  const loadConfig = useConfigStore((s) => s.load);
  const state = useSpotifyStore((s) => s.state);
  const [mode, setMode] = useState<"menu" | "name" | "guide" | "keys" | "connect" | "accounts">("menu");
  const [saving, setSaving] = useState(false);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const { ref, focusKey } = useFocusable({ focusKey: "sp-settings" });

  const name = state?.device_name || config?.spotify?.deviceName || "tvbox";
  const hasKeys = !!config?.spotify?.hasCredentials;

  const refreshAuth = () => authStatus().then(setAuth);
  useEffect(() => {
    refreshAuth();
  }, []);
  const spEnabled = config?.spotify?.enabled ?? false;
  const [toggling, setToggling] = useState(false);
  useEffect(() => {
    if (mode === "menu") {
      const id = setTimeout(() => setFocus("sp-enable-row"), 0);
      return () => clearTimeout(id);
    }
  }, [mode, hasKeys, auth]);
  useBackspace(onBack, mode === "menu");

  if (mode === "name") {
    return (
      <Osk
        title={t("spotify.deviceNamePrompt")}
        initial={name}
        onDone={async (v) => {
          setMode("menu");
          const value = v.trim();
          if (!value || value === name) return;
          setSaving(true);
          await fetch("/tvbox/api/spotify/device-name", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: value }),
          }).catch(() => {});
          await loadConfig();
          setSaving(false);
        }}
        onCancel={() => setMode("menu")}
      />
    );
  }
  if (mode === "guide") {
    return <SpotifyKeysGuide onContinue={() => setMode("keys")} onCancel={() => setMode("menu")} />;
  }
  if (mode === "keys") {
    return (
      <SpotifyConfig
        onDone={async () => {
          await loadConfig();
          refreshAuth();
          setMode("menu");
        }}
        onCancel={() => setMode("menu")}
      />
    );
  }
  if (mode === "connect") {
    return (
      <SpotifyConnect
        onDone={() => {
          refreshAuth();
          setMode("menu");
        }}
        onCancel={() => {
          refreshAuth();
          setMode("menu");
        }}
      />
    );
  }
  if (mode === "accounts" && auth) {
    return (
      <AccountsView
        auth={auth}
        onSwitch={async (id) => {
          await switchAccount(id);
          await refreshAuth();
          setMode("menu");
        }}
        onRemove={async (id) => {
          await removeAccount(id);
          const s = await authStatus();
          setAuth(s);
          if (!s.connected) setMode("menu");
        }}
        onAdd={() => setMode("connect")}
        onBack={() => setMode("menu")}
      />
    );
  }

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col px-[6vw] py-[4vh] gap-[1.2vh] overflow-y-auto">
        <div className="text-[3vh] font-bold mb-[0.5vh]">
          {t("settings.title")} <span className="text-fg-dim">· Spotify</span>
        </div>

        {/* Spotify Connect on/off — runs the librespot daemon (no root) */}
        <FocusButton
          focusKey="sp-enable-row"
          onEnter={async () => {
            if (toggling) return;
            setToggling(true);
            await setSpotifyEnabled(!spEnabled);
            await loadConfig();
            setToggling(false);
          }}
          className="px-[2.5vw] py-[2vh] rounded-[1.4vh] bg-white/5 flex items-center justify-between gap-[2vw] max-w-[66vw]"
        >
          <span className="text-[2.1vh] text-fg-dim shrink-0">{t("spotify.connectToggle")}</span>
          <span className={"text-[2.4vh] font-semibold " + (spEnabled ? "text-[#1DB954]" : "text-fg-dim")}>
            {toggling ? t("spotify.saving") : spEnabled ? t("spotify.on") : t("spotify.off")}
          </span>
        </FocusButton>
        <div className="text-[1.6vh] text-fg-dim/70 mb-[1.5vh] max-w-[66vw]">{t("spotify.connectToggleHint")}</div>

        {/* Connect device name */}
        <FocusButton
          focusKey="sp-name-row"
          onEnter={() => setMode("name")}
          className="px-[2.5vw] py-[2vh] rounded-[1.4vh] bg-white/5 flex items-center justify-between gap-[2vw] max-w-[66vw]"
        >
          <span className="text-[2.1vh] text-fg-dim shrink-0">{t("spotify.deviceName")}</span>
          <span className="text-[2.4vh] font-semibold truncate">{saving ? t("spotify.saving") : name}</span>
        </FocusButton>
        <div className="text-[1.6vh] text-fg-dim/70 mb-[1.5vh] max-w-[66vw]">{t("spotify.deviceNameHint")}</div>

        {/* Optional Web API account */}
        <div className="text-[2.2vh] font-semibold mt-[1vh]">{t("spotify.account")}</div>
        {!hasKeys && (
          <>
            <FocusButton
              focusKey="sp-keys-row"
              onEnter={() => setMode("guide")}
              className="px-[2.5vw] py-[2vh] rounded-[1.4vh] bg-white/5 text-[2.1vh] font-semibold max-w-[66vw] text-left"
            >
              {t("spotify.addKeys")}
            </FocusButton>
            <div className="text-[1.6vh] text-fg-dim/70 max-w-[66vw]">{t("spotify.keysWhere")}</div>
          </>
        )}
        {hasKeys && auth && !auth.connected && (
          <>
            <FocusButton
              focusKey="sp-connect-row"
              onEnter={() => setMode("connect")}
              className="px-[2.5vw] py-[2vh] rounded-[1.4vh] bg-[#1DB954] text-[#06120b] text-[2.1vh] font-bold max-w-[66vw] text-left"
            >
              {t("spotify.connect")}
            </FocusButton>
            <FocusButton
              focusKey="sp-rekeys-row"
              onEnter={() => setMode("keys")}
              className="px-[2.5vw] py-[1.6vh] rounded-[1.2vh] bg-white/5 text-[1.9vh] max-w-[66vw] text-left"
            >
              {t("spotify.reenterKeys")}
            </FocusButton>
          </>
        )}
        {hasKeys && auth && auth.connected && (
          <FocusButton
            focusKey="sp-accounts-row"
            onEnter={() => setMode("accounts")}
            className="px-[2.5vw] py-[2vh] rounded-[1.4vh] bg-white/5 flex items-center justify-between gap-[2vw] max-w-[66vw]"
          >
            <span className="text-[2.1vh] truncate">
              <span className="text-[#1DB954]">●</span> {t("spotify.connectedAs", { user: auth.user || "Spotify" })}
            </span>
            <span className="text-[1.9vh] text-fg-dim shrink-0">
              {t("spotify.accounts")} ({auth.accounts.length}) ›
            </span>
          </FocusButton>
        )}
      </div>
    </FocusContext.Provider>
  );
}

// Account switcher: tap an account to make it active (no re-login), ✕ to remove,
// or link another. Family boxes keep several accounts side by side.
function AccountsView({
  auth,
  onSwitch,
  onRemove,
  onAdd,
  onBack,
}: {
  auth: AuthStatus;
  onSwitch: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "sp-accounts" });
  useEffect(() => {
    const id = setTimeout(() => setFocus("acc-add"), 0);
    return () => clearTimeout(id);
  }, []);
  useBackspace(onBack);
  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col px-[6vw] py-[4vh] gap-[1vh] overflow-y-auto overflow-x-hidden">
        <div className="text-[3vh] font-bold mb-[1vh]">
          {t("settings.title")} <span className="text-fg-dim">· {t("spotify.accountsTitle")}</span>
        </div>
        {auth.accounts.map((a) => (
          <div key={a.id} className="flex gap-[1vw] max-w-[66vw]">
            <FocusButton
              focusKey={"acc-" + a.id}
              onEnter={() => onSwitch(a.id)}
              className="flex-1 px-[2vw] py-[1.8vh] rounded-[1.2vh] bg-white/5 flex items-center justify-between gap-[1vw]"
            >
              <span className="text-[2.1vh] truncate">{a.name || "Spotify"}</span>
              {a.active && <span className="text-[1.7vh] text-[#1DB954] shrink-0">● {t("spotify.active")}</span>}
            </FocusButton>
            <FocusButton
              focusKey={"accx-" + a.id}
              onEnter={() => onRemove(a.id)}
              className="w-[7vh] rounded-[1.2vh] bg-white/5 flex items-center justify-center text-[2.4vh]"
            >
              ✕
            </FocusButton>
          </div>
        ))}
        <FocusButton
          focusKey="acc-add"
          onEnter={onAdd}
          className="mt-[1vh] px-[2.5vw] py-[1.8vh] rounded-[1.2vh] bg-[#1DB954] text-[#06120b] text-[2vh] font-bold max-w-[66vw] text-left"
        >
          {t("spotify.addAccount")}
        </FocusButton>
      </div>
    </FocusContext.Provider>
  );
}
