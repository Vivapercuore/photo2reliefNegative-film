/**
 * Shared image-edit core for the "edit before processing" step: a CROP (region
 * of the source) plus COLOR adjustments (global exposure / contrast / hue, and
 * per-primary saturation / brightness). The crop is reused by both the CMYK and
 * relief modules; the colour panel is CMYK-only. The colour math here is DOM-free
 * and unit-tested; `renderEdited` (the only DOM part) crops + scales the source
 * onto a canvas and applies the colour pass, producing the edited image that
 * feeds the simulation preview and the downstream colour separation / heightfield.
 */

/** Crop rectangle in NORMALISED source coordinates (0..1), resolution-independent. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Per-primary band adjustment (both -1..1). */
export interface PrimaryAdjust {
  /** saturation multiplier offset: s *= 1 + sat (−1 = greyscale that band) */
  sat: number;
  /** lightness add (scaled): l += bright * 0.5 at the band centre */
  bright: number;
}

export interface ColorAdjust {
  /** exposure in stops, applied as a gain 2^exposure in LINEAR light */
  exposure: number;
  /** contrast around mid-grey in sRGB (−1..1) */
  contrast: number;
  /** global hue rotation in degrees (−180..180) */
  hue: number;
  /** per-primary bands keyed by palette id (e.g. C/M/Y) */
  primaries: Record<string, PrimaryAdjust>;
}

export const NO_CROP: CropRect = { x: 0, y: 0, w: 1, h: 1 };

/** Hue-band centre (degrees) per palette primary id. C/M/Y are the print
 *  primaries; R/G/B kept too in case a future palette uses additive ids. */
const HUE_CENTER: Record<string, number> = {
  C: 180,
  M: 300,
  Y: 60,
  R: 0,
  G: 120,
  B: 240,
};
/** Half-width (degrees) of a primary's triangular influence band. 60° makes the
 *  three CMY (or RGB) bands tile the wheel and overlap softly at the midpoints. */
const BAND_HALF = 60;

export function defaultColorAdjust(primaryIds: string[]): ColorAdjust {
  const primaries: Record<string, PrimaryAdjust> = {};
  for (const id of primaryIds) primaries[id] = { sat: 0, bright: 0 };
  return { exposure: 0, contrast: 0, hue: 0, primaries };
}

export function isIdentityCrop(c: CropRect): boolean {
  return c.x <= 1e-4 && c.y <= 1e-4 && c.w >= 1 - 1e-4 && c.h >= 1 - 1e-4;
}

export function isIdentityColor(c: ColorAdjust): boolean {
  if (c.exposure !== 0 || c.contrast !== 0 || c.hue !== 0) return false;
  for (const k in c.primaries) {
    const p = c.primaries[k];
    if (p.sat !== 0 || p.bright !== 0) return false;
  }
  return true;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const srgb2lin = (n: number) => (n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4));
const lin2srgb = (n: number) =>
  n <= 0.0031308 ? 12.92 * n : 1.055 * Math.pow(n, 1 / 2.4) - 0.055;

/** sRGB (0..1) → HSL (h in degrees 0..360, s/l 0..1). */
export function rgb2hsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return [h, s, l];
}

/** HSL → sRGB (0..1). */
export function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  if (s < 1e-9) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = ((h % 360) + 360) % 360 / 360;
  const tc = (t: number) => {
    if (t < 0) t += 1;
    else if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [tc(hk + 1 / 3), tc(hk), tc(hk - 1 / 3)];
}

/** Triangular band weight (0..1) for hue `h` relative to a primary `center`. */
function bandWeight(h: number, center: number): number {
  let d = Math.abs(h - center) % 360;
  if (d > 180) d = 360 - d;
  return d >= BAND_HALF ? 0 : 1 - d / BAND_HALF;
}

/**
 * Apply the colour adjustments to an RGBA byte buffer in place. Pipeline per
 * pixel: exposure (linear gain) → contrast (sRGB pivot 0.5) → one HSL pass that
 * does the global hue rotation and the per-primary saturation/brightness bands.
 * Skips whole stages that are at their identity for speed.
 */
export function applyColorAdjust(
  data: Uint8ClampedArray | Uint8Array,
  adjust: ColorAdjust,
  primaryIds: string[]
): void {
  const { exposure, contrast, hue, primaries } = adjust;
  const gain = Math.pow(2, exposure);
  const ctr = 1 + contrast;
  const bands = primaryIds
    .map((id) => ({ c: HUE_CENTER[id] ?? 0, sat: primaries[id]?.sat || 0, br: primaries[id]?.bright || 0 }))
    .filter((b) => b.sat !== 0 || b.br !== 0);
  const doExposure = exposure !== 0;
  const doContrast = contrast !== 0;
  const doHsl = hue !== 0 || bands.length > 0;
  if (!doExposure && !doContrast && !doHsl) return;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] / 255;
    let g = data[i + 1] / 255;
    let b = data[i + 2] / 255;

    if (doExposure) {
      r = lin2srgb(srgb2lin(r) * gain);
      g = lin2srgb(srgb2lin(g) * gain);
      b = lin2srgb(srgb2lin(b) * gain);
    }
    if (doContrast) {
      r = (r - 0.5) * ctr + 0.5;
      g = (g - 0.5) * ctr + 0.5;
      b = (b - 0.5) * ctr + 0.5;
    }
    r = clamp01(r);
    g = clamp01(g);
    b = clamp01(b);

    if (doHsl) {
      let [h, s, l] = rgb2hsl(r, g, b);
      if (hue !== 0) h = ((h + hue) % 360 + 360) % 360;
      if (bands.length) {
        let satF = 1;
        let lAdd = 0;
        for (const bnd of bands) {
          const w = bandWeight(h, bnd.c);
          if (w > 0) {
            satF += w * bnd.sat;
            lAdd += w * bnd.br * 0.5;
          }
        }
        s = clamp01(s * satF);
        l = clamp01(l + lAdd);
      }
      [r, g, b] = hsl2rgb(h, s, l);
    }

    data[i] = r * 255 + 0.5;
    data[i + 1] = g * 255 + 0.5;
    data[i + 2] = b * 255 + 0.5;
  }
}

/**
 * Crop + scale the source onto a fresh canvas and apply the colour pass. The
 * output long edge is capped at `maxEdge` (the downstream pipeline downsamples
 * to a much smaller grid, so a full-resolution intermediate is wasted work and
 * memory). Returns the edited canvas — callers read its ImageData (CMYK) or feed
 * it to createImageBitmap (relief).
 */
export function renderEdited(
  source: CanvasImageSource,
  naturalW: number,
  naturalH: number,
  crop: CropRect,
  color: ColorAdjust,
  primaryIds: string[],
  maxEdge = 2048
): HTMLCanvasElement {
  const sx = crop.x * naturalW;
  const sy = crop.y * naturalH;
  const sw = Math.max(1, crop.w * naturalW);
  const sh = Math.max(1, crop.h * naturalH);
  let dw = sw;
  let dh = sh;
  const long = Math.max(dw, dh);
  if (long > maxEdge) {
    const k = maxEdge / long;
    dw *= k;
    dh *= k;
  }
  dw = Math.max(1, Math.round(dw));
  dh = Math.max(1, Math.round(dh));
  const cv = document.createElement('canvas');
  cv.width = dw;
  cv.height = dh;
  const cx = cv.getContext('2d');
  if (!cx) return cv;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(source, sx, sy, sw, sh, 0, 0, dw, dh);
  if (!isIdentityColor(color)) {
    const id = cx.getImageData(0, 0, dw, dh);
    applyColorAdjust(id.data, color, primaryIds);
    cx.putImageData(id, 0, 0);
  }
  return cv;
}
