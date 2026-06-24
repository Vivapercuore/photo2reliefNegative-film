/**
 * Color-positive dithering core (DOM-free so it runs in a worker and is unit
 * testable). Floyd–Steinberg error diffusion onto a small fixed palette, with
 * the grid resolution capped by the printer's physical dot size.
 *
 * The additive palettes (R/G/B + black/white) suit backlit viewing: dense R/G/B
 * dots mix into bright colors when light shines through, black blocks light.
 */

import {
  RgbCalibration,
  primaryLin,
  projectToHull,
  lin2srgb,
  ynFactorOf,
  ynForward,
  ynInverse,
} from './calibration';

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

/** Area-WEIGHTED resample of an RGBA image to cols×rows float RGB (shared with
 *  the CMYK module). Each source pixel is weighted by its fractional overlap
 *  with the output cell, so every cell covers the same source extent. Integer
 *  pixel boundaries (a varying 2-vs-3-px box) alias a smooth gradient into
 *  cell-to-cell noise that the coarse layer quantization amplifies into speckle. */
export function downsampleRGB(src: RGBAImage, cols: number, rows: number): Float32Array {
  const { width: W, height: H, data } = src;
  const out = new Float32Array(cols * rows * 3);
  for (let ry = 0; ry < rows; ry++) {
    const fy0 = (ry * H) / rows;
    const fy1 = ((ry + 1) * H) / rows;
    const iy0 = Math.floor(fy0);
    const iy1 = Math.min(H - 1, Math.ceil(fy1) - 1);
    for (let rx = 0; rx < cols; rx++) {
      const fx0 = (rx * W) / cols;
      const fx1 = ((rx + 1) * W) / cols;
      const ix0 = Math.floor(fx0);
      const ix1 = Math.min(W - 1, Math.ceil(fx1) - 1);
      let r = 0,
        g = 0,
        b = 0,
        wsum = 0;
      for (let y = iy0; y <= iy1; y++) {
        const wy = Math.min(y + 1, fy1) - Math.max(y, fy0);
        if (wy <= 0) continue;
        for (let x = ix0; x <= ix1; x++) {
          const wx = Math.min(x + 1, fx1) - Math.max(x, fx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = (y * W + x) * 4;
          r += data[i] * w;
          g += data[i + 1] * w;
          b += data[i + 2] * w;
          wsum += w;
        }
      }
      const o = (ry * cols + rx) * 3;
      if (wsum > 0) {
        out[o] = r / wsum;
        out[o + 1] = g / wsum;
        out[o + 2] = b / wsum;
      }
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
  palette: PaletteColor[],
  cal?: RgbCalibration
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
  // Palette colours in linear 0..255. When CALIBRATED, use each filament's REAL
  // measured colour instead of the ideal primary — the core of the 偏色 fix.
  // (Uncalibrated keeps the ideal primaries, so behaviour is the legacy one
  // apart from the always-on Yule-Nielsen mixing below.)
  const calibrated = !!(cal && cal.calibrated);
  const pal = calibrated
    ? palette.map((p) => primaryLin(cal!, p.id).map((v) => 255 * v))
    : palette.map((p) => p.rgb.map(srgb2lin));

  // (1) Uncalibrated cheap gamut clamp — bright saturated secondaries (e.g. pure
  // yellow needs r=g=1) are unreachable side-by-side; scaling them onto the
  // ideal hull keeps the diffusion error bounded. Done in LINEAR space, before
  // the YN transform. (Calibrated uses the exact hull projection in step 3.)
  if (!calibrated && palette.some((p) => p.id === 'K')) {
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

  // (2) Yule-Nielsen optical dot gain (DEFAULT-ON): adjacent dots read DARKER
  // than the linear average because light spreads sideways between them. Working
  // in YN space (channel^(1/n)) makes the spatial average THERE equal the
  // perceived colour, so matching + error diffusion compensate for the darkening
  // (more bright dots) and stay consistent with the simulated preview. n=1 (no
  // calibration object at all) is a no-op = legacy linear mixing.
  const yn = ynFactorOf(cal);
  if (yn !== 1) {
    const fwd = (v: number) => 255 * ynForward(v / 255, yn);
    for (let i = 0; i < buf.length; i++) buf[i] = fwd(buf[i]);
    for (const c of pal) {
      c[0] = fwd(c[0]);
      c[1] = fwd(c[1]);
      c[2] = fwd(c[2]);
    }
  }

  // (3) Calibrated: project every pixel onto the convex hull of the measured
  // primaries (now in YN space) — the reachable perceived set. Keeps the
  // diffusion residual bounded with the smaller real gamut and covers RGBW
  // (no K), which the cheap clamp above can't handle.
  if (calibrated) {
    for (let i = 0; i < buf.length; i += 3) {
      const p = projectToHull([buf[i], buf[i + 1], buf[i + 2]], pal);
      buf[i] = p[0];
      buf[i + 1] = p[1];
      buf[i + 2] = p[2];
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

/** Expand a dither result back to an RGBA buffer for on-screen preview. When a
 *  calibration is supplied the dots are drawn in their REAL measured colours so
 *  the zoomed dot map matches the print. */
export function indicesToRGBA(res: DitherResult, cal?: RgbCalibration): Uint8ClampedArray {
  const { cols, rows, indices, palette } = res;
  const colors = palette.map((p) =>
    cal && cal.calibrated ? primaryLin(cal, p.id).map((v) => 255 * lin2srgb(v)) : p.rgb
  );
  const out = new Uint8ClampedArray(cols * rows * 4);
  for (let i = 0; i < indices.length; i++) {
    const c = colors[indices[i]];
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
  block: number,
  cal?: RgbCalibration
): { data: Uint8ClampedArray; width: number; height: number } {
  const { cols, rows, indices, palette } = res;
  // Average the REAL measured colours when calibrated, else the ideal primaries.
  const palLin =
    cal && cal.calibrated
      ? palette.map((p) => primaryLin(cal, p.id))
      : palette.map((p) =>
          p.rgb.map((v) => {
            const n = v / 255;
            return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
          })
        );
  // Average in Yule-Nielsen space (channel^(1/n)) so the blend matches the
  // perceived optical dot gain — then invert back to linear before encoding.
  // n=1 makes palY === palLin and the inverse an identity (old behaviour).
  const yn = ynFactorOf(cal);
  const palY = palLin.map((c) => [ynForward(c[0], yn), ynForward(c[1], yn), ynForward(c[2], yn)]);
  const enc = (n: number) =>
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
          const c = palY[indices[y * cols + x]];
          r += c[0];
          g += c[1];
          b += c[2];
          n++;
        }
      }
      const o = (oy * W + ox) * 4;
      out[o] = enc(ynInverse(r / n, yn));
      out[o + 1] = enc(ynInverse(g / n, yn));
      out[o + 2] = enc(ynInverse(b / n, yn));
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
