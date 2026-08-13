import { useEffect, useState } from "react";
import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import { FocusButton, useI18n } from "@sdk";
import { Row } from "./Row";
import { Message } from "./Message";
import { CastRow } from "./CastRow";
import { classify, useApp } from "./state";
import type { ItemDetail, MediaItem } from "./backends/types";
import { log } from "./redact";

function runtime(ms: number | undefined): string {
  if (!ms) return "";
  const total = Math.round(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/**
 * One film or series.
 *
 * The cast is the point of this screen as much as the synopsis is: it is the
 * only way into the person pages, and those are the thing a media server's own
 * client cannot do.
 */
export function Detail({ itemId }: { itemId: string }): React.JSX.Element {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const go = useApp((s) => s.go);
  const fail = useApp((s) => s.fail);
  const failure = useApp((s) => s.failure);
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [children, setChildren] = useState<MediaItem[]>([]);

  useEffect(() => {
    if (!backend) return;
    let live = true;
    setDetail(null);
    setChildren([]);

    (async () => {
      try {
        const d = await backend.item(itemId);
        if (!live) return;
        setDetail(d);

        // A series or season has something under it; a film does not, and asking
        // costs a round trip that shows as a pause before the screen settles.
        if (d.kind === "show" || d.kind === "season") {
          const kids = await backend.children(itemId);
          if (live) setChildren(kids);
        }
      } catch (e) {
        if (!live) return;
        log.warn("detail failed", e);
        fail(classify(e));
      }
    })();

    return () => {
      live = false;
    };
  }, [backend, itemId, fail]);

  const { ref, focusKey } = useFocusable({ focusKey: `detail-${itemId}`, saveLastFocusedChild: true });

  if (failure) return <Message failure={failure} />;
  if (!detail) return <Message loading />;

  const poster = (item: MediaItem): string | undefined => backend?.posterUrl(item, 300, 450);
  const resumable = (detail.viewOffsetMs ?? 0) > 0;

  return (
    <FocusContext.Provider value={focusKey}>
      <div ref={ref} className="flex h-full flex-col gap-[2.4vh] overflow-y-auto py-[3vh]">
        <header className="flex flex-col gap-[1.2vh] px-[4vw]">
          <h1 className="text-[3.4vh] leading-tight font-semibold tracking-tight">
            {detail.seriesTitle ?? detail.title}
          </h1>
          {detail.seriesTitle && <p className="text-[2vh] text-fg-dim">{detail.title}</p>}

          <div className="flex flex-wrap items-center gap-[1.4vw] text-[1.7vh] text-fg-dim">
            {detail.year ? <span className="tabular-nums">{detail.year}</span> : null}
            {detail.durationMs ? <span className="tabular-nums">{runtime(detail.durationMs)}</span> : null}
            {detail.contentRating ? (
              <span className="rounded-[0.4vh] border border-white/25 px-[0.6vw] py-[0.1vh]">
                {detail.contentRating}
              </span>
            ) : null}
            {detail.genres?.slice(0, 3).map((g) => <span key={g}>{g}</span>)}
          </div>

          {detail.summary && <p className="max-w-[62vw] text-[2vh] leading-relaxed">{detail.summary}</p>}

          <div className="mt-[1vh] flex gap-[1.2vw]">
            <FocusButton
              focusKey="detail-play"
              onEnter={() => {
                /* playback lands in the next step */
              }}
              className="rounded-[1vh] bg-white/15 px-[2.4vw] py-[1.4vh] text-[2.1vh]"
            >
              {resumable ? t("detail.resume") : t("detail.play")}
            </FocusButton>
          </div>
        </header>

        {children.length > 0 && (
          <Row
            id={`children-${itemId}`}
            title={detail.kind === "show" ? t("detail.seasons") : t("detail.episodes")}
            items={children}
            posterUrl={poster}
            onSelect={(item) => go({ name: "item", itemId: item.id })}
            heightVh={22}
          />
        )}

        {detail.roles.length > 0 && (
          <CastRow
            roles={detail.roles}
            title={t("detail.cast")}
            onSelect={(role) => go({ name: "person", personId: role.id, personName: role.name })}
          />
        )}
      </div>
    </FocusContext.Provider>
  );
}
