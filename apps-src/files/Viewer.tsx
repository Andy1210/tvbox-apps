import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n, isBackKey } from "@sdk";
import type { Photo } from "./api";

// One photo, filling the screen, with the rest of the folder either side of it.
//
// There is no focusable control here, for the reason the film player has none: the
// picture IS the screen, and a focus ring over it would be the only thing on it.
// So the remote's arrows mean the two things a photo needs - page through them, or
// move around inside one once it is enlarged - and which of the two depends on
// whether the photo is enlarged. That overload is the whole interaction, and it is
// why Back has two meanings too: at 1x it leaves, enlarged it steps back out first.
//
// Nothing here decodes a full-size photo. The box renders one at the size the
// panel can actually show (the shell's images.js), which on a 4 GB box is the
// difference between a viewer and a swap storm: a 4000x2252 JPEG costs 36 MB of
// RGBA to hold, and paging through a folder would hold three of them at a time.

const ZOOM_STEPS = [1, 2, 3];
const PAN_STEP = 0.18; // of the visible half-axis, per press: eight or so presses cross the photo
const BANNER_MS = 4000;

// What to ask the box for. The panel is what decides it, not the file: a render
// wider than the screen is detail nobody sees and memory the box does not have.
// The shell snaps this to one of the sizes it offers.
function widthFor(zoom: number) {
  const css = typeof window === "undefined" ? 1920 : window.innerWidth;
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  return Math.min(2560, Math.round(css * dpr * zoom));
}

export function Viewer({
  photos,
  startIndex,
  onClose,
}: {
  photos: Photo[];
  startIndex: number;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [index, setIndex] = useState(startIndex);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 }); // -1..1 of the pannable range
  const [banner, setBanner] = useState(true);
  const [failed, setFailed] = useState(false);
  // Read by the key handler, which is attached once and must not see the state it
  // was created with. Everything it needs lives here rather than in its deps, so
  // that a keypress never races a re-subscribe.
  const live = useRef({ index: startIndex, zoom: 1, pan: { x: 0, y: 0 }, count: photos.length });
  useEffect(() => {
    live.current = { index, zoom, pan, count: photos.length };
  }, [index, zoom, pan, photos.length]);

  const photo = photos[index];
  const width = widthFor(zoom);

  const show = useCallback((next: number) => {
    setIndex(next);
    // A new photo is a new frame to look at, not a continuation of the last one's
    // magnification: staying zoomed would open the next one on some corner of it.
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setFailed(false);
    setBanner(true);
  }, []);

  // The banner names the photo and says where in the folder it is, then gets out of
  // the way. Any press brings it back, because any press is someone looking.
  useEffect(() => {
    if (!banner) return;
    const id = setTimeout(() => setBanner(false), BANNER_MS);
    return () => clearTimeout(id);
  }, [banner, index]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const { index: i, zoom: z, count } = live.current;
      if (isBackKey(ev)) {
        ev.preventDefault();
        // Enlarged, Back is how you get back OUT to the whole photo. Only from
        // there does it leave - otherwise the way out of a zoom would be to guess.
        if (z > 1) {
          setZoom(1);
          setPan({ x: 0, y: 0 });
        } else onClose();
        return;
      }
      const step = (dir: "x" | "y", by: number) => {
        ev.preventDefault();
        setBanner(true);
        setPan((p) => ({ ...p, [dir]: Math.max(-1, Math.min(1, p[dir] + by)) }));
      };
      switch (ev.key) {
        case "Enter":
          ev.preventDefault();
          setBanner(true);
          // One button, cycling: a remote has no second key for "out", and
          // stopping at the end would leave the only way back through Back.
          setZoom(ZOOM_STEPS[(ZOOM_STEPS.indexOf(z) + 1) % ZOOM_STEPS.length] || 1);
          setPan({ x: 0, y: 0 });
          break;
        case "ArrowLeft":
          if (z > 1) return step("x", -PAN_STEP);
          ev.preventDefault();
          setBanner(true);
          // The folder does not wrap. On a TV, arriving back at the first photo
          // after the last one reads as a glitch rather than as an ending.
          if (i > 0) show(i - 1);
          break;
        case "ArrowRight":
          if (z > 1) return step("x", PAN_STEP);
          ev.preventDefault();
          setBanner(true);
          if (i < count - 1) show(i + 1);
          break;
        case "ArrowUp":
          if (z > 1) return step("y", -PAN_STEP);
          ev.preventDefault();
          setBanner(true);
          break;
        case "ArrowDown":
          if (z > 1) return step("y", PAN_STEP);
          ev.preventDefault();
          setBanner(true);
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, show]);

  if (!photo) return null;

  // Panning moves the photo by half its overflow at most, so an edge can be
  // reached but never left behind - a black margin is a dead end on a remote.
  const overflow = ((zoom - 1) / 2) * 100;
  const transform = `scale(${zoom}) translate(${-pan.x * overflow}%, ${-pan.y * overflow}%)`;

  return (
    <div className="fixed inset-0 z-40 bg-black flex items-center justify-center overflow-hidden">
      {failed ? (
        <div className="text-[2.2vh] text-fg-dim px-[10vw] text-center">{t("files.photoFailed")}</div>
      ) : (
        <img
          key={photo.key}
          src={photo.image(width)}
          alt=""
          decoding="async"
          onError={() => setFailed(true)}
          style={{ transform }}
          className="max-h-full max-w-full object-contain transition-transform duration-200"
        />
      )}

      {/* The neighbours, fetched but never shown. The cost of the next photo is the
          box rendering it, not the transfer, so paying it while someone is still
          looking at this one is what makes the arrows feel immediate. */}
      {[index - 1, index + 1].map((i) =>
        photos[i] ? <img key={"pre-" + photos[i].key} src={photos[i].image(widthFor(1))} alt="" className="hidden" /> : null,
      )}

      {banner && (
        <div className="absolute left-0 right-0 bottom-0 px-[4vw] py-[3vh] bg-gradient-to-t from-black/85 to-transparent">
          <div className="text-[2.4vh] font-semibold truncate">{photo.label}</div>
          <div className="text-[1.7vh] text-fg-dim mt-[0.4vh]">
            {t("files.photoOf", { n: index + 1, total: photos.length })}
            {zoom > 1 ? " · " + t("files.zoomedHint") : " · " + t("files.viewerHint")}
          </div>
        </div>
      )}
    </div>
  );
}
