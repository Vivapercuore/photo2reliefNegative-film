/**
 * Artwork-reference correction (DOM-free, unit testable).
 *
 * The "成品对照修正" flow lets the user recover the TRUE material calibration by
 * eye, from a physical print, without re-shooting a calibration strip. The
 * printed thickness field is a fixed fact solved once under the OLD calibration
 * K0 (field = quantizeCmyk(artwork, …, {cal: K0})); it never changes here. What
 * the sliders edit is each filament's absorption row α[f] — the exposure-
 * independent MATERIAL property — expressed as an equivalent COLOUR so a human
 * can match it against the real print (预览 = cmykToRGBA(field, K(deltas), …)).
 * When the preview matches the physical print, K(deltas) is the estimate of the
 * real material, and — because α is exposure-independent — it IS the corrected
 * calibration directly; no further inversion is required.
 *
 * Slider space = "the α row as an equivalent colour at a reference thickness".
 * Each filament is rendered as the sRGB it would transmit through REF_T of pure
 * neutral backlight (filamentSwatch); the user nudges that swatch in HSL, and we
 * map the nudged colour back to an absorption row. Lowering lightness ⇒ more
 * absorption; the transform preserves the Beer–Lambert structure (each α row
 * corresponds one-to-one with its reference swatch through T = exp(−α·t*)).
 */
import {
  CmykCalibration,
  srgb2lin,
  lin2srgb,
} from './calibration';

/** One filament's HSL nudge. h is a hue-angle offset (degrees, ±60); s and l
 *  are percentage-point offsets (s ±50, l ±30) applied in 0..1 HSL space. */
export interface HslDelta {
  h: number;
  s: number;
  l: number;
}

/** Neutral (all-zero) deltas for the 4 filaments (C,M,Y,W). Frozen so a caller
 *  can never mutate the shared reference; index each row is its own frozen
 *  object too. */
export const ZERO_DELTAS: HslDelta[] = Object.freeze([
  Object.freeze({ h: 0, s: 0, l: 0 }),
  Object.freeze({ h: 0, s: 0, l: 0 }),
  Object.freeze({ h: 0, s: 0, l: 0 }),
  Object.freeze({ h: 0, s: 0, l: 0 }),
]) as unknown as HslDelta[];

/** Reference transmission the strongest channel of a swatch is normalised to.
 *  0.15 keeps every filament's swatch mid-toned (neither near-white nor near-
 *  black) so its HSL numbers sit in a stable region. */
const REF_T = 0.15;

/** Clamp a scalar to [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * sRGB (0..1) → HSL (h 0..360, s 0..1, l 0..1). Standard conversion; for an
 * achromatic input (max == min) hue and saturation are 0.
 */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

/**
 * HSL (h 0..360, s 0..1, l 0..1) → sRGB (0..1). Inverse of rgbToHsl; s == 0
 * gives the achromatic grey (l, l, l).
 */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = h / 360;
  return [
    hue2rgb(p, q, hk + 1 / 3),
    hue2rgb(p, q, hk),
    hue2rgb(p, q, hk - 1 / 3),
  ];
}

/**
 * Reference thickness (mm) at which filament f's swatch is rendered. Chosen so
 * the filament's STRONGEST-absorbing channel transmits exactly REF_T:
 *   t* = ln(1/REF_T) / maxAlpha,  clamped to [0.05, 100] mm.
 * Anchoring on the strongest channel keeps both weak and strong filaments in the
 * stable mid-tone region of HSL space (a strong absorber picks a thin t*, a weak
 * one a thick t*), so slider values behave consistently across filaments.
 */
export function refThickness(cal: CmykCalibration, f: number): number {
  const a = cal.alpha[f];
  const maxAlpha = Math.max(a[0], a[1], a[2], 1e-6);
  const t = Math.log(1 / REF_T) / maxAlpha;
  return clamp(t, 0.05, 100);
}

/**
 * Filament f rendered as an sRGB swatch: its per-channel transmission through
 * refThickness of pure neutral backlight, T_c = exp(−α_c·t*), mapped to sRGB.
 * The `white` point is intentionally NOT applied — the swatch is a property of
 * the material's α alone (the backlight is the neutral reference), so the user
 * edits the filament colour, not the lamp.
 */
export function filamentSwatch(cal: CmykCalibration, f: number): [number, number, number] {
  const a = cal.alpha[f];
  const t = refThickness(cal, f);
  return [
    lin2srgb(Math.exp(-a[0] * t)),
    lin2srgb(Math.exp(-a[1] * t)),
    lin2srgb(Math.exp(-a[2] * t)),
  ];
}

/** Linear-light transmission floor before ln(): keeps −ln(T') finite. */
const T_LIN_FLOOR = 1e-4;

/**
 * Apply per-filament HSL deltas to a calibration and return a NEW corrected
 * calibration (inputs untouched). For each filament f:
 *   swatch → HSL → (h+Δh mod 360, clamp(s+Δs/100), clamp(l+Δl/100)) → sRGB
 *          → linear → α'_c = −ln(T'_c)/t*.
 * Because t* is fixed per filament, every step is monotone: lowering the swatch
 * lightness raises T'→0 which raises absorption, and vice-versa — the Beer–
 * Lambert structure (α row ⟷ reference swatch) is preserved, so the edited α is
 * still a physically valid material row. label is cleared (the result is a
 * custom, user-tuned calibration) and calibrated is set true.
 */
export function applyHslDeltas(cal: CmykCalibration, deltas: HslDelta[]): CmykCalibration {
  const alpha = cal.alpha.map((a, f) => {
    const t = refThickness(cal, f);
    const swatch = filamentSwatch(cal, f);
    const [h, s, l] = rgbToHsl(swatch[0], swatch[1], swatch[2]);
    const d = deltas[f] ?? { h: 0, s: 0, l: 0 };
    const h2 = (((h + d.h) % 360) + 360) % 360;
    const s2 = clamp(s + d.s / 100, 0, 1);
    const l2 = clamp(l + d.l / 100, 0.02, 0.995);
    const rgb = hslToRgb(h2, s2, l2);
    return rgb.map((v) => {
      const lin = Math.max(T_LIN_FLOOR, srgb2lin(v));
      return Math.max(0, -Math.log(lin) / t);
    });
  });
  return {
    alpha,
    white: [cal.white[0], cal.white[1], cal.white[2]],
    calibrated: true,
    label: undefined,
    updatedAt: new Date().toISOString(),
  };
}
