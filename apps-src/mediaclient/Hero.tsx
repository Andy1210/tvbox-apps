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
      {/* The tint and the artwork are FIXED, so they are the page's background
          rather than one band's - the rows scroll over them and the screen keeps
          its colour all the way down. Only the words below are in flow. */}
      <div
        className="pointer-events-none fixed inset-0 z-0 transition-[background] duration-500"
        style={{ background: tint ?? "transparent" }}
        aria-hidden="true"
      />

      {/* The tint is the artwork's own colours, so it is dimmed rather than
          shown: a scrim over it keeps every answer in the band the app's
          background lives in. */}
      {tint && <div className="pointer-events-none fixed inset-0 z-0 bg-bg-0/72" aria-hidden="true" />}

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
