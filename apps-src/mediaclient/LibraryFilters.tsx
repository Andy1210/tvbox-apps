import { useEffect, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useBackspace, useI18n } from "@sdk";
import { useFocusFallback, useInitialFocus } from "./focus";
import { useApp } from "./state";
import type { FilterOption, SortOption } from "./backends/types";
import { log } from "./redact";

export interface LibraryView {
  sort: string;
  desc: boolean;
  /** Filter key to the value the SERVER wants, which is an id. */
  filters: Record<string, string>;
  /**
   * The same choices, as words.
   *
   * Kept beside the ids because that is all the server takes: a genre filter is
   * `genre=221`, and a chip reading "Genre: 221" tells nobody what is on.
   */
  labels: Record<string, string>;
}

/**
 * Ordering and narrowing a library.
 *
 * Both lists come from the SERVER, per library, rather than from a fixed set
 * here: a series library orders by unwatched episode count and a film library
 * by resolution, and offering an order the server does not know produces an
 * empty grid with nothing to explain it.
 *
 * A panel rather than a bar of chips. There are nine ways to sort and
 * twenty-odd ways to filter on this server's film library, which is a screen's
 * worth on its own - and it is a decision made once and then left alone, so it
 * is worth a press to open.
 */
export function LibraryFilters({
  libraryId,
  view,
  onApply,
  onClose,
}: {
  libraryId: string;
  view: LibraryView;
  onApply: (next: LibraryView) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);

  const [sorts, setSorts] = useState<SortOption[]>([]);
  const [filters, setFilters] = useState<FilterOption[]>([]);
  /** Which list filter is open, and its values once they arrive. */
  const [openFilter, setOpenFilter] = useState<FilterOption | null>(null);
  const [values, setValues] = useState<SortOption[] | null>(null);

  const { ref, focusKey } = useFocusable({ focusKey: "libfilters", saveLastFocusedChild: true, isFocusBoundary: true });
  useInitialFocus("lf-sort-0", sorts.length > 0);
  useFocusFallback("lf-close", (k) => k.startsWith("lf-"), true);
  useBackspace(() => {
    // The value list is a layer over the panel, so Back closes that first.
    if (openFilter) {
      setOpenFilter(null);
      setValues(null);
      return;
    }
    onClose();
  }, true);

  useEffect(() => {
    if (!backend) return;
    let live = true;
    void Promise.all([backend.sortOptions(libraryId), backend.filterOptions(libraryId)])
      .then(([s, f]) => {
        if (!live) return;
        setSorts(s);
        setFilters(f);
      })
      .catch((e) => log.warn("could not read sort and filter options", e));
    return () => {
      live = false;
    };
  }, [backend, libraryId]);

  useEffect(() => {
    if (!backend || !openFilter || openFilter.kind !== "list") return;
    let live = true;
    setValues(null);
    void backend
      .filterValues(libraryId, openFilter.key)
      .then((v) => live && setValues(v))
      .catch((e) => {
        log.warn("could not read filter values", e);
        if (live) setValues([]);
      });
    return () => {
      live = false;
    };
  }, [backend, libraryId, openFilter]);

  const setFilter = (key: string, value: string | null, label?: string): void => {
    const next = { ...view.filters };
    const nextLabels = { ...view.labels };
    if (value === null) {
      delete next[key];
      delete nextLabels[key];
    } else {
      next[key] = value;
      if (label) nextLabels[key] = label;
    }
    onApply({ ...view, filters: next, labels: nextLabels });
  };

  if (openFilter) {
    return (
      <Panel title={openFilter.title} onClose={() => setOpenFilter(null)} closeLabel={t("common.back")}>
        {values === null && <p className="text-[2vh] text-fg-dim">{t("common.loading")}</p>}
        <div className="flex flex-wrap gap-[0.8vw]">
          {values?.map((v, i) => (
            <Chip
              key={v.key}
              focusKey={`lf-val-${i}`}
              active={view.filters[openFilter.key] === v.key}
              label={v.title}
              onEnter={() => {
                const same = view.filters[openFilter.key] === v.key;
                setFilter(openFilter.key, same ? null : v.key, v.title);
                setOpenFilter(null);
              }}
            />
          ))}
        </div>
      </Panel>
    );
  }

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="absolute inset-0 z-40 flex items-center justify-center bg-black/80">
        <div className="flex h-[76vh] w-[86vw] flex-col gap-[2vh] overflow-hidden rounded-[1.4vh] bg-[#0c1219]/97 p-[3vh]">
          <div className="flex items-center justify-between">
            <h2 className="text-[2.6vh] font-semibold tracking-tight">{t("library.arrange")}</h2>
            <FocusButton
              focusKey="lf-close"
              onEnter={onClose}
              className="rounded-[1vh] bg-white/10 px-[2vw] py-[1vh] text-[2vh]"
            >
              {t("common.done")}
            </FocusButton>
          </div>

          <div className="no-scrollbar flex flex-col gap-[2.4vh] overflow-y-auto">
            <section className="flex flex-col gap-[1vh]">
              <h3 className="text-[2.1vh] font-semibold text-fg-dim">{t("library.sort")}</h3>
              <div className="flex flex-wrap gap-[0.8vw]">
                {sorts.map((s, i) => (
                  <Chip
                    key={s.key}
                    focusKey={`lf-sort-${i}`}
                    active={view.sort === s.key}
                    // Pressing the order you are already on reverses it, which is
                    // the only place direction can live without a second control
                    // for every row.
                    label={view.sort === s.key ? `${s.title} ${view.desc ? "↓" : "↑"}` : s.title}
                    onEnter={() =>
                      onApply(
                        view.sort === s.key ? { ...view, desc: !view.desc } : { ...view, sort: s.key, desc: false },
                      )
                    }
                  />
                ))}
              </div>
            </section>

            <section className="flex flex-col gap-[1vh]">
              <h3 className="text-[2.1vh] font-semibold text-fg-dim">{t("library.filter")}</h3>
              <div className="flex flex-wrap gap-[0.8vw]">
                {filters.map((f, i) => {
                  const chosen = view.filters[f.key];
                  return (
                    <Chip
                      key={f.key}
                      focusKey={`lf-filter-${i}`}
                      active={chosen !== undefined}
                      // The chosen value on the chip, so the panel can be closed
                      // and the state still read at a glance.
                      label={f.kind === "flag" || !chosen ? f.title : `${f.title}: ${view.labels[f.key] ?? chosen}`}
                      onEnter={() => {
                        if (f.kind === "flag") setFilter(f.key, chosen ? null : "1");
                        else setOpenFilter(f);
                      }}
                    />
                  );
                })}
              </div>
            </section>

            {Object.keys(view.filters).length > 0 && (
              <FocusButton
                focusKey="lf-clear"
                onEnter={() => onApply({ ...view, filters: {}, labels: {} })}
                className="self-start rounded-[1vh] bg-white/10 px-[2vw] py-[1.1vh] text-[2vh]"
              >
                {t("library.clearFilters")}
              </FocusButton>
            )}
          </div>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

function Panel({
  title,
  onClose,
  closeLabel,
  children,
}: {
  title: string;
  onClose: () => void;
  closeLabel: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const { ref, focusKey } = useFocusable({ focusKey: "lfvalues", saveLastFocusedChild: true, isFocusBoundary: true });
  useInitialFocus("lf-val-0", true);
  useFocusFallback("lf-val-close", (k) => k.startsWith("lf-val"), true);

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="absolute inset-0 z-40 flex items-center justify-center bg-black/80">
        <div className="flex h-[76vh] w-[86vw] flex-col gap-[2vh] overflow-hidden rounded-[1.4vh] bg-[#0c1219]/97 p-[3vh]">
          <div className="flex items-center justify-between">
            <h2 className="text-[2.6vh] font-semibold tracking-tight">{title}</h2>
            <FocusButton
              focusKey="lf-val-close"
              onEnter={onClose}
              className="rounded-[1vh] bg-white/10 px-[2vw] py-[1vh] text-[2vh]"
            >
              {closeLabel}
            </FocusButton>
          </div>
          <div className="no-scrollbar overflow-y-auto">{children}</div>
        </div>
      </div>
    </FocusContext.Provider>
  );
}

/** A chip. The check is what says "chosen"; the fill is what says "focused". */
function Chip({
  focusKey,
  active,
  label,
  onEnter,
}: {
  focusKey: string;
  active: boolean;
  label: string;
  onEnter: () => void;
}): React.JSX.Element {
  return (
    <FocusButton
      focusKey={focusKey}
      onEnter={onEnter}
      className="rounded-[0.8vh] bg-white/8 px-[1.4vw] py-[0.9vh] text-[2vh]"
    >
      <span className="inline-block w-[1.4vw] shrink-0 text-center">{active ? "✓" : ""}</span>
      {label}
    </FocusButton>
  );
}
