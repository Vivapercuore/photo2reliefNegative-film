/**
 * CMYK thickness-field core (DOM-free, unit testable). Unlike the
 * color-positive module — which dithers fixed-thickness dots and mixes color
 * by dot density — this module reproduces tone CONTINUOUSLY: each of the four
 * channels (C/M/Y/K) gets a local thickness proportional to its ink density,
 * quantized to whole print layers. Stacked translucent layers viewed with a
 * backlight mix subtractively; thicker = darker (厚度控制明度).
 */
import { RGBAImage, downsampleRGB, CMYK_PALETTE } from '../colorPositive/dither';

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
  /** layer count a channel gets at full ink (value 1.0) */
  maxLevels: number;
}

/**
 * Resample the photo to the dot grid, convert each cell RGB → CMYK and
 * quantize every channel to 0..maxLevels print layers.
 */
export function quantizeCmyk(
  src: RGBAImage,
  cols: number,
  rows: number,
  dotMm: number,
  maxLevels: number
): CmykField {
  const buf = downsampleRGB(src, cols, rows);
  const n = cols * rows;
  const C = new Uint8Array(n);
  const M = new Uint8Array(n);
  const Y = new Uint8Array(n);
  const K = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = buf[i * 3] / 255;
    const g = buf[i * 3 + 1] / 255;
    const b = buf[i * 3 + 2] / 255;
    const k = 1 - Math.max(r, g, b);
    let c = 0;
    let m = 0;
    let y = 0;
    if (k < 1 - 1e-6) {
      const w = 1 - k;
      c = (w - r) / w;
      m = (w - g) / w;
      y = (w - b) / w;
    }
    C[i] = Math.round(c * maxLevels);
    M[i] = Math.round(m * maxLevels);
    Y[i] = Math.round(y * maxLevels);
    K[i] = Math.round(k * maxLevels);
  }
  return { cols, rows, dotMm, channels: [C, M, Y, K], maxLevels };
}

/**
 * Recombine the quantized field back to RGBA for the on-screen preview
 * (standard CMYK→RGB: r = (1−C)(1−K) etc.) — what the quantization will
 * actually be able to show.
 */
export function cmykToRGBA(field: CmykField): Uint8ClampedArray {
  const { cols, rows, channels, maxLevels } = field;
  const [C, M, Y, K] = channels;
  const out = new Uint8ClampedArray(cols * rows * 4);
  for (let i = 0; i < cols * rows; i++) {
    const c = C[i] / maxLevels;
    const m = M[i] / maxLevels;
    const y = Y[i] / maxLevels;
    const k = K[i] / maxLevels;
    const o = i * 4;
    out[o] = 255 * (1 - c) * (1 - k);
    out[o + 1] = 255 * (1 - m) * (1 - k);
    out[o + 2] = 255 * (1 - y) * (1 - k);
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
