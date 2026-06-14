/**
 * Color-positive dithering core (DOM-free so it runs in a worker and is unit
 * testable). Floyd–Steinberg error diffusion onto a small fixed palette, with
 * the grid resolution capped by the printer's physical dot size.
 *
 * The additive palettes (R/G/B + black/white) suit backlit viewing: dense R/G/B
 * dots mix into bright colors when light shines through, black blocks light.
 */

export interface PaletteColor {
  /** short id used in UI / as the per-color object name */
  id: string;
  /** display label */
  label: string;
  /** target color, 0-255 */
  rgb: [number, number, number];
}

/** RGB + black, additive (for backlit viewing). */
export const RGBK_PALETTE: PaletteColor[] = [
  { id: 'R', label: '红', rgb: [255, 0, 0] },
  { id: 'G', label: '绿', rgb: [0, 255, 0] },
  { id: 'B', label: '蓝', rgb: [0, 0, 255] },
  { id: 'K', label: '黑', rgb: [0, 0, 0] },
];

/** RGB + white — white fills the highlights (better for reflective viewing). */
export const RGBW_PALETTE: PaletteColor[] = [
  { id: 'R', label: '红', rgb: [255, 0, 0] },
  { id: 'G', label: '绿', rgb: [0, 255, 0] },
  { id: 'B', label: '蓝', rgb: [0, 0, 255] },
  { id: 'W', label: '白', rgb: [255, 255, 255] },
];

/**
 * RGB + black + white. Black anchors the shadows (and acts as the backing),
 * white fills the highlights, R/G/B carry the color. Having both grayscale
 * anchors avoids the "everything dithers into bright noise" failure that pure
 * RGB+white hits on dark images.
 */
export const RGBKW_PALETTE: PaletteColor[] = [
  { id: 'R', label: '红', rgb: [255, 0, 0] },
  { id: 'G', label: '绿', rgb: [0, 255, 0] },
  { id: 'B', label: '蓝', rgb: [0, 0, 255] },
  { id: 'K', label: '黑', rgb: [0, 0, 0] },
  { id: 'W', label: '白', rgb: [255, 255, 255] },
];

/**
 * CMY + White for the backlit color-lithophane module. The 4th filament is
 * WHITE, not black: a translucent diffuser whose thickness sets luminance
 * (thicker = dimmer, lithophane-style 明度), with C/M/Y on top carrying colour.
 * (Name kept as CMYK_PALETTE since the module/route is "color-cmyk".)
 */
export const CMYK_PALETTE: PaletteColor[] = [
  { id: 'C', label: '青', rgb: [0, 174, 239] },
  { id: 'M', label: '品红', rgb: [236, 0, 140] },
  { id: 'Y', label: '黄', rgb: [255, 242, 0] },
  { id: 'W', label: '白', rgb: [255, 255, 255] },
];

/** Minimal ImageData shape (so this file needs no DOM lib). */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface GridSize {
  cols: number;
  rows: number;
  /** physical size of one dot (mm) = nozzle / 2 */
  dotMm: number;
  /** finished image-area size (mm) at this grid */
  widthMm: number;
  heightMm: number;
}

/**
 * Derive the dot grid from the printed size: long edge (mm) ÷ dot size (mm) =
 * dots along the long edge. A bigger image area (or smaller dots) always means
 * more dots — small sources are upsampled (nearest) rather than capping the
 * grid at the source pixel count, so growing the image area never silently
 * stops adding pixels.
 */
export function gridSizeFor(
  imgW: number,
  imgH: number,
  maxLengthMm: number,
  dotMm: number
): GridSize {
  const longPx = Math.max(imgW, imgH, 1);
  const maxDotsLong = Math.max(1, Math.floor(maxLengthMm / dotMm));
  const scale = maxDotsLong / longPx;
  const cols = Math.max(1, Math.round(imgW * scale));
  const rows = Math.max(1, Math.round(imgH * scale));
  return { cols, rows, dotMm, widthMm: cols * dotMm, heightMm: rows * dotMm };
}

/** Area-average resample of an RGBA image to cols×rows float RGB (shared with the CMYK module). */
export function downsampleRGB(src: RGBAImage, cols: number, rows: number): Float32Array {
  const { width: W, height: H, data } = src;
  const out = new Float32Array(cols * rows * 3);
  for (let ry = 0; ry < rows; ry++) {
    const y0 = Math.floor((ry * H) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * H) / rows));
    for (let rx = 0; rx < cols; rx++) {
      const x0 = Math.floor((rx * W) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * W) / cols));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * W + x) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          n++;
        }
      }
      const o = (ry * cols + rx) * 3;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
    }
  }
  return out;
}

export interface DitherResult {
  cols: number;
  rows: number;
  dotMm: number;
  /** palette index (0..palette.length-1) per cell, row-major */
  indices: Uint8Array;
  palette: PaletteColor[];
}

/**
 * Floyd–Steinberg dither a downsampled RGB buffer onto `palette`. Serpentine
 * scan (alternating row direction) avoids directional worming artifacts.
 */
export function ditherToPalette(
  src: RGBAImage,
  cols: number,
  rows: number,
  dotMm: number,
  palette: PaletteColor[]
): DitherResult {
  const buf = downsampleRGB(src, cols, rows);
  const indices = new Uint8Array(cols * rows);

  // Match and diffuse in LINEAR light (0..255 scale): the printed dots mix
  // additively in linear intensity when backlit, so gamma-space matching picks
  // visibly wrong mixes (whites overused, hues locking into solid patches).
  const srgb2lin = (v: number) => {
    const n = v / 255;
    return 255 * (n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4));
  };
  for (let i = 0; i < buf.length; i++) buf[i] = srgb2lin(buf[i]);
  const pal = palette.map((p) => p.rgb.map(srgb2lin));

  // Project each pixel into the palette's achievable gamut (the convex hull of
  // the dot colors in linear light). Side-by-side dots DILUTE: a mix of
  // fractions f_R+f_G+f_B+f_W+f_K=1 can only reach r+g+b−2·min(r,g,b) ≤ 1 —
  // bright saturated secondaries (pure yellow needs r=g=1 simultaneously) are
  // physically unreachable, and feeding them to error diffusion makes the
  // residual grow without bound: channels pin at the clamp, ties collapse to
  // the first palette entry (yellow → solid red), and the dragged error bleeds
  // into neighbouring regions. Scaling the pixel onto the hull keeps hue and
  // saturation, trades only brightness — and keeps the diffusion error bounded.
  // (Only valid when the palette has K as the "empty" filler.)
  if (palette.some((p) => p.id === 'K')) {
    for (let i = 0; i < buf.length; i += 3) {
      const m = Math.min(buf[i], buf[i + 1], buf[i + 2]);
      const excess = buf[i] + buf[i + 1] + buf[i + 2] - 2 * m;
      if (excess > 255) {
        const s = 255 / excess;
        buf[i] *= s;
        buf[i + 1] *= s;
        buf[i + 2] *= s;
      }
    }
  }

  // Safety net for residual accumulation at region boundaries: allow one full
  // step of legit overshoot headroom (mixing needs it to force the next pick),
  // drop anything beyond as runaway.
  const clampStep = (v: number) => (v < -255 ? -255 : v > 510 ? 510 : v);

  for (let y = 0; y < rows; y++) {
    const ltr = y % 2 === 0; // serpentine
    for (let k = 0; k < cols; k++) {
      const x = ltr ? k : cols - 1 - k;
      const o = (y * cols + x) * 3;
      const r = clampStep(buf[o]), g = clampStep(buf[o + 1]), b = clampStep(buf[o + 2]);

      // nearest palette color (squared Euclidean in linear RGB); start the
      // scan at a per-cell offset so exact ties (e.g. yellow ↔ R/G) alternate
      // spatially instead of always collapsing to the first palette entry
      const start = (x + y * 3) % pal.length;
      let bi = start, bd = Infinity;
      for (let q = 0; q < pal.length; q++) {
        const p = (start + q) % pal.length;
        const dr = r - pal[p][0], dg = g - pal[p][1], db = b - pal[p][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; bi = p; }
      }
      indices[y * cols + x] = bi;

      const er = r - pal[bi][0],
        eg = g - pal[bi][1],
        eb = b - pal[bi][2];
      const dir = ltr ? 1 : -1;
      const spread = (xx: number, yy: number, f: number) => {
        if (xx < 0 || xx >= cols || yy < 0 || yy >= rows) return;
        const oo = (yy * cols + xx) * 3;
        buf[oo] += er * f;
        buf[oo + 1] += eg * f;
        buf[oo + 2] += eb * f;
      };
      spread(x + dir, y, 7 / 16);
      spread(x - dir, y + 1, 3 / 16);
      spread(x, y + 1, 5 / 16);
      spread(x + dir, y + 1, 1 / 16);
    }
  }

  return { cols, rows, dotMm, indices, palette };
}

/** Expand a dither result back to an RGBA buffer for on-screen preview. */
export function indicesToRGBA(res: DitherResult): Uint8ClampedArray {
  const { cols, rows, indices, palette } = res;
  const out = new Uint8ClampedArray(cols * rows * 4);
  for (let i = 0; i < indices.length; i++) {
    const c = palette[indices[i]].rgb;
    const o = i * 4;
    out[o] = c[0];
    out[o + 1] = c[1];
    out[o + 2] = c[2];
    out[o + 3] = 255;
  }
  return out;
}

/**
 * Physically-simulated preview: average the dot colors over `block`×`block`
 * cells in LINEAR light (what the eye does with backlit dots at viewing
 * distance) and encode back to sRGB. Unlike the raw dot map — which browsers
 * downscale in gamma space, making it look harsher/more saturated than the
 * print — this approximates what the finished sheet will actually look like.
 */
export function simulateRGBA(
  res: DitherResult,
  block: number
): { data: Uint8ClampedArray; width: number; height: number } {
  const { cols, rows, indices, palette } = res;
  const palLin = palette.map((p) =>
    p.rgb.map((v) => {
      const n = v / 255;
      return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
    })
  );
  const lin2srgb = (n: number) =>
    255 * (n <= 0.0031308 ? 12.92 * n : 1.055 * Math.pow(n, 1 / 2.4) - 0.055);

  const W = Math.ceil(cols / block);
  const H = Math.ceil(rows / block);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let oy = 0; oy < H; oy++) {
    const y0 = oy * block;
    const y1 = Math.min(rows, y0 + block);
    for (let ox = 0; ox < W; ox++) {
      const x0 = ox * block;
      const x1 = Math.min(cols, x0 + block);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const c = palLin[indices[y * cols + x]];
          r += c[0];
          g += c[1];
          b += c[2];
          n++;
        }
      }
      const o = (oy * W + ox) * 4;
      out[o] = lin2srgb(r / n);
      out[o + 1] = lin2srgb(g / n);
      out[o + 2] = lin2srgb(b / n);
      out[o + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}

/** Count cells per palette color (for UI stats / filament usage estimate). */
export function paletteCounts(res: DitherResult): number[] {
  const counts = new Array(res.palette.length).fill(0);
  for (let i = 0; i < res.indices.length; i++) counts[res.indices[i]]++;
  return counts;
}
