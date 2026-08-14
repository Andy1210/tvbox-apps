import { useEffect, useState } from "react";
import { useI18n } from "@sdk";
import { accentFrom } from "./accent";
import { loadImage } from "./posters";
import { TitleArt } from "./TitleArt";
import { useApp } from "./state";
import type { ItemDetail, MediaItem } from "./backends/types";
import { log } from "./redact";

/**
 * What the cursor is on, in full, above the rows.
 *
 * The shape is the one the Plex client uses and it earns its place: the title,
 * the synopsis and the cast on the LEFT, where a reader starts, and the
 * artwork on the RIGHT with nothing written over it. A full-bleed backdrop with
 * text laid across it has to be dimmed so hard that the artwork stops being
 * worth showing; separating them means the picture can be bright and the words
 * can be read.
 *
 * The artwork is masked with a radial fade rather than cropped to a rectangle,
 * so it has no edge to notice - it thins into the background instead of sitting
 * in a frame.
 *
 * The background tint is computed from the artwork, because this server does
 * not supply one: measured, 0 of 1,693 films carry Plex's own accent colours.
 */
export function Hero({ item }: { item: MediaItem | null }): React.JSX.Element | null {
  const { t } = useI18n();
  const backend = useApp((s) => s.backend);
  const [art, setArt] = useState<string | null>(null);
  const [accent, setAccent] = useState<string | null>(null);
  const [detail, setDetail] = useState<ItemDetail | null>(null);

  // The series, when the cursor is on an episode: its art, its name and its
  // cast are what someone is choosing between, not one episode's.
  const artId = item?.seriesId ?? item?.id;

  useEffect(() => {
    if (!backend || !item?.art) return;
    const url = backend.backdropUrl(item, 960, 540);
    if (!url) return;
    let live = true;
    void loadImage(url, backend.imageHeaders()).then((objectUrl) => {
      if (!live) return;
      if (!objectUrl) {
        log.warn("hero art did not load");
        return;
      }
      setArt(objectUrl);
      void accentFrom(objectUrl).then((c) => live && c && setAccent(c));
    });
    return () => {
      live = false;
    };
  }, [backend, item?.id, item?.art]);

  useEffect(() => {
    if (!backend || !artId) return;
    let live = true;
    // Cached by the backend, so moving back along a row costs nothing.
    void backend
      .item(artId)
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail(null));
    return () => {
      live = false;
    };
  }, [backend, artId]);

  if (!item) return null;

  const cast = (detail?.roles ?? []).slice(0, 4).map((r) => r.name);
  const title = item.seriesTitle ?? item.title;
  const sub = item.seriesTitle ? item.title : null;

  return (
    <>
      {/* The tint and the artwork are FIXED, so they are the page's background
          rather than one band's - the rows scroll over them and the screen keeps
          its colour all the way down. Only the words below are in flow. */}
      <div
        className="pointer-events-none fixed inset-0 z-0 transition-colors duration-500"
        style={{ background: accent ?? "transparent" }}
        aria-hidden="true"
      />

      {art && (
        <div
          className="pointer-events-none fixed top-0 right-0 z-0 h-[62vh] w-[58vw]"
          aria-hidden="true"
          style={{
            // A circle, not an ellipse: an ellipse stretched to the box takes
            // the shape of the box, which is the thing the mask exists to hide.
            // Sized in vh so it stays round whatever the panel's aspect is, and
            // small enough to fade out INSIDE the 62vh box - a circle that runs
            // past the edge is cut off there, which puts back the straight line
            // the mask is for.
            maskImage: "radial-gradient(circle 34vh at 70% 45%, #000 42%, transparent 88%)",
            WebkitMaskImage: "radial-gradient(circle 34vh at 70% 45%, #000 42%, transparent 88%)",
          }}
        >
          <img src={art} alt="" className="h-full w-full object-cover" />
        </div>
      )}

      <section className="relative z-10 flex h-[42vh] w-[46vw] shrink-0 flex-col justify-center gap-[1.2vh] px-[4vw]">
        <TitleArt title={title} logo={detail?.logo} />
        {sub && <p className="text-[2.1vh] text-fg-dim">{sub}</p>}
        {detail?.summary && (
          <p className="line-clamp-3 max-w-[42vw] text-[2vh] leading-relaxed [text-shadow:0_0.2vh_0.6vh_rgba(0,0,0,0.8)]">
            {detail.summary}
          </p>
        )}
        {cast.length > 0 && (
          <p className="text-[1.9vh] text-fg-dim">
            {t("detail.cast")}: {cast.join(", ")}
          </p>
        )}
      </section>
    </>
  );
}
