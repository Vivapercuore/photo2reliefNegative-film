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

/** CMYK, subtractive (kept for the positive/reflective module later). */
export const CMYK_PALETTE: PaletteColor[] = [
  { id: 'C', label: '青', rgb: [0, 174, 239] },
  { id: 'M', label: '品红', rgb: [236, 0, 140] },
  { id: 'Y', label: '黄', rgb: [255, 242, 0] },
  { id: 'K', label: '黑', rgb: [0, 0, 0] },
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
  const pal = palette.map((p) => p.rgb);

  for (let y = 0; y < rows; y++) {
    const ltr = y % 2 === 0; // serpentine
    for (let k = 0; k < cols; k++) {
      const x = ltr ? k : cols - 1 - k;
      const o = (y * cols + x) * 3;
      const r = buf[o], g = buf[o + 1], b = buf[o + 2];

      // nearest palette color (squared Euclidean in RGB)
      let bi = 0, bd = Infinity;
      for (let p = 0; p < pal.length; p++) {
        const dr = r - pal[p][0], dg = g - pal[p][1], db = b - pal[p][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; bi = p; }
      }
      indices[y * cols + x] = bi;

      const er = r - pal[bi][0], eg = g - pal[bi][1], eb = b - pal[bi][2];
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

/** Count cells per palette color (for UI stats / filament usage estimate). */
export function paletteCounts(res: DitherResult): number[] {
  const counts = new Array(res.palette.length).fill(0);
  for (let i = 0; i < res.indices.length; i++) counts[res.indices[i]]++;
  return counts;
}
