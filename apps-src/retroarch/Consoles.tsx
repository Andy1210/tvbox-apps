import { useEffect, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, useFocusableItem } from "@sdk";
import { fetchCores, installCore, removeCore, setSystemCore, type CoreRow, type SystemRow } from "./api";

// Adding a console from the TV: the same routes the phone's Consoles page calls
// (the plugin registers one table for both), so what is installed here is what is
// installed there. Which emulator a console USES when several are installed is set
// here too - the grid needs an answer per console and the metadata can only narrow
// it down to "these claim it".

function Row({
  title,
  subtitle,
  action,
  focusKey,
  busy,
  onPress,
}: {
  title: string;
  subtitle: string;
  action: string;
  focusKey: string;
  busy?: boolean;
  onPress: () => void;
}) {
  const { ref, focused } = useFocusableItem({ focusKey, onEnterPress: onPress }, { block: "nearest" });
  return (
    <div
      ref={ref}
      onClick={onPress}
      className={[
        "px-[1.4vw] py-[1.2vh] rounded-[1vh] flex items-center justify-between gap-[1vw]",
        focused ? "bg-white text-[#06090d]" : "bg-white/5",
      ].join(" ")}
    >
      <div className="min-w-0">
        <div className="text-[1.9vh] font-semibold truncate">{title}</div>
        <div className={["text-[1.4vh] truncate", focused ? "opacity-70" : "text-fg-dim"].join(" ")}>{subtitle}</div>
      </div>
      <div className="text-[1.6vh] font-semibold shrink-0">{busy ? "…" : action}</div>
    </div>
  );
}

export function Consoles({ systems, onChanged }: { systems: SystemRow[]; onChanged: () => void }) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "consoles-page" });
  const [cores, setCores] = useState<CoreRow[]>([]);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  // Removing an emulator is the one destructive thing on this screen, and a TV has
  // one button: the first press arms the row, the second one does it. Armed state is
  // dropped whenever the list reloads, so it cannot linger.
  const [arm, setArm] = useState("");

  const load = () => {
    setLoading(true);
    setArm("");
    fetchCores()
      .then((d) => {
        setCores(d.cores);
        setOffline(d.offline);
      })
      .catch(() => setNote(t("retroarch.coresError")))
      .finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  const act = (core: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(core);
    setNote("");
    fn()
      .then((r) => {
        if (!r.ok) setNote(t("retroarch.coreFailed", { core }));
        load();
        onChanged();
      })
      .catch(() => setNote(t("retroarch.coreFailed", { core })))
      .finally(() => setBusy(""));
  };

  // Only the consoles that HAVE games are worth a choice on this screen; a console
  // with one installed core has nothing to choose between.
  const choices = systems.filter((s) => s.games > 0 && s.candidates.length > 1);
  const installed = cores.filter((c) => c.installed);
  const available = cores.filter((c) => !c.installed);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full overflow-y-auto no-scrollbar px-[3vw] pb-[3vh] flex flex-col gap-[1.5vh]">
        {note && <div className="text-[1.7vh] text-fg-dim">{note}</div>}
        {offline && <div className="text-[1.7vh] text-fg-dim">{t("retroarch.coresOffline")}</div>}

        {choices.length > 0 && (
          <>
            <div className="text-[1.6vh] font-semibold text-fg-dim uppercase tracking-wide">
              {t("retroarch.whichEmulator")}
            </div>
            {choices.map((s) => {
              const next = () => {
                // Cycle through the candidates, then back to "let the box decide".
                const ids = s.candidates.map((c) => c.core);
                const at = s.override ? ids.indexOf(s.override) : -1;
                const to = at + 1 >= ids.length ? null : ids[at + 1];
                setBusy(s.system);
                setSystemCore(s.system, to)
                  .then(onChanged)
                  .finally(() => setBusy(""));
              };
              return (
                <Row
                  key={s.system}
                  focusKey={"pick-" + s.system}
                  title={s.system}
                  subtitle={
                    s.override
                      ? t("retroarch.coreChosen", { core: s.coreName || s.override })
                      : t("retroarch.coreAuto", { core: s.coreName || "-" })
                  }
                  action={t("retroarch.change")}
                  busy={busy === s.system}
                  onPress={next}
                />
              );
            })}
          </>
        )}

        <div className="text-[1.6vh] font-semibold text-fg-dim uppercase tracking-wide">
          {t("retroarch.installed", { n: installed.length })}
        </div>
        {installed.map((c) => (
          <Row
            key={c.core}
            focusKey={"core-" + c.core}
            title={c.label || c.core}
            subtitle={c.system || c.core}
            action={
              c.updatable ? t("retroarch.update") : arm === c.core ? t("retroarch.removeSure") : t("retroarch.remove")
            }
            busy={busy === c.core}
            onPress={() => {
              if (c.updatable) return act(c.core, () => installCore(c.core));
              if (arm !== c.core) return setArm(c.core);
              act(c.core, () => removeCore(c.core));
            }}
          />
        ))}

        <div className="text-[1.6vh] font-semibold text-fg-dim uppercase tracking-wide">
          {loading ? t("retroarch.loading") : t("retroarch.available", { n: available.length })}
        </div>
        {available.map((c) => (
          <Row
            key={c.core}
            focusKey={"core-" + c.core}
            title={c.label || c.core}
            subtitle={c.system || c.core}
            action={t("retroarch.install")}
            busy={busy === c.core}
            onPress={() => act(c.core, () => installCore(c.core))}
          />
        ))}
      </div>
    </FocusContext.Provider>
  );
}
