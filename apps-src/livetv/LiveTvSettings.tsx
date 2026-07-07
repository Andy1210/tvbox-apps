import { useEffect, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, verifyPin, useConfigStore, FocusButton, PinPad } from "@sdk";
import { PhoneConfig } from "./PhoneConfig";
import { ManualConfig } from "./ManualConfig";

// In-app Live TV settings (IPTV source + parental lock). App-specific, so it
// lives inside the Live TV app rather than the global Settings. Config comes
// from the store (writes auto-update everywhere).
export function LiveTvSettings({ groups, onExit }: { groups: string[]; onExit: () => void }) {
  const { t } = useI18n();
  const config = useConfigStore((s) => s.config);
  const setParental = useConfigStore((s) => s.setParental);
  const [unlocked, setUnlocked] = useState(false);
  const [pinMode, setPinMode] = useState<"none" | "verify" | "set">("none");
  const [pinError, setPinError] = useState<string | undefined>();
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const { ref, focusKey } = useFocusable({ focusKey: "livetv-settings" });

  useEffect(() => {
    if (config?.parental.pinSet) setPinMode("verify");
    else setUnlocked(true);
  }, []); // gate decision once on mount (config already loaded by App)

  const editorActive = pinMode === "none" && !phoneOpen && !manualOpen;
  useEffect(() => {
    if (editorActive && config) setTimeout(() => setFocus("iptv-phone"), 0);
  }, [editorActive, config]);
  useBackspace(onExit, editorActive);

  if (!config) {
    return <div className="h-full flex items-center justify-center text-fg-dim text-[2vh]">…</div>;
  }

  if (pinMode === "verify") {
    return (
      <PinPad
        title={t("parental.enterPin")}
        error={pinError}
        onCancel={onExit}
        onSubmit={async (pin) => {
          if (await verifyPin(pin)) {
            setUnlocked(true);
            setPinMode("none");
            setPinError(undefined);
          } else setPinError(t("parental.wrongPin"));
        }}
      />
    );
  }
  if (pinMode === "set") {
    return (
      <PinPad
        title={t("parental.setNewPin")}
        onCancel={() => setPinMode("none")}
        onSubmit={async (pin) => {
          await setParental({ pin });
          setUnlocked(true);
          setPinMode("none");
        }}
      />
    );
  }

  if (phoneOpen) {
    return <PhoneConfig onDone={() => setPhoneOpen(false)} onCancel={() => setPhoneOpen(false)} />;
  }
  if (manualOpen) {
    return <ManualConfig onDone={() => setManualOpen(false)} onCancel={() => setManualOpen(false)} />;
  }

  const iptv = config.iptv;
  const sourceLabel = !iptv.configured
    ? t("livetv.sourceNone")
    : iptv.mode === "xtream"
      ? `Xtream · ${iptv.xtream?.base || ""}`
      : `M3U · ${iptv.m3u?.url || ""}`;
  const pinSet = config.parental.pinSet;
  const locked = new Set(config.parental.lockedGroups);
  const toggle = async (g: string) => {
    if (!unlocked) return;
    const next = new Set(locked);
    if (next.has(g)) next.delete(g);
    else next.add(g);
    await setParental({ lockedGroups: [...next] });
  };

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col px-[5vw] py-[4vh]">
        <div className="text-[3vh] font-bold mb-[2.5vh]">{t("livetv.settingsTitle")}</div>

        <div className="text-[1.7vh] text-fg-dim mb-[0.8vh]">{t("livetv.source")}</div>
        <div className="flex items-center gap-[1.5vw] mb-[3vh]">
          <span className="text-[2vh] truncate max-w-[40vw]">{sourceLabel}</span>
          <FocusButton
            focusKey="iptv-phone"
            onEnter={() => setPhoneOpen(true)}
            className="px-[1.6vw] py-[1.2vh] rounded-[1vh] bg-white/5 text-[1.9vh] shrink-0"
          >
            {t("livetv.setupPhone")}
          </FocusButton>
          <FocusButton
            focusKey="iptv-manual"
            onEnter={() => setManualOpen(true)}
            className="px-[1.6vw] py-[1.2vh] rounded-[1vh] bg-white/5 text-[1.9vh] shrink-0"
          >
            {t("livetv.setupManual")}
          </FocusButton>
        </div>

        <div className="text-[2.4vh] font-semibold mb-[1.2vh]">{t("parental.title")}</div>
        <div className="flex items-center gap-[1.5vw] mb-[1.5vh]">
          <span className="text-[2vh] text-fg-dim">{pinSet ? t("parental.pinSet") : t("parental.pinNotSet")}</span>
          <FocusButton
            focusKey="par-setpin"
            onEnter={() => setPinMode("set")}
            className="px-[1.6vw] py-[1.2vh] rounded-[1vh] bg-white/5 text-[1.9vh]"
          >
            {pinSet ? t("parental.changePin") : t("parental.setPin")}
          </FocusButton>
          {pinSet && (
            <FocusButton
              focusKey="par-rmpin"
              onEnter={() => setParental({ pin: "", lockedGroups: [] })}
              className="px-[1.6vw] py-[1.2vh] rounded-[1vh] bg-white/5 text-[1.9vh]"
            >
              {t("parental.removePin")}
            </FocusButton>
          )}
        </div>

        <div className="text-[1.7vh] text-fg-dim">{t("parental.lockedCategories")}</div>
        <div className="text-[1.4vh] text-fg-dim/70 mb-[1vh]">
          {pinSet ? t("parental.lockedCategoriesHint") : t("parental.needPinFirst")}
        </div>
        <div className="grid grid-cols-2 gap-[1vh] overflow-y-auto no-scrollbar flex-1">
          {groups.map((g, i) => {
            const on = locked.has(g);
            return (
              <FocusButton
                key={g}
                focusKey={"par-cat-" + i}
                onEnter={() => toggle(g)}
                className={[
                  "px-[1.6vw] py-[1.3vh] rounded-[1vh] text-[1.9vh] flex items-center justify-between",
                  on ? "bg-white/15" : "bg-white/5",
                  pinSet ? "" : "opacity-50",
                ].join(" ")}
              >
                <span className="truncate">{g}</span>
                {on ? (
                  <svg viewBox="0 0 24 24" fill="currentColor" className="w-[2.2vh] h-[2.2vh] shrink-0">
                    <path d="M6 10V8a6 6 0 1 1 12 0v2h1v11H5V10h1zm2 0h8V8a4 4 0 0 0-8 0v2z" />
                  </svg>
                ) : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    className="w-[2.2vh] h-[2.2vh] shrink-0 opacity-60"
                  >
                    <rect x="5" y="10" width="14" height="11" rx="1.5" />
                    <path d="M8 10V7a4 4 0 0 1 7-2.6" strokeLinecap="round" />
                  </svg>
                )}
              </FocusButton>
            );
          })}
        </div>
      </div>
    </FocusContext.Provider>
  );
}
