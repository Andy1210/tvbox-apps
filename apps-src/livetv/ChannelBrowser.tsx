import { useEffect, useMemo, useRef, useState } from "react";
import { FocusContext, useFocusable, setFocus } from "@noriginmedia/norigin-spatial-navigation";
import { useI18n, FocusButton, useFocusableItem } from "@sdk";
import {
  fetchNowNext,
  fetchGuide,
  hhmmEpoch,
  progress,
  type Channel,
  type ChannelGroup,
  type Guide,
  type GuideProg,
  type NowNext,
} from "./api";

type ViewMode = "grid" | "list";
const VIEW_KEY = "tvbox.livetv.view";

function Category({
  group,
  count,
  index,
  locked,
  onFocusGroup,
}: {
  group: string;
  count: number;
  index: number;
  locked?: boolean;
  onFocusGroup: (i: number) => void;
}) {
  const { ref, focused } = useFocusableItem(
    { focusKey: "cat-" + index, onFocus: () => onFocusGroup(index) },
    { block: "nearest" },
  );
  return (
    <div
      ref={ref}
      className={[
        "px-[1.4vw] py-[1.3vh] rounded-[1vh] flex items-baseline justify-between gap-[1vw] transition-colors",
        focused ? "!bg-white !text-[#06090d]" : "text-fg-dim",
      ].join(" ")}
    >
      <span className="text-[1.9vh] font-semibold truncate">
        {locked && (
          <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            className="inline-block align-middle w-[1.7vh] h-[1.7vh] mr-[0.5vw]"
          >
            <path d="M6 10V8a6 6 0 1 1 12 0v2h1v11H5V10h1zm2 0h8V8a4 4 0 0 0-8 0v2z" />
          </svg>
        )}
        {group}
      </span>
      <span className="text-[1.3vh] opacity-70 tabular-nums">{count}</span>
    </div>
  );
}

function ViewToggle({ mode, onToggle }: { mode: ViewMode; onToggle: () => void }) {
  const { t } = useI18n();
  const { ref, focused } = useFocusableItem({ focusKey: "view-toggle", onEnterPress: onToggle });
  return (
    <div
      ref={ref}
      onClick={onToggle}
      className={[
        "px-[1.4vw] py-[1vh] rounded-[1vh] text-[1.7vh] font-semibold flex items-center gap-[0.6vw]",
        "transition-[transform,outline-color] duration-150 outline outline-[3px] outline-transparent outline-offset-2",
        focused ? "scale-[1.05] outline-[var(--color-focus)] bg-white/10" : "bg-white/5",
      ].join(" ")}
    >
      <span>{mode === "grid" ? "▤" : "▦"}</span>
      <span>{mode === "grid" ? t("livetv.list") : t("livetv.grid")}</span>
    </div>
  );
}

function ChannelCard({
  channel,
  onPlay,
  onFocusCh,
}: {
  channel: Channel;
  onPlay: (c: Channel) => void;
  onFocusCh: (c: Channel) => void;
}) {
  const { ref, focused } = useFocusableItem(
    { focusKey: "ch-" + channel.id, onEnterPress: () => onPlay(channel), onFocus: () => onFocusCh(channel) },
    { block: "nearest" },
  );
  return (
    <div
      ref={ref}
      onClick={() => onPlay(channel)}
      className={[
        "relative rounded-[1.2vh] bg-white/5 aspect-[16/10] flex flex-col items-center justify-center gap-[0.8vh] p-[1vh]",
        "transition-[transform,outline-color] duration-150 outline outline-[3px] outline-transparent outline-offset-2",
        focused ? "scale-[1.07] outline-[var(--color-focus)] bg-white/10" : "",
      ].join(" ")}
    >
      {channel.logo ? (
        <img src={channel.logo} alt="" loading="lazy" className="max-h-[50%] max-w-[80%] object-contain" />
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          className="w-[5vh] h-[5vh] text-white/35"
        >
          <rect x="2.5" y="6" width="19" height="12" rx="2" />
          <path d="M8 21h8M9 6l3-3 3 3" />
        </svg>
      )}
      <div className="text-[1.5vh] font-medium text-center leading-tight line-clamp-2">{channel.name}</div>
    </div>
  );
}

function ChannelRow({
  channel,
  nn,
  onPlay,
  onFocusCh,
}: {
  channel: Channel;
  nn?: NowNext;
  onPlay: (c: Channel) => void;
  onFocusCh: (c: Channel) => void;
}) {
  const { t, tag } = useI18n();
  const { ref, focused } = useFocusableItem(
    { focusKey: "ch-" + channel.id, onEnterPress: () => onPlay(channel), onFocus: () => onFocusCh(channel) },
    { block: "nearest" },
  );
  const now = nn?.now;
  const next = nn?.next;
  const pct = Math.round(progress(now) * 100);
  return (
    <div
      ref={ref}
      onClick={() => onPlay(channel)}
      className={[
        "flex items-center gap-[1.5vw] px-[1.4vw] py-[1.4vh] rounded-[1.2vh]",
        "transition-[transform,outline-color] duration-150 outline outline-[3px] outline-transparent outline-offset-2",
        focused ? "scale-[1.01] outline-[var(--color-focus)] bg-white/10" : "bg-white/5",
      ].join(" ")}
    >
      <div className="w-[7vw] h-[6vh] shrink-0 flex items-center justify-center">
        {channel.logo ? (
          <img src={channel.logo} alt="" loading="lazy" className="max-h-full max-w-full object-contain" />
        ) : (
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            className="w-[3.4vh] h-[3.4vh] text-white/35"
          >
            <rect x="2.5" y="6" width="19" height="12" rx="2" />
            <path d="M8 21h8M9 6l3-3 3 3" />
          </svg>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[2vh] font-semibold truncate">{channel.name}</div>
        {/* fixed-height slot: reserve room for now/next so the row doesn't grow
            (and the list doesn't reflow / jump the scroll) when nownext loads */}
        <div className="min-h-[5.6vh]">
          {now ? (
            <>
              <div className="flex items-baseline gap-[0.8vw] text-[1.6vh] mt-[0.3vh]">
                <span className="text-fg-dim tabular-nums shrink-0">{hhmmEpoch(now.start, tag)}</span>
                <span className="truncate">{now.title}</span>
              </div>
              <div className="h-[0.5vh] rounded-full bg-white/15 mt-[0.7vh] overflow-hidden">
                <div className="h-full bg-white/80" style={{ width: pct + "%" }} />
              </div>
              {next && (
                <div className="text-[1.4vh] text-fg-dim truncate mt-[0.5vh]">
                  <span className="mr-[0.6vw]">{t("livetv.next")}</span>
                  {hhmmEpoch(next.start, tag)} {next.title}
                </div>
              )}
            </>
          ) : (
            <div className="text-[1.5vh] text-fg-dim mt-[0.3vh]">—</div>
          )}
        </div>
      </div>
    </div>
  );
}

// Right-hand EPG for the focused channel: the previous programme, what's on now
// (with a progress bar), and the next several — so browsing shows the schedule
// without leaving the list. Programmes come from the guide (from = now-30min).
function ChannelEpg({ channel, guide, live }: { channel: Channel | null; guide: Guide | null; live: boolean }) {
  const { t, tag } = useI18n();
  const rows = useMemo(() => {
    const progs: GuideProg[] = (channel && channel.epgId && guide && guide.guide[channel.epgId]) || [];
    if (!progs.length) return [];
    const now = Date.now() / 1000;
    let cur = progs.findIndex((p) => p.start <= now && now < p.stop);
    if (cur < 0) cur = progs.findIndex((p) => p.start >= now); // no "now" -> first upcoming
    if (cur < 0) cur = progs.length - 1;
    const start = Math.max(0, cur - 1);
    return progs.slice(start, cur + 7).map((p) => ({
      ...p,
      state: now >= p.stop ? "past" : now >= p.start && now < p.stop ? "now" : ("next" as const),
    }));
  }, [channel, guide]);

  return (
    <div
      className={[
        "relative z-10 w-[26vw] shrink-0 rounded-[1.4vh] bg-white/[0.03] p-[1.4vw] overflow-y-auto no-scrollbar",
        live ? "mt-[27vh]" : "",
      ].join(" ")}
    >
      {channel ? (
        <>
          <div className="flex items-center gap-[1vw] mb-[1.4vh]">
            {channel.logo && <img src={channel.logo} alt="" className="max-h-[5vh] max-w-[30%] object-contain" />}
            <div className="text-[2.2vh] font-bold truncate">{channel.name}</div>
          </div>
          {rows.length ? (
            <div className="flex flex-col gap-[0.9vh]">
              {rows.map((p, i) => (
                <div
                  key={i}
                  className={[
                    "rounded-[0.9vh] px-[1vw] py-[1vh]",
                    p.state === "now" ? "bg-white/10" : p.state === "past" ? "opacity-45" : "",
                  ].join(" ")}
                >
                  <div className="flex items-baseline gap-[0.8vw]">
                    <span className="text-[1.6vh] text-fg-dim tabular-nums shrink-0">{hhmmEpoch(p.start, tag)}</span>
                    <span
                      className={["text-[1.9vh] leading-tight", p.state === "now" ? "font-bold" : "font-medium"].join(
                        " ",
                      )}
                    >
                      {p.title}
                    </span>
                  </div>
                  {p.state === "now" && (
                    <div className="h-[0.5vh] rounded-full bg-white/15 mt-[0.8vh] overflow-hidden">
                      <div
                        className="h-full bg-white/80"
                        style={{
                          width: Math.round(progress({ title: p.title, start: p.start, stop: p.stop }) * 100) + "%",
                        }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[1.8vh] text-fg-dim">{t("livetv.noProgramme")}</div>
          )}
        </>
      ) : null}
    </div>
  );
}

export function ChannelBrowser({
  groups,
  onPlay,
  lockedGroups,
  onOpenSettings,
  onOpenGuide,
  pipActive,
  onPipRect,
}: {
  groups: ChannelGroup[];
  onPlay: (c: Channel) => void;
  lockedGroups: string[];
  onOpenSettings: () => void;
  onOpenGuide: (channels: Channel[]) => void;
  pipActive?: boolean; // a live PiP is up (reserve its zone) — stable boolean, not a new node per render
  onPipRect?: (r: { x: number; y: number; w: number; h: number }) => void; // measured PiP placeholder (device px)
}) {
  const { t } = useI18n();
  const { ref, focusKey } = useFocusable({ focusKey: "livetv-browse" });
  const [active, setActive] = useState(0);
  const [mode, setMode] = useState<ViewMode>(() => (localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"));
  const [nownext, setNownext] = useState<Record<string, NowNext>>({});
  const [guide, setGuide] = useState<Guide | null>(null);
  const [focusedCh, setFocusedCh] = useState<Channel | null>(null);
  const pipRef = useRef<HTMLDivElement>(null);
  const onPipRectRef = useRef(onPipRect);
  onPipRectRef.current = onPipRect;

  // Measure the on-screen PiP placeholder (device px) and hand it to the shell so
  // mpv is positioned exactly there — resolution/layout independent.
  useEffect(() => {
    if (!pipActive) return;
    const measure = () => {
      const el = pipRef.current;
      if (!el || !onPipRectRef.current) return;
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      onPipRectRef.current({ x: r.left * dpr, y: r.top * dpr, w: r.width * dpr, h: r.height * dpr });
    };
    const id = setTimeout(measure, 80); // let the aspect-ratio height settle
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(id);
      window.removeEventListener("resize", measure);
    };
  }, [pipActive]); // stable boolean -> the PiP is positioned once, not on every re-render

  useEffect(() => {
    const id = setTimeout(() => setFocus("cat-0"), 0);
    return () => clearTimeout(id);
  }, []);
  useEffect(() => {
    fetchNowNext().then(setNownext);
    fetchGuide().then(setGuide);
  }, []);

  const toggle = () => {
    setMode((m) => {
      const nextMode = m === "grid" ? "list" : "grid";
      try {
        localStorage.setItem(VIEW_KEY, nextMode);
      } catch {
        /* ignore */
      }
      return nextMode;
    });
  };

  const channels = groups[active]?.channels ?? [];
  // pre-fill the EPG panel with the category's first channel (until the user
  // focuses a specific one, which updates it via onFocusCh)
  useEffect(() => {
    if (channels.length) setFocusedCh(channels[0]);
  }, [active, groups]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="h-full flex flex-col px-[3vw] py-[2vh]">
        <div className="relative z-10 flex items-center justify-between mb-[1.5vh]">
          <div className="text-[1.7vh] text-fg-dim">
            {groups[active]?.group} · {t("livetv.channelCount", { n: channels.length })}
          </div>
          <div className="flex items-center gap-[1vw]">
            <FocusButton
              focusKey="livetv-guide-btn"
              onEnter={() => onOpenGuide(channels)}
              className="px-[1.4vw] py-[1vh] rounded-[1vh] bg-white/5 text-[1.9vh] font-semibold"
            >
              {t("livetv.guide")}
            </FocusButton>
            <ViewToggle mode={mode} onToggle={toggle} />
            <FocusButton
              focusKey="livetv-settings-btn"
              onEnter={onOpenSettings}
              className="px-[1.2vw] py-[1vh] rounded-[1vh] bg-white/5 text-[2vh]"
            >
              ⚙
            </FocusButton>
          </div>
        </div>
        <div className="flex-1 flex gap-[1.2vw] min-h-0 relative">
          <div className="relative z-10 w-[15vw] shrink-0 overflow-y-auto no-scrollbar flex flex-col gap-[0.6vh]">
            {groups.map((g, i) => (
              <Category
                key={g.group}
                group={g.group}
                count={g.channels.length}
                index={i}
                locked={lockedGroups.includes(g.group)}
                onFocusGroup={setActive}
              />
            ))}
          </div>
          <div className="relative z-10 flex-1 overflow-y-auto no-scrollbar pb-[4vh] min-w-0">
            {mode === "grid" ? (
              <div className="grid grid-cols-4 gap-[1.2vw]">
                {channels.map((c) => (
                  <ChannelCard key={c.id} channel={c} onPlay={onPlay} onFocusCh={setFocusedCh} />
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-[0.8vh]">
                {channels.map((c) => (
                  <ChannelRow
                    key={c.id}
                    channel={c}
                    nn={c.epgId ? nownext[c.epgId] : undefined}
                    onPlay={onPlay}
                    onFocusCh={setFocusedCh}
                  />
                ))}
              </div>
            )}
          </div>
          <ChannelEpg channel={focusedCh} guide={guide} live={!!pipActive} />
          {pipActive && (
            // The live PiP is the shell's mpv sitting BEHIND the transparent Electron
            // window. This transparent box is the "hole": its huge box-shadow paints
            // the rest of the screen opaque (so the UI panels don't leak the video),
            // while the box itself stays clear so mpv shows through. z-0 keeps it
            // behind the z-10 UI. Its rect is measured for mpv's exact geometry.
            <div
              ref={pipRef}
              className="absolute top-0 right-0 z-0 w-[26vw] aspect-video rounded-[1.2vh] ring-[0.2vh] ring-white/15"
              style={{ boxShadow: "0 0 0 100vmax var(--color-bg-0)" }}
            />
          )}
        </div>
      </div>
    </FocusContext.Provider>
  );
}
