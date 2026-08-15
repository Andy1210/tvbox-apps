import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
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
 * The background tint comes from the server's own corner colours where it has
 * them - 1,668 of this library's 1,693 films - and is computed from the artwork
 * only where it does not. See the note beside `tint` below.
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
    // Cleared first. Held, the previous title's picture stayed under the new
    // title - and an item with no art of its own kept the last one entirely.
    setArt(null);
    setAccent(null);
    if (!backend || !item?.art) return;
    // Only when the server gave no colours of its own.
    const needsAccent = !item.colors;
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
      if (needsAccent) void accentFrom(objectUrl, url).then((c) => live && c && setAccent(c));
    });
    return () => {
      live = false;
    };
  }, [backend, item?.id, item?.art]);

  useEffect(() => {
    // Cleared, or the synopsis and cast of the PREVIOUS title sit under the new
    // one's name for a round trip - measured, a title from one film with the
    // blurb and cast of another.
    setDetail(null);
    if (!backend || !artId) return;
    let live = true;
    // Debounced: this is one metadata document per D-pad press otherwise, and
    // they are 29-48 KB each. Scanning a row should cost the row, not the row
    // times a fetch.
    const id = setTimeout(() => {
      void backend
        .item(artId)
        .then((d) => live && setDetail(d))
        .catch(() => live && setDetail(null));
    }, 220);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [backend, artId]);

  if (!item) return null;

  /**
   * The server's four corners where it has them, our own average where it does
   * not.
   *
   * The server derives these from the artwork itself and offers them on 1,668
   * of this library's 1,693 films - free, with no second decode, and four
   * corners make a gradient where one average makes a flat wash. An earlier
   * version of this file claimed the server supplied none; that measurement
   * read the wrong spelling of the field.
   *
   * Held at low opacity for the same reason the average was darkened: these are
   * the artwork's real colours, and at full strength they fight the text.
   */
  const corners = (item.colors ?? detail?.colors) as MediaItem["colors"];
  const tint = corners
    ? `linear-gradient(135deg, ${corners.topLeft} 0%, ${corners.bottomLeft} 45%, ${corners.bottomRight} 100%)`
    : accent;

  const cast = (detail?.roles ?? []).slice(0, 4).map((r) => r.name);
  const title = item.seriesTitle ?? item.title;
  const sub = item.seriesTitle ? item.title : null;

  return (
    <>
      {/* Portalled to the body, and that is the whole point rather than a tidy
          detail. These are fixed layers with z-0, and the page renders inside a
          `relative z-10` container - which forms a stacking context, where a
          positioned child at z-0 paints AFTER the container's in-flow text. So
          they covered the rail's buttons, the row headings and the tile
          captions, while the posters survived because a tile's frame is itself
          positioned. Outside every stacking context, they are simply behind.
          Two earlier attempts read this as clipping and then as flexbox
          squashing; it was neither. */}
      {createPortal(
        <>
          <div
            className="pointer-events-none fixed inset-0 transition-[background] duration-500"
            style={{ background: tint ?? "transparent" }}
            aria-hidden="true"
          />

          {/* The tint is the artwork's own colours, so it is dimmed rather than
          shown: a scrim over it keeps every answer in the band the app's
          background lives in. */}
          {tint && <div className="pointer-events-none fixed inset-0 bg-bg-0/72" aria-hidden="true" />}

          {art && (
            <div
              className="pointer-events-none fixed top-[6vh] right-0 h-[72vh] w-[72vh]"
              aria-hidden="true"
              style={{
                // A circle, not an ellipse: an ellipse stretched to the box takes
                // the shape of the box, which is the thing the mask exists to hide.
                // Sized in vh so it stays round whatever the panel's aspect is.
                //
                // The box is the circle's own bounding square and the circle is
                // centred in it, which is what puts the ARTWORK's centre in the
                // circle: `object-cover` centres what it crops, so an off-centre
                // mask shows an off-centre piece of the picture - it was at 70%
                // across, so every backdrop was seen through its right-hand third.
                // The square also means the circle cannot run off an edge and be
                // cut there, which would put back the straight line the mask is
                // for; at 34vh in a 58vw box it was clipped on the right and top.
                maskImage: "radial-gradient(circle 36vh at 50% 50%, #000 42%, transparent 88%)",
                WebkitMaskImage: "radial-gradient(circle 36vh at 50% 50%, #000 42%, transparent 88%)",
              }}
            >
              <img src={art} alt="" className="h-full w-full object-cover" />
            </div>
          )}
        </>,
        document.body,
      )}

      <section className="relative z-10 flex h-[42vh] w-[46vw] shrink-0 flex-col justify-center gap-[1.2vh] px-[4vw]">
        <TitleArt title={title} logo={detail?.logo} />
        {sub && <p className="text-[2.1vh] text-white/85 [text-shadow:0_0.2vh_0.6vh_rgba(0,0,0,0.8)]">{sub}</p>}
        {detail?.summary && (
          <p className="line-clamp-3 max-w-[42vw] text-[2vh] leading-relaxed [text-shadow:0_0.2vh_0.6vh_rgba(0,0,0,0.8)]">
            {detail.summary}
          </p>
        )}
        {/* Not fg-dim. Measured on the box, that grey over the computed tint is
            3.37:1 - the tint is what takes it under, and these two lines carry
            the episode name and the cast. */}
        {cast.length > 0 && (
          <p className="text-[1.9vh] text-white/80 [text-shadow:0_0.2vh_0.6vh_rgba(0,0,0,0.8)]">
            {t("detail.cast")}: {cast.join(", ")}
          </p>
        )}
      </section>
    </>
  );
}
