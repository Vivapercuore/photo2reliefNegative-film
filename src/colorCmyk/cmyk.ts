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
  transmit,
  srgb2lin,
  lin2srgb,
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
  /** per-channel layer cap (bounds total stacked height) */
  maxLevels: number;
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
  /** per-channel layer cap */
  maxLevels: number;
}

/**
 * Resample the photo to the dot grid and, per cell, solve the calibrated
 * transmission model for the per-filament thicknesses that best reproduce the
 * colour under backlight, quantized to whole print layers. White (filament 3)
 * is the neutral luminance/diffuser layer; the white floor's absorption is
 * removed from the target first, so the solved channel layers are the ink ON
 * TOP of the floor (matching how buildCmykParts stacks them).
 */
export function quantizeCmyk(
  src: RGBAImage,
  cols: number,
  rows: number,
  dotMm: number,
  opts: QuantizeOptions
): CmykField {
  const { cal, layerMm, baseLayers, maxLevels } = opts;
  const buf = downsampleRGB(src, cols, rows);
  const n = cols * rows;
  const C = new Uint8Array(n);
  const M = new Uint8Array(n);
  const Y = new Uint8Array(n);
  const W = new Uint8Array(n);
  const solve = makeLithophaneSolver(cal);
  const baseMm = baseLayers * layerMm;
  // White-floor absorption already present under every cell (linear transmission).
  const baseT: [number, number, number] = [
    Math.exp(-cal.alpha[3][0] * baseMm),
    Math.exp(-cal.alpha[3][1] * baseMm),
    Math.exp(-cal.alpha[3][2] * baseMm),
  ];
  const out = [C, M, Y, W];
  for (let i = 0; i < n; i++) {
    // target in linear light, divided by what the white floor already
    // contributes so the solver only makes up the REMAINING density
    const tgt = [
      srgb2lin(buf[i * 3] / 255) / baseT[0],
      srgb2lin(buf[i * 3 + 1] / 255) / baseT[1],
      srgb2lin(buf[i * 3 + 2] / 255) / baseT[2],
    ];
    const t = solve(tgt); // mm per filament (C,M,Y,W-extra)
    for (let f = 0; f < 4; f++) {
      let lv = Math.round(t[f] / layerMm);
      if (lv < 0) lv = 0;
      else if (lv > maxLevels) lv = maxLevels;
      out[f][i] = lv;
    }
  }
  return { cols, rows, dotMm, channels: [C, M, Y, W], maxLevels };
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
  baseLayers: number
): Uint8ClampedArray {
  const { cols, rows, channels } = field;
  const [C, M, Y, W] = channels;
  const baseMm = baseLayers * layerMm;
  const out = new Uint8ClampedArray(cols * rows * 4);
  const th = [0, 0, 0, 0];
  for (let i = 0; i < cols * rows; i++) {
    th[0] = C[i] * layerMm;
    th[1] = M[i] * layerMm;
    th[2] = Y[i] * layerMm;
    th[3] = W[i] * layerMm + baseMm; // white diffuser floor + extra white
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
  /** min / max stacked thickness in LAYERS (channels only, no base) */
  minLevels: number;
  maxLevelsTotal: number;
}

/** Per-channel average ink and the stacked-thickness range across cells. */
export function cmykStats(field: CmykField): CmykStats {
  const { channels, maxLevels, cols, rows } = field;
  const n = cols * rows;
  const sums = [0, 0, 0, 0];
  let minL = Infinity;
  let maxL = -Infinity;
  for (let i = 0; i < n; i++) {
    let t = 0;
    for (let ch = 0; ch < 4; ch++) {
      const v = channels[ch][i];
      sums[ch] += v;
      t += v;
    }
    if (t < minL) minL = t;
    if (t > maxL) maxL = t;
  }
  return {
    avgInk: sums.map((s) => s / (n * maxLevels)) as [number, number, number, number],
    minLevels: minL,
    maxLevelsTotal: maxL,
  };
}
