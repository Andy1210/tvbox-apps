// The colour a piece of artwork is "about".
//
// The server does not supply one - measured, 0 of this library's 1,693 films
// carry Plex's own `ultraBlurColors` - so it is computed here, from the image
// that is already loaded and decoded.

const cache = new Map<string, string>();

/**
 * Average the artwork down to one colour, biased away from mud.
 *
 * Drawn at 16x9 rather than full size: that is 144 pixels to read instead of
 * nine hundred thousand, it costs one decode that has already happened, and a
 * backdrop's colour is a broad thing anyway. On a Pi the difference between
 * those two is the difference between imperceptible and a visible hitch every
 * time the cursor moves.
 *
 * Saturation is weighted up and near-black pixels are dropped, because an
 * average over a dark frame is a dark grey - technically the mean, and useless
 * as an accent. What we want is the colour someone would name if asked.
 */
export async function accentFrom(objectUrl: string): Promise<string | null> {
  const hit = cache.get(objectUrl);
  if (hit) return hit;

  const img = await load(objectUrl);
  if (!img) return null;

  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 9;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, 16, 9);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, 16, 9).data;
  } catch {
    // A canvas tainted by a cross-origin image. Blob URLs are same-origin, so
    // this should not happen - but a null accent is a plain background rather
    // than a crash.
    return null;
  }

  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [pr, pg, pb] = [data[i], data[i + 1], data[i + 2]];
    const max = Math.max(pr, pg, pb);
    const min = Math.min(pr, pg, pb);
    if (max < 24) continue; // near-black: carries no hue worth having
    // Saturation as the weight, with a floor so a wholly grey image still
    // averages to something rather than to nothing.
    const w = (max - min) / 255 + 0.15;
    r += pr * w;
    g += pg * w;
    b += pb * w;
    weight += w;
  }
  if (weight === 0) return null;

  const accent = mix(r / weight, g / weight, b / weight);
  cache.set(objectUrl, accent);
  return accent;
}

/**
 * Pull the result toward a usable ground.
 *
 * A saturated average is a colour, not a background: at full strength it fights
 * the text over it. This darkens it and caps how vivid it can get, so every
 * answer lands in the same narrow band of "dark, tinted" that the app's own
 * background already lives in.
 */
function mix(r: number, g: number, b: number): string {
  const to = (v: number): number => Math.round(Math.min(255, Math.max(0, v)) * 0.34);
  return `rgb(${to(r)}, ${to(g)}, ${to(b)})`;
}

function load(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
