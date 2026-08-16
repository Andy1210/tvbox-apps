import { useEffect, useState } from "react";
import { FocusContext, setFocus, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useBackspace, useI18n } from "@sdk";
import { useFocusFallback, useInitialFocus } from "./focus";
import { useApp } from "./state";
import type { FilterOption, SortOption } from "./backends/types";
import { log } from "./redact";

/** How many values one filter offers before the list stops being a control. */
const VALUE_CAP = 120;

/**
 * How long the panel waits for its options before it stops holding the cursor
 * for them.
 */
export const OPTIONS_DEADLINE_MS = 4000;

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
  of,
  onApply,
  onClose,
}: {
  libraryId: string;
  view: LibraryView;
  /**
   * Which list this panel is arranging.
   *
   * Passed on to `sortOptions`, which restricts the orders when it is
   * "collections" - a collection has no resolution and no unwatched count, and
   * the backend keeps a shorter list for exactly that reason. Both call sites
   * omitted it, so that shorter list was never once used.
   */
  of?: "collections";
  onApply: (next: LibraryView) => void;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);

  const [sorts, setSorts] = useState<SortOption[]>([]);
  const [filters, setFilters] = useState<FilterOption[]>([]);
  /**
   * Whether the options request has finished - or waited long enough that
   * pretending it is still coming would cost the remote. See the effect below.
   */
  const [settled, setSettled] = useState(false);
  /** Which list filter is open, and its values once they arrive. */
  const [openFilter, setOpenFilter] = useState<FilterOption | null>(null);
  const [values, setValues] = useState<SortOption[] | null>(null);

  const { ref, focusKey } = useFocusable({ focusKey: "libfilters", saveLastFocusedChild: true, isFocusBoundary: true });
  // Whatever the panel actually has, in the order somebody would want it. A
  // server that answers with no orders still has filters worth reaching, and
  // opening with nothing focused leaves the only highlight on screen behind the
  // dimmed overlay.
  const home = sorts.length > 0 ? "lf-sort-0" : filters.length > 0 ? "lf-filter-0" : "lf-close";
  useInitialFocus(home, settled);
  // The first sort chip, not the close button: a fallback that lands on "leave"
  // turns a lost cursor into an accidental exit. While the options are still in
  // flight that is exactly what naming the close button would do on a slow
  // server, so the chip is named until the answer has actually arrived - a key
  // that has not mounted yet takes the cursor by itself once it does.
  useFocusFallback(settled ? home : "lf-sort-0", (k) => k.startsWith("lf-"), true);
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
    setSettled(false);
    // A hung request settles nothing. `req` carries no deadline of its own, so
    // without this the cursor waits on a chip that never mounts and every press
    // is discarded - which is the whole failure this panel is being fixed for,
    // reached by a stalled connection rather than an error. Far beyond a healthy
    // answer on this LAN, which is 11 ms warm and 86 ms cold.
    const deadline = setTimeout(() => {
      if (live) setSettled(true);
    }, OPTIONS_DEADLINE_MS);
    void Promise.all([backend.sortOptions(libraryId, of), backend.filterOptions(libraryId, of)])
      .then(([s, f]) => {
        if (!live) return;
        setSorts(s);
        setFilters(f);
      })
      .catch((e) => log.warn("could not read sort and filter options", e))
      .finally(() => {
        // Whether the answer arrived is a different question from whether it had
        // anything in it, and the cursor's home depends on the first.
        clearTimeout(deadline);
        if (live) setSettled(true);
      });
    return () => {
      live = false;
      clearTimeout(deadline);
    };
  }, [backend, libraryId, of]);

  useEffect(() => {
    if (!backend || !openFilter || openFilter.kind !== "list") return;
    let live = true;
    setValues(null);
    void backend
      .filterValues(libraryId, openFilter.key, openFilter.path)
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
        {values && values.length > VALUE_CAP && (
          // Said rather than silently truncated. Some of these lists run to
          // thousands - this server offers 2,580 actors - and a D-pad walk
          // through 645 rows is not a control. The cap is honest about what is
          // missing until there is an index for them.
          <p className="pb-[1vh] text-[1.9vh] text-fg-dim">
            {t("library.tooMany", { shown: String(VALUE_CAP), total: String(values.length) })}
          </p>
        )}
        <div // A strict grid, not a wrapped flex. Spatial navigation resolves by
          // rectangles, and chips of different widths wrapping onto ragged
          // lines gave it no clean answer: Right skipped one, and there was
          // no way back to the row above. Fixed columns make every chip line
          // up with the one under it.
          className="grid grid-cols-4 gap-x-[1vw] gap-y-[1.4vh]"
        >
          {values?.slice(0, VALUE_CAP).map((v, i) => (
            <Chip
              key={v.key}
              focusKey={`lf-val-${i}`}
              active={view.filters[openFilter.key] === v.key}
              label={v.title}
              onEnter={() => {
                const same = view.filters[openFilter.key] === v.key;
                const from = filters.findIndex((f) => f.key === openFilter.key);
                setFilter(openFilter.key, same ? null : v.key, v.title);
                setOpenFilter(null);
                // Back to the filter you opened. The value list unmounts under
                // the cursor, and the fallback would otherwise drop focus on
                // the close button - losing your place in a list of thirty and
                // putting a reflexive OK on "leave".
                if (from >= 0) setTimeout(() => setFocus(`lf-filter-${from}`), 0);
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

          <div className="no-scrollbar -mx-[0.6vw] flex flex-col gap-[2.4vh] overflow-y-auto px-[0.6vw]">
            {/* Otherwise an empty panel means either "still asking" or "nothing
                to ask for", and they look the same from a sofa. */}
            {!settled && <p className="text-[2.1vh] text-fg-dim">{t("common.loading")}</p>}
            {/* Both halves keep their own counsel: a heading over an empty box
                says a control is there. */}
            <section className={`flex flex-col gap-[1vh] ${sorts.length === 0 ? "hidden" : ""}`}>
              <h3 className="text-[2.1vh] font-semibold text-fg-dim">{t("library.sort")}</h3>
              <div // A strict grid, not a wrapped flex. Spatial navigation resolves by
                // rectangles, and chips of different widths wrapping onto ragged
                // lines gave it no clean answer: Right skipped one, and there was
                // no way back to the row above. Fixed columns make every chip line
                // up with the one under it.
                className="grid grid-cols-4 gap-x-[1vw] gap-y-[1.4vh]"
              >
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

            {/* A heading over nothing is a promise the list does not keep: a
                collection cannot be narrowed at all here. */}
            <section className={`flex flex-col gap-[1vh] ${filters.length === 0 ? "hidden" : ""}`}>
              <h3 className="text-[2.1vh] font-semibold text-fg-dim">{t("library.filter")}</h3>
              <div // A strict grid, not a wrapped flex. Spatial navigation resolves by
                // rectangles, and chips of different widths wrapping onto ragged
                // lines gave it no clean answer: Right skipped one, and there was
                // no way back to the row above. Fixed columns make every chip line
                // up with the one under it.
                className="grid grid-cols-4 gap-x-[1vw] gap-y-[1.4vh]"
              >
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
                        if (f.kind === "flag") {
                          // The title as the label, because the VALUE of a flag is
                          // "1" and the button outside falls back to the value when
                          // a filter has no name - so turning one on read
                          // "Sort and filter · 1".
                          setFilter(f.key, chosen ? null : "1", f.title);
                        }
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
                onEnter={() => {
                  onApply({ ...view, filters: {}, labels: {} });
                  // The button disappears with the filters it cleared.
                  setTimeout(() => setFocus("lf-filter-0"), 0);
                }}
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
          <div className="no-scrollbar -mx-[0.6vw] overflow-y-auto px-[0.6vw]">{children}</div>
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
      // A uniform height, and a vertical gap wider than the 4% the focus state
      // grows a chip by. Spatial navigation drops a candidate whose top sits
      // inside the focused element's box, so a wrapped grid of chips of
      // different heights loses whole rows to a press - which reads as the
      // D-pad skipping over them.
      className="flex min-h-[6vh] w-full items-center rounded-[0.8vh] bg-white/8 px-[1.4vw] text-[2vh]"
    >
      <span className="inline-block w-[1.4vw] shrink-0 text-center">{active ? "✓" : ""}</span>
      {label}
    </FocusButton>
  );
}
