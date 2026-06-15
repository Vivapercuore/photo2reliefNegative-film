/**
 * CMYK filament calibration (DOM-free, unit testable).
 *
 * Backlit translucent layers mix by the Beer–Lambert law: transmission decays
 * exponentially with thickness, T = exp(−α·t), and stacked layers MULTIPLY
 * transmission — so in log space optical densities simply ADD. Every filament
 * therefore reduces to an absorption coefficient α per RGB channel (1/mm),
 * which captures BOTH its colour cast (different α across R/G/B) and its
 * overall opacity / 透光系数 (the magnitude of α). The whole module is driven
 * by a 4×3 matrix of these coefficients (filaments C,M,Y,K × channels R,G,B).
 *
 * The matrix can be measured from a single backlit photo of the calibration
 * print (see fitCalibration); until then a default derived from the nominal
 * palette colours keeps the module usable.
 */
import { CMYK_PALETTE } from '../colorPositive/dither';

/** sRGB (0..1) → linear light (0..1). */
export function srgb2lin(n: number): number {
  return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

/** linear light (0..1) → sRGB (0..1). */
export function lin2srgb(n: number): number {
  const c = n <= 0.0031308 ? 12.92 * n : 1.055 * Math.pow(n, 1 / 2.4) - 0.055;
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

/** Rec.709 relative luminance of a linear-RGB triple. */
export function relLum(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export interface CmykCalibration {
  /** absorption coefficient (1/mm), filament [C,M,Y,K] × channel [R,G,B] */
  alpha: number[][];
  /** backlight white point in linear light (per R,G,B); display reference I₀ */
  white: [number, number, number];
  /** true once measured from a photo; false for the palette-derived default */
  calibrated: boolean;
  /** ISO timestamp of the last fit (for the UI) */
  updatedAt?: string;
  /** human label when this came from a named preset (shown in the status tag) */
  label?: string;
}

/** Layer height the calibration wedges are authored at (mm). */
export const CAL_LAYER_MM = 0.08;

/** Per-column wedge thicknesses, in LAYERS. Denser at the thin end: −ln
 *  compresses the bright range and strong absorbers saturate to black quickly,
 *  so the usable signal for a strong channel lives in the first few layers. */
export const CAL_LAYERS = [1, 2, 3, 5, 8, 12, 18];

/** Raw 8-bit sRGB values at/above this are clipped (overexposed) — unusable. */
const CLIP_HI = 250;
/** Raw 8-bit sRGB values at/below this are crushed (noise floor) — unusable. */
const CLIP_LO = 3;

/** Filament order, matching CMYK_PALETTE (4th is White, the luminance layer). */
export const CAL_FILAMENTS = ['C', 'M', 'Y', 'W'] as const;

/** Thickness (mm) at which the default model shows a filament's palette colour
 *  — a modest 0.5mm so the uncalibrated preview reaches reasonable saturation
 *  rather than looking washed out; real calibration replaces these coefficients
 *  (and their saturationLayers ceilings) anyway. */
const DEFAULT_FULL_MM = 0.5;
/** Transmission floor so pure primaries (channel = 0) don't give α = ∞. */
const DEFAULT_FLOOR = 0.02;
/** Default NEUTRAL absorption (1/mm) for the white diffuser per RGB channel.
 *  White can't be derived from its display colour (255,255,255 → α = 0, no
 *  effect); it's a translucent scatterer that dims roughly neutrally, so more
 *  white = darker (the lithophane value). Calibration measures the real value. */
const DEFAULT_WHITE_ALPHA = 2.5;

/**
 * Palette-derived default. Colour filaments (C,M,Y): assume each transmits its
 * nominal sRGB colour at DEFAULT_FULL_MM, so α = −ln(transmission)/thickness.
 * White (id 'W'): a flat neutral absorber, DEFAULT_WHITE_ALPHA on every channel.
 */
export function defaultCalibration(): CmykCalibration {
  const alpha = CMYK_PALETTE.map((p) =>
    p.id === 'W'
      ? [DEFAULT_WHITE_ALPHA, DEFAULT_WHITE_ALPHA, DEFAULT_WHITE_ALPHA]
      : p.rgb.map((v) => {
          const lin = Math.max(DEFAULT_FLOOR, srgb2lin(v / 255));
          return -Math.log(lin) / DEFAULT_FULL_MM;
        })
  );
  return { alpha, white: [1, 1, 1], calibrated: false };
}

/** A named, ready-to-apply calibration the user can pick without re-shooting a
 *  photo (e.g. a stock filament set we've already measured). */
export interface CalibrationPreset {
  id: string;
  label: string;
  cal: CmykCalibration;
}

/**
 * Built-in calibration presets, selectable in the UI.
 *
 * 拓竹官方CMYK套装: measured from a backlit photo of the calibration print on
 * 2026-06-15. α is the material property (exposure-independent — it's fitted
 * from per-column transmission RATIOS), so `white` is set to the ideal full
 * backlight [1,1,1] rather than that photo's exposure; the measured backlight
 * was neutral (R≈G≈B), so nothing is lost.
 */
export const CALIBRATION_PRESETS: CalibrationPreset[] = [
  {
    id: 'bambu-official-cmyk',
    label: '拓竹官方CMYK套装',
    cal: {
      alpha: [
        [4.494, 3.523, 2.509], // C 青：最挡红、最透蓝
        [1.557, 4.817, 3.816], // M 品红：最挡绿、最透红
        [1.089, 1.683, 6.047], // Y 黄：最挡蓝、红绿双透
        [1.188, 1.563, 2.198], // W 白：近中性半透扩散层
      ],
      white: [1, 1, 1],
      calibrated: true,
      label: '拓竹官方CMYK套装',
      updatedAt: '2026-06-15',
    },
  },
];

/** Linear transmission at the near-black perceptual floor (sRGB ≈ 3/255):
 *  past this, one more layer of a strong absorber moves the output by less than
 *  one 8-bit code value, i.e. extra thickness is no longer distinguishable. */
export const SAT_FLOOR_LIN = srgb2lin(3 / 255);

/**
 * Per-filament "full-ink" thickness in LAYERS: the layer count at which a
 * filament's STRONGEST-absorbing channel reaches SAT_FLOOR_LIN. Beyond it,
 * stacking more of that filament is perceptually indistinguishable, so it is
 * the natural per-channel ceiling. Driven entirely by the calibrated α —
 * strong absorbers saturate in fewer layers, the near-neutral white diffuser
 * takes the most (its layers carry the luminance ladder). The colour→thickness
 * solve is later compressed into these ceilings rather than hard-clipped.
 */
export function saturationLayers(
  cal: CmykCalibration,
  layerMm: number
): [number, number, number, number] {
  const lnFloor = -Math.log(SAT_FLOOR_LIN); // ≈ 7.0
  return cal.alpha.map((a) => {
    const aMax = Math.max(a[0], a[1], a[2], 1e-6);
    return Math.max(1, Math.ceil(lnFloor / aMax / layerMm));
  }) as [number, number, number, number];
}

/**
 * Forward model: per-channel transmission through a stack with the given
 * per-filament thicknesses (mm), in linear light. I₀ = `white`.
 */
export function transmit(cal: CmykCalibration, thicknessMm: number[]): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let density = 0;
    for (let f = 0; f < 4; f++) density += cal.alpha[f][c] * thicknessMm[f];
    out[c] = cal.white[c] * Math.exp(-density);
  }
  return out;
}

/**
 * Build the colour→thickness solver for the CMY+White lithophane. Returns
 * per-filament thicknesses (mm) in order [C, M, Y, W], each clamped to its
 * `capMm` ceiling, as the closest PRINTABLE point — no global post-scaling.
 *
 * Joint 4-channel box-constrained least squares (NNLS by coordinate descent).
 * Crucially we DON'T force white to carry the neutral/luminance part: a single
 * translucent ink (or the white diffuser) can't actually block light to black —
 * only a balanced C+M+Y stack absorbs every band, so neutral darks come out as
 * a three-colour mix (true, untinted black). White is the weakest absorber, so
 * the ridge (min-norm tie-break) keeps it OUT of the heavy darkening and only
 * lets it supplement where C/M/Y hit their caps (the "not black enough" fill).
 *   d_c = −ln(target_c / white_c);  minimize Σ_c (Σ_f α[f][c]·t_f − d_c)²
 *   subject to 0 ≤ t_f ≤ capMm[f].
 * The 4×4 Gram matrix is built once (A is the same for every pixel).
 */
export function makeLithophaneSolver(
  cal: CmykCalibration,
  ridge = 2e-3,
  capMm?: [number, number, number, number]
): (targetLin: number[]) => number[] {
  const cap = capMm ?? [Infinity, Infinity, Infinity, Infinity];
  // 3×4 A: A[c][f] = α[f][c], f ∈ {C,M,Y,W}
  const A: number[][] = [[], [], []];
  for (let c = 0; c < 3; c++) for (let f = 0; f < 4; f++) A[c][f] = cal.alpha[f][c];
  // 4×4 Gram + ridge. A touch more ridge on white (f=3) nudges the solver to
  // reach for the strong C/M/Y inks first, so blacks stay neutral.
  const G: number[][] = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  for (let f = 0; f < 4; f++)
    for (let h = 0; h < 4; h++) {
      let s = 0;
      for (let c = 0; c < 3; c++) s += A[c][f] * A[c][h];
      G[f][h] = s + (f === h ? (f === 3 ? ridge * 8 : ridge) : 0);
    }
  return (targetLin: number[]): number[] => {
    const d = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const ratio = Math.min(1, Math.max(1e-4, targetLin[c] / cal.white[c]));
      d[c] = -Math.log(ratio);
    }
    const b = [0, 0, 0, 0];
    for (let f = 0; f < 4; f++) {
      let s = 0;
      for (let c = 0; c < 3; c++) s += A[c][f] * d[c];
      b[f] = s;
    }
    const t = [0, 0, 0, 0];
    for (let it = 0; it < 30; it++) {
      for (let f = 0; f < 4; f++) {
        let s = b[f];
        for (let h = 0; h < 4; h++) if (h !== f) s -= G[f][h] * t[h];
        // project onto the box [0, cap[f]]
        const v = G[f][f] > 0 ? s / G[f][f] : 0;
        t[f] = v < 0 ? 0 : v > cap[f] ? cap[f] : v;
      }
    }
    return t;
  };
}

/** One measured calibration patch (a single filament wedge step). */
export interface WedgeSample {
  /** filament index 0..3 (C,M,Y,W) */
  filament: number;
  /** printed thickness (mm) of this patch */
  thicknessMm: number;
  /** raw sampled patch colour in sRGB 0..255 */
  rgb: [number, number, number];
  /** raw sampled white reference in sRGB 0..255 at THIS patch's column — a
   *  per-column local I₀ that corrects horizontal backlight non-uniformity */
  whiteRgb: [number, number, number];
}

/**
 * Fit α from wedge samples. Per filament, per channel, fit the slope of optical
 * density −ln(patch/localWhite) against thickness through the origin (least
 * squares). Each sample carries its own LOCAL white reference (the slit pixel
 * in the same column), which cancels both the camera gain and any horizontal
 * backlight gradient. Samples whose patch channel is clipped (overexposed) or
 * crushed (noise floor), or whose local white is crushed, are dropped from that
 * channel's regression — those points carry no reliable density.
 */
export function fitCalibration(samples: WedgeSample[]): CmykCalibration {
  const alpha = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  // representative display white point (linear), averaged over the local whites
  let wr = 0;
  let wg = 0;
  let wb = 0;
  let wn = 0;
  for (const s of samples) {
    wr += srgb2lin(s.whiteRgb[0] / 255);
    wg += srgb2lin(s.whiteRgb[1] / 255);
    wb += srgb2lin(s.whiteRgb[2] / 255);
    wn++;
  }
  const white: [number, number, number] = wn ? [wr / wn, wg / wn, wb / wn] : [1, 1, 1];

  for (let f = 0; f < 4; f++) {
    for (let c = 0; c < 3; c++) {
      let num = 0;
      let den = 0;
      for (const s of samples) {
        if (s.filament !== f) continue;
        const praw = s.rgb[c];
        const wraw = s.whiteRgb[c];
        if (praw >= CLIP_HI || praw <= CLIP_LO || wraw <= CLIP_LO) continue;
        const pl = srgb2lin(praw / 255);
        const wl = srgb2lin(wraw / 255);
        const ratio = Math.min(1, Math.max(1e-4, pl / Math.max(1e-6, wl)));
        const y = -Math.log(ratio);
        num += s.thicknessMm * y;
        den += s.thicknessMm * s.thicknessMm;
      }
      alpha[f][c] = den > 0 ? Math.max(0, num / den) : 0;
    }
  }
  return { alpha, white, calibrated: true, updatedAt: new Date().toISOString() };
}

const LS_KEY = 'colorCmyk.calibration';

export function loadCalibration(): CmykCalibration {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (Array.isArray(obj.alpha) && obj.alpha.length === 4 && Array.isArray(obj.white)) {
        return obj as CmykCalibration;
      }
    }
  } catch {
    /* fall through to default */
  }
  return defaultCalibration();
}

export function saveCalibration(cal: CmykCalibration): void {
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
  cal: CmykCalibration;
}

const SAVED_KEY = 'colorCmyk.calibration.saved';

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
            Array.isArray(s.cal.alpha)
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
export function addSavedCalibration(label: string, cal: CmykCalibration): SavedCalibration {
  const entry: SavedCalibration = {
    id: 'cal-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
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
