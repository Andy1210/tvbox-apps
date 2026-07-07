import { useEffect, useRef, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useBackspace, useConfigStore, FocusButton, Osk, type IptvInput } from "@sdk";

type Vals = { base: string; user: string; pass: string; url: string; epgUrl: string };

// Manual IPTV entry on the TV (OSK fallback to the phone QR setup). Each field
// opens the on-screen keyboard; Save writes the config (launcher -> shell).
export function ManualConfig({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"xtream" | "m3u">("xtream");
  const [vals, setVals] = useState<Vals>({ base: "", user: "", pass: "", url: "", epgUrl: "" });
  const [editing, setEditing] = useState<{ key: keyof Vals; label: string; fk: string } | null>(null);
  const { ref, focusKey } = useFocusable({ focusKey: "manual" });
  const setIptv = useConfigStore((s) => s.setIptv);
  const returnFocus = useRef("man-mode-xtream");

  useEffect(() => {
    if (!editing) {
      const id = setTimeout(() => setFocus(returnFocus.current), 0);
      return () => clearTimeout(id);
    }
  }, [editing, mode]);
  useBackspace(onCancel, !editing);

  if (editing) {
    return (
      <Osk
        title={editing.label}
        initial={vals[editing.key]}
        onDone={(v) => {
          setVals((s) => ({ ...s, [editing.key]: v }));
          returnFocus.current = editing.fk;
          setEditing(null);
        }}
        onCancel={() => {
          returnFocus.current = editing.fk;
          setEditing(null);
        }}
      />
    );
  }

  const fields: { key: keyof Vals; label: string }[] =
    mode === "xtream"
      ? [
          { key: "base", label: t("livetv.host") },
          { key: "user", label: t("livetv.user") },
          { key: "pass", label: t("livetv.pass") },
        ]
      : [
          { key: "url", label: t("livetv.m3uUrl") },
          { key: "epgUrl", label: t("livetv.epgUrl") },
        ];

  const save = async () => {
    const iptv: IptvInput =
      mode === "xtream"
        ? { mode: "xtream", xtream: { base: vals.base, user: vals.user, pass: vals.pass } }
        : { mode: "m3u", m3u: { url: vals.url, epgUrl: vals.epgUrl } };
    await setIptv(iptv);
    onDone();
  };

  const tab = (m: "xtream" | "m3u", fk: string, label: string) => (
    <FocusButton
      focusKey={fk}
      onEnter={() => {
        setMode(m);
        returnFocus.current = fk;
      }}
      className={["px-[2vw] py-[1.3vh] rounded-[1vh] text-[2vh]", mode === m ? "bg-white/20" : "bg-white/5"].join(" ")}
    >
      {label}
    </FocusButton>
  );

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col px-[6vw] py-[4vh]">
        <div className="text-[3vh] font-bold mb-[2.5vh]">{t("livetv.manualTitle")}</div>
        <div className="flex gap-[1vw] mb-[2.5vh]">
          {tab("xtream", "man-mode-xtream", t("livetv.modeXtream"))}
          {tab("m3u", "man-mode-m3u", t("livetv.modeM3u"))}
        </div>
        <div className="flex flex-col gap-[1.2vh] max-w-[70vw]">
          {fields.map((f, i) => (
            <FocusButton
              key={f.key}
              focusKey={"man-f-" + i}
              onEnter={() => {
                returnFocus.current = "man-f-" + i;
                setEditing({ key: f.key, label: f.label, fk: "man-f-" + i });
              }}
              className="px-[2vw] py-[1.6vh] rounded-[1.2vh] bg-white/5 flex items-center justify-between gap-[2vw]"
            >
              <span className="text-[1.9vh] text-fg-dim shrink-0">{f.label}</span>
              <span className="text-[2vh] truncate">
                {vals[f.key] || <span className="text-fg-dim/60">{t("livetv.empty")}</span>}
              </span>
            </FocusButton>
          ))}
          <FocusButton
            focusKey="man-save"
            onEnter={save}
            className="mt-[1.5vh] px-[2vw] py-[1.7vh] rounded-[1.2vh] bg-white/10 text-[2.2vh] font-semibold text-center"
          >
            {t("livetv.save")}
          </FocusButton>
        </div>
      </div>
    </FocusContext.Provider>
  );
}
