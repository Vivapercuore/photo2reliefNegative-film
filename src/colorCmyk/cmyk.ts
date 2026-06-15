/**
 * CMYK thickness-field core (DOM-free, unit testable). Unlike the
 * color-positive module — which dithers fixed-thickness dots and mixes color
 * by dot density — this module reproduces tone CONTINUOUSLY: each of the four
 * channels (C/M/Y/K) gets a local thickness proportional to its ink density,
 * quantized to whole print layers. Stacked translucent layers viewed with a
 * backlight mix subtractively; thicker = darker (厚度控制明度).
 */
import { RGBAImage, downsampleRGB, CMYK_PALETTE } from '../colorPositive/dither';
import {
  CmykCalibration,
  makeLithophaneSolver,
  saturationLayers,
  transmit,
  srgb2lin,
  lin2srgb,
  relLum,
} from './calibration';

export { CMYK_PALETTE };

/** Channel order everywhere in this module: C, M, Y, K. */
export const CHANNELS = ['C', 'M', 'Y', 'K'] as const;

export interface CmykField {
  cols: number;
  rows: number;
  /** physical size of one pixel cell (mm) */
  dotMm: number;
  /** per-cell thickness in LAYERS, row-major — channel order C, M, Y, K */
  channels: [Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  /** per-channel layer ceiling (C,M,Y,W) — calibration-derived "full ink",
   *  optionally lowered by the manual override; the per-pixel solve is clamped
   *  to this, bounding stacked height */
  caps: [number, number, number, number];
}

export interface QuantizeOptions {
  /** filament calibration driving the colour→thickness solve */
  cal: CmykCalibration;
  /** print layer height (mm) — the thickness quantum */
  layerMm: number;
  /** minimum white floor under every cell, in layers — the diffuser base that
   *  evens out the backlight and stops pure-white cells becoming holes; its
   *  absorption is removed from the target before solving (the print always has
   *  it), so the White channel solved here is EXTRA white above the floor */
  baseLayers: number;
  /** white cap on TOP of every column, in layers — fixed white like the floor,
   *  on the viewing side. Its absorption is removed from the target too. */
  topLayers: number;
  /** optional target TOTAL thickness (mm, incl. white floor + top cap). The
   *  colour layers are scaled so the tallest column hits this; the fixed white
   *  (floor + top) is unchanged. undefined = natural thickness (scale 1).
   *  Thinner = lighter/less saturated, thicker = more saturated up to ceiling. */
  targetTotalMm?: number;
}

/** linear sRGB (0..1) → CIELAB (D65), for perceptual colour distance. */
function linToLab(r: number, g: number, b: number): [number, number, number] {
  const x = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / 0.95047);
  const fy = f(y);
  const fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Squared CIELAB ΔE76 (monotonic in ΔE, so we skip the sqrt). */
function deltaE2(a: [number, number, number], b: [number, number, number]): number {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return dl * dl + da * da + db * db;
}

/**
 * Resample the photo to the dot grid and, per cell, solve the calibrated
 * transmission model for the per-filament thicknesses that best reproduce the
 * colour under backlight, quantized to whole print layers. White (filament 3)
 * is the neutral luminance/diffuser layer; the white floor's absorption is
 * removed from the target first, so the solved channel layers are the ink ON
 * TOP of the floor (matching how buildCmykParts stacks them).
 *
 * Out-of-gamut colours (this ink set can't make saturated cyan/green) are
 * gamut-mapped by hue-preserving, constant-luminance chroma clipping: we try a
 * few desaturation factors toward the same-luminance gray and keep the one
 * whose PRINTED colour is perceptually closest (min CIELAB ΔE) to the target.
 */
export function quantizeCmyk(
  src: RGBAImage,
  cols: number,
  rows: number,
  dotMm: number,
  opts: QuantizeOptions
): CmykField {
  const { cal, layerMm, baseLayers, topLayers, targetTotalMm } = opts;
  const buf = downsampleRGB(src, cols, rows);
  const n = cols * rows;
  // Fixed white present on EVERY cell = floor (bottom) + cap (top). Both attenuate
  // the backlight (Beer–Lambert is order-independent), so they combine.
  const fixedWhiteMm = (baseLayers + topLayers) * layerMm;
  const baseT: [number, number, number] = [
    Math.exp(-cal.alpha[3][0] * fixedWhiteMm),
    Math.exp(-cal.alpha[3][1] * fixedWhiteMm),
    Math.exp(-cal.alpha[3][2] * fixedWhiteMm),
  ];

  // Per-channel ceiling: the calibration-derived "full ink" thickness (beyond
  // which more of that filament is invisible). Bounds the per-pixel solve.
  const caps = saturationLayers(cal, layerMm);
  const capMm = caps.map((c) => c * layerMm) as [number, number, number, number];
  // The solver clamps each filament to its ceiling, so every pixel is solved
  // INDEPENDENTLY to its closest printable colour — no global rescaling that
  // would let the darkest pixel desaturate the whole image.
  const solve = makeLithophaneSolver(cal, 2e-3, capMm);

  // CIELAB of the colour a thickness stack reproduces (incl. white floor).
  const th = [0, 0, 0, 0];
  const reproLab = (t: number[]): [number, number, number] => {
    th[0] = t[0];
    th[1] = t[1];
    th[2] = t[2];
    th[3] = t[3] + fixedWhiteMm;
    const lin = transmit(cal, th);
    return linToLab(lin[0], lin[1], lin[2]);
  };
  // Chroma factors to try: 1 = full chroma, 0 = same-luminance neutral gray.
  const SVALS = [1, 0.7, 0.45, 0.28, 0.14, 0];
  const IN_GAMUT_DE2 = 9; // ΔE ≤ 3 ⇒ full chroma already matches, skip the search

  // Pass 1: gamut-mapped solve per pixel → store float thicknesses (mm) and
  // track the natural tallest colour stack (sum of C/M/Y/W-extra), so we can
  // scale to a requested total thickness without re-solving.
  const tBuf = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  let naturalChannelMaxMm = 0;
  for (let i = 0; i < n; i++) {
    const r0 = srgb2lin(buf[i * 3] / 255);
    const g0 = srgb2lin(buf[i * 3 + 1] / 255);
    const b0 = srgb2lin(buf[i * 3 + 2] / 255);
    const labT = linToLab(r0, g0, b0); // perceptual target
    const yt = relLum(r0, g0, b0); // luminance held constant along the chroma line

    // full chroma first; only desaturate if it isn't already a close match
    let bestT = solve([r0 / baseT[0], g0 / baseT[1], b0 / baseT[2]]);
    let bestE = deltaE2(reproLab(bestT), labT);
    if (bestE > IN_GAMUT_DE2) {
      for (let k = 1; k < SVALS.length; k++) {
        const s = SVALS[k];
        const cr = yt + s * (r0 - yt);
        const cg = yt + s * (g0 - yt);
        const cb = yt + s * (b0 - yt);
        const ts = solve([cr / baseT[0], cg / baseT[1], cb / baseT[2]]);
        const e = deltaE2(reproLab(ts), labT);
        if (e < bestE) {
          bestE = e;
          bestT = ts;
        }
      }
    }
    let sum = 0;
    for (let f = 0; f < 4; f++) {
      tBuf[f][i] = bestT[f];
      sum += bestT[f];
    }
    if (sum > naturalChannelMaxMm) naturalChannelMaxMm = sum;
  }

  // Thickness scale: stretch/shrink the colour layers so the tallest column
  // reaches targetTotalMm (white floor fixed). Default 1 = natural thickness.
  let scale = 1;
  if (targetTotalMm && naturalChannelMaxMm > 1e-6) {
    scale = (targetTotalMm - fixedWhiteMm) / naturalChannelMaxMm;
    if (scale < 0.05) scale = 0.05;
    else if (scale > 8) scale = 8;
  }

  // Pass 2: scale + quantize to whole layers, clamp at the per-channel ceiling.
  const C = new Uint8Array(n);
  const M = new Uint8Array(n);
  const Y = new Uint8Array(n);
  const W = new Uint8Array(n);
  const out = [C, M, Y, W];
  for (let i = 0; i < n; i++) {
    for (let f = 0; f < 4; f++) {
      let lv = Math.round((tBuf[f][i] * scale) / layerMm);
      if (lv < 0) lv = 0;
      else if (lv > caps[f]) lv = caps[f];
      out[f][i] = lv;
    }
  }
  return { cols, rows, dotMm, channels: [C, M, Y, W], caps };
}

/**
 * Recombine the quantized field to RGBA for the on-screen preview using the
 * calibrated Beer–Lambert transmission stack — i.e. what the finished backlit
 * print should actually look like (includes the white diffuser floor).
 */
export function cmykToRGBA(
  field: CmykField,
  cal: CmykCalibration,
  layerMm: number,
  baseLayers: number,
  topLayers = 0
): Uint8ClampedArray {
  const { cols, rows, channels } = field;
  const [C, M, Y, W] = channels;
  const fixedWhiteMm = (baseLayers + topLayers) * layerMm;
  const out = new Uint8ClampedArray(cols * rows * 4);
  const th = [0, 0, 0, 0];
  for (let i = 0; i < cols * rows; i++) {
    th[0] = C[i] * layerMm;
    th[1] = M[i] * layerMm;
    th[2] = Y[i] * layerMm;
    th[3] = W[i] * layerMm + fixedWhiteMm; // white floor + top cap + extra white
    const lin = transmit(cal, th);
    const o = i * 4;
    out[o] = 255 * lin2srgb(lin[0]);
    out[o + 1] = 255 * lin2srgb(lin[1]);
    out[o + 2] = 255 * lin2srgb(lin[2]);
    out[o + 3] = 255;
  }
  return out;
}

export interface CmykStats {
  /** average ink (0..1) per channel — rough filament-usage indicator */
  avgInk: [number, number, number, number];
  /** max thickness a single channel reaches anywhere, in LAYERS (C,M,Y,W) */
  maxLayers: [number, number, number, number];
  /** min / max stacked thickness in LAYERS (channels only, no base) */
  minLevels: number;
  maxLevelsTotal: number;
}

/** Per-channel average/peak ink and the stacked-thickness range across cells. */
export function cmykStats(field: CmykField): CmykStats {
  const { channels, caps, cols, rows } = field;
  const n = cols * rows;
  const sums = [0, 0, 0, 0];
  const peak = [0, 0, 0, 0];
  let minL = Infinity;
  let maxL = -Infinity;
  for (let i = 0; i < n; i++) {
    let t = 0;
    for (let ch = 0; ch < 4; ch++) {
      const v = channels[ch][i];
      sums[ch] += v;
      if (v > peak[ch]) peak[ch] = v;
      t += v;
    }
    if (t < minL) minL = t;
    if (t > maxL) maxL = t;
  }
  return {
    // normalize each channel by its OWN ceiling (caps differ per filament now)
    avgInk: sums.map((s, ch) => (caps[ch] > 0 ? s / (n * caps[ch]) : 0)) as [
      number,
      number,
      number,
      number,
    ],
    maxLayers: peak as [number, number, number, number],
    minLevels: minL,
    maxLevelsTotal: maxL,
  };
}
