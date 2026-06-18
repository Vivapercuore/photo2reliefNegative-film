/**
 * RGB color-positive HALFTONE calibration (DOM-free, unit testable).
 *
 * Unlike the CMYK lithophane — translucent layers whose THICKNESS mixes
 * subtractively by Beer–Lambert (see ../colorCmyk/calibration.ts) — the
 * color-positive module is a BINARY halftone: every cell is exactly one
 * primary at a fixed layer height, and colour is formed by the SPATIAL AREA
 * MIX of the side-by-side dots. In linear light that mix is the area-weighted
 * average of the dots' real colours — a first-order Neugebauer model. So the
 * only thing to calibrate is each primary's REAL colour under the viewing
 * condition; the existing additive linear-light pipeline already does the
 * averaging, it was just averaging the WRONG (ideal) colours.
 *
 * The dominant 偏色 source is exactly that: the pipeline assumes pure
 * primaries (255,0,0 …) while a printed dot is duller and casts. Measuring the
 * real primaries and feeding them to (a) dither matching, (b) the achievable
 * gamut hull, and (c) the preview removes the systematic cast.
 *
 * 一阶 only: we measure SOLID primary swatches. Dot-gain / tone response (the
 * curve mapping requested coverage → effective coverage) is a future
 * second-order term and is intentionally left out here.
 */

/** sRGB (0..1) → linear light (0..1). */
export function srgb2lin(n: number): number {
  return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

/** linear light (0..1) → sRGB (0..1). */
export function lin2srgb(n: number): number {
  const c = n <= 0.0031308 ? 12.92 * n : 1.055 * Math.pow(n, 1 / 2.4) - 0.055;
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

/** Primary filament ids the module can use (superset of every palette mode). */
export type PrimaryId = 'R' | 'G' | 'B' | 'K' | 'W';

/** All measurable primaries, in calibration-tile row order. One reflective
 *  calibration measures ALL of them, so any palette mode (rgbw / rgbkw / rgbk)
 *  just looks up the subset of ids it actually uses. */
export const CAL_PRIMARIES: PrimaryId[] = ['R', 'G', 'B', 'K', 'W'];

/** Display label per primary (for the calibration UI). */
export const PRIMARY_LABEL: Record<PrimaryId, string> = {
  R: '红',
  G: '绿',
  B: '蓝',
  K: '黑',
  W: '白',
};

/** Nominal (ideal) sRGB 0..255 colour per primary — the uncalibrated default. */
export const PRIMARY_NOMINAL: Record<PrimaryId, [number, number, number]> = {
  R: [255, 0, 0],
  G: [0, 255, 0],
  B: [0, 0, 255],
  K: [0, 0, 0],
  W: [255, 255, 255],
};

/** Viewing condition the calibration was measured under. Backlit and reflective
 *  give completely different primary colours, so a calibration is only valid
 *  for the condition it was shot in. */
export type ViewCondition = 'reflective' | 'backlit';

export interface RgbCalibration {
  /** measured colour of each primary's SOLID swatch in LINEAR light (0..1),
   *  normalized so the white reference = [1,1,1]. Keyed by PrimaryId; a missing
   *  id falls back to its nominal colour (see primaryLin). */
  primaries: Record<string, [number, number, number]>;
  /** white reference in linear light. The normalized model uses [1,1,1]; kept
   *  as a field for parity with the CMYK calibration and the status display. */
  white: [number, number, number];
  /** which viewing condition this was measured for */
  condition: ViewCondition;
  /** true once measured/edited; false for the nominal-palette default */
  calibrated: boolean;
  /** saturation-restoration factor (≥1). A phone photo unavoidably lowers
   *  saturation; this single GLOBAL factor re-expands every primary's chroma
   *  (hue & relative values preserved) so the camera's desaturation doesn't
   *  shrink the gamut, while the measured 偏色 (hue cast) is kept. Defaults to
   *  the auto value from the fit; absent/1 = no restoration. */
  chromaGain?: number;
  /** Yule-Nielsen factor n (≥1) for the side-by-side dot mixing. n=1 is plain
   *  linear-light averaging (Murray–Davies); n>1 models optical dot gain — light
   *  spreading sideways between adjacent dots makes a halftone read DARKER than
   *  the linear average. Per Prusa's measured FDM data, Yule-Nielsen (~n=3) is
   *  about twice as accurate as linear averaging. Absent/1 = off. */
  ynFactor?: number;
  /** ISO timestamp of the last fit (for the UI) */
  updatedAt?: string;
  /** human label when this came from a named preset (shown in the status tag) */
  label?: string;
}

/** Clamp a linear value to [0,1]. */
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Palette-/nominal-derived default: every primary is its ideal sRGB colour
 * converted to linear light. Identical numbers to today's hard-coded pipeline,
 * so an uncalibrated module behaves exactly as before.
 */
export function defaultCalibration(condition: ViewCondition = 'reflective'): RgbCalibration {
  const primaries: Record<string, [number, number, number]> = {};
  for (const id of CAL_PRIMARIES) {
    const [r, g, b] = PRIMARY_NOMINAL[id];
    primaries[id] = [srgb2lin(r / 255), srgb2lin(g / 255), srgb2lin(b / 255)];
  }
  // ynFactor defaults to the recommended value so the optical dot-gain
  // compensation is ON out of the box (it's independent of primary measurement);
  // chromaGain stays 1 (no saturation restore until a real photo is fit).
  return { primaries, white: [1, 1, 1], condition, calibrated: false, chromaGain: 1, ynFactor: DEFAULT_YN };
}

/** Largest allowed saturation-restoration factor (so a very flat photo can't
 *  blow the gain up to absurd values). */
export const MAX_CHROMA_GAIN = 4;

/** Rec.709 relative luminance of a linear-RGB triple. */
function lum(c: number[]): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Chroma magnitude = distance from the luminance-gray axis (linear). */
function chromaMag(c: number[]): number {
  const y = lum(c);
  const dr = c[0] - y;
  const dg = c[1] - y;
  const db = c[2] - y;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Scale a colour's CHROMA by `gain` while preserving its luminance AND hue
 *  (the deviation from gray is scaled along its own direction), clamped to the
 *  unit cube. gain = 1 is identity. A single global gain keeps RELATIVE values
 *  between primaries intact — only the overall saturation changes. */
function applyChromaGain(c: number[], gain: number): [number, number, number] {
  if (!(gain > 0) || gain === 1) return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
  const y = lum(c);
  return [clamp01(y + gain * (c[0] - y)), clamp01(y + gain * (c[1] - y)), clamp01(y + gain * (c[2] - y))];
}

/** RAW measured (or nominal) linear colour of a primary — NO saturation
 *  restoration applied. Used by the editable table (what the photo recorded). */
export function primaryRawLin(cal: RgbCalibration, id: string): [number, number, number] {
  const p = cal.primaries[id];
  if (p) return p;
  const nom = PRIMARY_NOMINAL[id as PrimaryId] ?? [0, 0, 0];
  return [srgb2lin(nom[0] / 255), srgb2lin(nom[1] / 255), srgb2lin(nom[2] / 255)];
}

/** Working linear colour of a primary used everywhere downstream: the raw
 *  measurement with the calibration's saturation restoration (chromaGain)
 *  applied — keeps the measured 偏色 but undoes the camera's desaturation. */
export function primaryLin(cal: RgbCalibration, id: string): [number, number, number] {
  return applyChromaGain(primaryRawLin(cal, id), cal.chromaGain ?? 1);
}

/** Auto chromaGain after a fit: the single global factor that lifts the mean
 *  chroma of the measured R/G/B primaries back up to the IDEAL primaries' mean
 *  chroma, undoing the camera's global desaturation (capped at MAX_CHROMA_GAIN). */
export function autoChromaGain(primaries: Record<string, [number, number, number]>): number {
  let idealSum = 0;
  let measSum = 0;
  for (const id of ['R', 'G', 'B'] as const) {
    const nom = PRIMARY_NOMINAL[id];
    idealSum += chromaMag([srgb2lin(nom[0] / 255), srgb2lin(nom[1] / 255), srgb2lin(nom[2] / 255)]);
    const m = primaries[id];
    if (m) measSum += chromaMag(m);
  }
  if (measSum < 1e-6) return 1;
  return Math.max(1, Math.min(MAX_CHROMA_GAIN, idealSum / measSum));
}

/** Default Yule-Nielsen factor for a calibrated set (Prusa's measured value). */
export const DEFAULT_YN = 3;
/** Largest allowed Yule-Nielsen factor (UI slider upper bound). */
export const MAX_YN = 6;

/** The Yule-Nielsen factor in effect: 1 (off) for an uncalibrated/absent cal,
 *  else the stored value (falling back to DEFAULT_YN for older saved cals). */
export function ynFactorOf(cal?: RgbCalibration): number {
  if (!cal) return 1;
  if (cal.ynFactor == null) return DEFAULT_YN; // pre-YN saved cal
  return cal.ynFactor >= 1 ? cal.ynFactor : 1;
}

/** Forward Yule-Nielsen transform of one linear-light channel (0..1): R → R^(1/n).
 *  Halftone averaging is linear in THIS space; the perceived colour is the
 *  inverse of the spatial average. n=1 is identity. */
export function ynForward(lin01: number, n: number): number {
  return n === 1 ? lin01 : Math.pow(clamp01(lin01), 1 / n);
}

/** Inverse Yule-Nielsen transform (0..1): x → x^n, back to linear light. */
export function ynInverse(x: number, n: number): number {
  return n === 1 ? x : Math.pow(x < 0 ? 0 : x > 1 ? 1 : x, n);
}

/**
 * Closest point to `q` inside the convex hull of `verts`, all in the same
 * linear-RGB space. For the dot field, every cell carries exactly one primary
 * so coverage fractions sum to 1 — the achievable gamut is precisely the convex
 * hull of the primary colours. Projecting a target onto that hull keeps hue/
 * brightness as close as possible while bounding the error-diffusion residual
 * (the un-projected, out-of-gamut case is what produces colour blocks/bleed).
 *
 * Solved with Frank–Wolfe over the probability simplex: it converges to `q`
 * itself when `q` is already inside, so interior pixels pass through unchanged.
 */
export function projectToHull(
  q: [number, number, number],
  verts: number[][],
  iters = 20
): [number, number, number] {
  const n = verts.length;
  if (!n) return q;
  // start at the nearest vertex
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < n; i++) {
    const dx = verts[i][0] - q[0];
    const dy = verts[i][1] - q[1];
    const dz = verts[i][2] - q[2];
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  let px = verts[best][0];
  let py = verts[best][1];
  let pz = verts[best][2];
  for (let it = 0; it < iters; it++) {
    // Frank–Wolfe vertex: s = argmin_i ⟨p − q, verts[i]⟩
    let s = 0;
    let smin = Infinity;
    for (let i = 0; i < n; i++) {
      const gi = (px - q[0]) * verts[i][0] + (py - q[1]) * verts[i][1] + (pz - q[2]) * verts[i][2];
      if (gi < smin) {
        smin = gi;
        s = i;
      }
    }
    // exact line search of γ∈[0,1] along p → verts[s]
    const dx = verts[s][0] - px;
    const dy = verts[s][1] - py;
    const dz = verts[s][2] - pz;
    const denom = dx * dx + dy * dy + dz * dz;
    if (denom < 1e-12) break;
    let g = -((px - q[0]) * dx + (py - q[1]) * dy + (pz - q[2]) * dz) / denom;
    if (g < 0) g = 0;
    else if (g > 1) g = 1;
    px += g * dx;
    py += g * dy;
    pz += g * dz;
    if (g * g * denom < 1e-10) break; // converged
  }
  return [px, py, pz];
}

/** A named, ready-to-apply calibration the user can pick without re-shooting a
 *  photo. None ship yet (no measured reference set) — kept for parity / future. */
export interface CalibrationPreset {
  id: string;
  label: string;
  cal: RgbCalibration;
}

export const CALIBRATION_PRESETS: CalibrationPreset[] = [];

/** One measured calibration patch (a single solid primary swatch). */
export interface SwatchSample {
  /** primary id this patch is printed in */
  id: string;
  /** raw sampled patch colour in sRGB 0..255 */
  rgb: [number, number, number];
}

/**
 * Fit primaries from solid-swatch samples. The white swatch (id 'W') is the
 * white reference: every primary is divided by it per channel (in linear
 * light), which cancels the illuminant colour cast and the camera white
 * balance, and normalizes white to [1,1,1]. (Reflective: there is no separate
 * bare-light reference like the backlit CMYK slit — the white filament patch IS
 * the reference.)
 */
export function fitCalibration(samples: SwatchSample[], condition: ViewCondition): RgbCalibration {
  const w = samples.find((s) => s.id === 'W');
  const wlin: [number, number, number] = w
    ? [srgb2lin(w.rgb[0] / 255), srgb2lin(w.rgb[1] / 255), srgb2lin(w.rgb[2] / 255)]
    : [1, 1, 1];
  const wsafe: [number, number, number] = [
    Math.max(1e-4, wlin[0]),
    Math.max(1e-4, wlin[1]),
    Math.max(1e-4, wlin[2]),
  ];
  const primaries: Record<string, [number, number, number]> = {};
  for (const s of samples) {
    primaries[s.id] = [
      clamp01(srgb2lin(s.rgb[0] / 255) / wsafe[0]),
      clamp01(srgb2lin(s.rgb[1] / 255) / wsafe[1]),
      clamp01(srgb2lin(s.rgb[2] / 255) / wsafe[2]),
    ];
  }
  // backfill any primary the photo didn't cover with its nominal colour
  const def = defaultCalibration(condition);
  for (const id of CAL_PRIMARIES) if (!primaries[id]) primaries[id] = primaryRawLin(def, id);
  return {
    primaries,
    white: [1, 1, 1],
    condition,
    calibrated: true,
    chromaGain: autoChromaGain(primaries),
    ynFactor: DEFAULT_YN,
    updatedAt: new Date().toISOString(),
  };
}

const LS_KEY = 'colorPositive.calibration';

function isValidCal(obj: any): obj is RgbCalibration {
  return (
    obj &&
    obj.primaries &&
    typeof obj.primaries === 'object' &&
    Array.isArray(obj.primaries.R) &&
    Array.isArray(obj.primaries.G) &&
    Array.isArray(obj.primaries.B) &&
    Array.isArray(obj.white)
  );
}

export function loadCalibration(): RgbCalibration {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (isValidCal(obj)) return obj as RgbCalibration;
    }
  } catch {
    /* fall through to default */
  }
  return defaultCalibration();
}

export function saveCalibration(cal: RgbCalibration): void {
  window.localStorage.setItem(LS_KEY, JSON.stringify(cal));
}

export function clearCalibration(): void {
  window.localStorage.removeItem(LS_KEY);
}

/** A user-saved, named calibration (typically from their own photo fit). Kept
 *  in a local list so it can be re-selected later — never leaves the browser. */
export interface SavedCalibration {
  id: string;
  label: string;
  cal: RgbCalibration;
}

const SAVED_KEY = 'colorPositive.calibration.saved';

export function loadSavedCalibrations(): SavedCalibration[] {
  try {
    const raw = window.localStorage.getItem(SAVED_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr.filter(
          (s) =>
            s &&
            typeof s.id === 'string' &&
            typeof s.label === 'string' &&
            s.cal &&
            s.cal.primaries
        );
      }
    }
  } catch {
    /* ignore malformed storage */
  }
  return [];
}

function writeSaved(list: SavedCalibration[]): void {
  window.localStorage.setItem(SAVED_KEY, JSON.stringify(list));
}

/** Append a named copy of `cal` (stamped with `label`) and return the entry. */
export function addSavedCalibration(label: string, cal: RgbCalibration): SavedCalibration {
  const entry: SavedCalibration = {
    id: 'rgbcal-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    label,
    cal: { ...cal, label, calibrated: true },
  };
  const list = loadSavedCalibrations();
  list.push(entry);
  writeSaved(list);
  return entry;
}

export function deleteSavedCalibration(id: string): void {
  writeSaved(loadSavedCalibrations().filter((s) => s.id !== id));
}

/** Default name when the user doesn't type one: YYYYMMDD-N, N being the next
 *  free index so same-day saves don't collide (e.g. 20260615-1, 20260615-2). */
export function nextAutoName(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate()
  ).padStart(2, '0')}`;
  const existing = new Set(loadSavedCalibrations().map((s) => s.label));
  let n = 1;
  while (existing.has(`${ymd}-${n}`)) n++;
  return `${ymd}-${n}`;
}
