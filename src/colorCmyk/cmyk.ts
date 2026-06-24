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
  linRgbToLab,
} from './calibration';

export { CMYK_PALETTE };

/** Channel order everywhere in this module: C, M, Y, K. */
export const CHANNELS = ['C', 'M', 'Y', 'K'] as const;

/** Deterministic quantizer tuning (Pass 2 colour search). LAB_L_WEIGHT < 1
 *  down-weights lightness vs chroma so a tie is broken in favour of HUE. INK_W
 *  anchors the candidate's total C+M+Y to the continuous solve's so the search
 *  can't "buy" a marginally better match by piling on extra ink (over-darkening
 *  neutrals). MAGENTA_OVERSHOOT_W is the key sky fix: a bright blue is unreachable
 *  on the lattice, and its two nearest printable points straddle the target —
 *  one a touch too cyan, one a touch too magenta (purple). A symmetric metric
 *  picks whichever is numerically closer, flipping pixel-to-pixel into purple
 *  blotches. For a COOL target, crossing to the magenta side is the salient
 *  artifact, so we weight +a* overshoot this much more than erring toward cyan —
 *  blues land consistently on the clean (slightly-cyan) side. MAGENTA_MIN_LAYERS
 *  is a hard deadzone: where the continuous solve asks for LESS than this much
 *  magenta the allocation is treated as incidental and dropped to 0 — a blue sky
 *  asks for ≈½ a layer of magenta almost everywhere, which is unprintable and only
 *  leaks red (purple) when rounded up, so we forbid it and let cyan carry the
 *  green-blocking. Above the deadzone magenta is genuine (reds, warm shadows) and
 *  searched normally. CYAN_SPAN is the search radius (layers) around the
 *  continuous cyan; M/Y use a small fixed span (they saturate in very few layers). */
const LAB_L_WEIGHT = 0.25;
const INK_W = 4.0;
const MAGENTA_OVERSHOOT_W = 3.0;
const MAGENTA_MIN_LAYERS = 1.0;
const CYAN_SPAN = 2;

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
  /** layers of white on top, UNIFORM on every cell (stacked above C/M/Y) — the
   *  viewing-side cap that keeps the surface white over saturated colours. Its
   *  absorption is folded into the target before solving, so the preview stays
   *  colour-accurate. 0 = no top white. */
  topLayers: number;
  /** optional target TOTAL thickness (mm, incl. white floor). The colour layers
   *  (incl. the top-white) are scaled so the tallest column hits this; the white
   *  floor is fixed. undefined = natural thickness (scale 1). */
  targetTotalMm?: number;
}

/** Light separable 1-2-1 blur of a cols×rows float-RGB buffer (clamped edges).
 *  Smooths the sub-pixel texture (e.g. the colour wheel's faint petal ridges)
 *  that would otherwise flip pixels across a layer boundary and speckle — so the
 *  thickness field bands cleanly instead of granulating. NOT dithering: it
 *  removes high-frequency input noise, it doesn't add any. */
function smoothRGB(buf: Float32Array, cols: number, rows: number): Float32Array {
  const tmp = new Float32Array(buf.length);
  const out = new Float32Array(buf.length);
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < cols - 1 ? x + 1 : cols - 1;
      for (let c = 0; c < 3; c++) {
        tmp[(y * cols + x) * 3 + c] =
          (buf[(y * cols + xm) * 3 + c] +
            2 * buf[(y * cols + x) * 3 + c] +
            buf[(y * cols + xp) * 3 + c]) /
          4;
      }
    }
  for (let y = 0; y < rows; y++) {
    const ym = y > 0 ? y - 1 : 0;
    const yp = y < rows - 1 ? y + 1 : rows - 1;
    for (let x = 0; x < cols; x++)
      for (let c = 0; c < 3; c++) {
        out[(y * cols + x) * 3 + c] =
          (tmp[(ym * cols + x) * 3 + c] +
            2 * tmp[(y * cols + x) * 3 + c] +
            tmp[(yp * cols + x) * 3 + c]) /
          4;
      }
  }
  return out;
}

/**
 * Resample the photo to the dot grid and, per cell, solve the calibrated
 * transmission model for the per-filament thicknesses that best reproduce the
 * colour under backlight, quantized to whole print layers. White (filament 3)
 * is the neutral luminance/diffuser layer; the white floor's absorption is
 * removed from the target first, so the solved channel layers are the ink ON
 * TOP of the floor (matching how buildCmykParts stacks them).
 *
 * The downsampled input is lightly smoothed (area-weighted resample + a 1-2-1
 * blur) so input noise doesn't speckle the quantization. The continuous solve is
 * then quantized DETERMINISTICALLY (no dithering): each cell is set to the single
 * printable layer-combination whose forward-modelled colour is nearest the target
 * in CIELAB, with lightness down-weighted and the total ink anchored to the
 * continuous solve so hue is protected (see Pass 2). A layer is a coarse density
 * step and smooth low-ink regions (a blue sky needs a FRACTION of a magenta layer
 * everywhere) can't be hit exactly; anchoring the ink stops the search from
 * adding a hue-wrecking extra layer to chase lightness, which is what banded the
 * sky into purple/green blotches.
 */
export function quantizeCmyk(
  src: RGBAImage,
  cols: number,
  rows: number,
  dotMm: number,
  opts: QuantizeOptions
): CmykField {
  const { cal, layerMm, baseLayers, topLayers, targetTotalMm } = opts;
  const buf = smoothRGB(downsampleRGB(src, cols, rows), cols, rows);
  const n = cols * rows;
  // Fixed white = the diffuser FLOOR (against the backlight) + a uniform top CAP
  // (viewing side, topLayers) under/over every cell. Both print on every column
  // regardless of colour, so their absorption is removed from the target before
  // solving (the print always has them). The cap guarantees a white surface even
  // over fully-saturated pixels — the C/M/Y layers sit between floor and cap and
  // never show on top.
  const baseMm = baseLayers * layerMm;
  const fixedWhiteMm = baseMm + topLayers * layerMm;
  const baseT: [number, number, number] = [
    Math.exp(-cal.alpha[3][0] * fixedWhiteMm),
    Math.exp(-cal.alpha[3][1] * fixedWhiteMm),
    Math.exp(-cal.alpha[3][2] * fixedWhiteMm),
  ];

  // Per-channel ceiling: the calibration-derived "full ink" thickness (beyond
  // which more of that filament is invisible). Bounds the per-pixel solve.
  const caps = saturationLayers(cal, layerMm);
  const capMm = caps.map((c) => c * layerMm) as [number, number, number, number];
  // The solver clamps each filament to its ceiling. whiteTopMm = 0 here: Pass 1
  // solves C/M/Y against the fixed white (floor + uniform cap) only. Every pixel
  // is solved INDEPENDENTLY → no global rescaling that desaturates the whole image.
  const solve = makeLithophaneSolver(cal, 2e-3, capMm, 0);

  // Pass 1: per-pixel solve → store float thicknesses (mm), and track the
  // natural tallest colour stack so we can scale to a target total.
  //
  // The box-constrained NNLS solve is a CONTINUOUS function of the target colour,
  // so a smooth gradient in ⇒ smooth thicknesses out. It defines the per-pixel
  // TARGET colour (and the search neighbourhood) that Pass 2's deterministic
  // nearest-printable-colour quantization then snaps to. Out-of-gamut colours
  // land at the nearest printable point in optical-density space.
  const tBuf = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  let naturalChannelMaxMm = 0;
  for (let i = 0; i < n; i++) {
    const bestT = solve([
      srgb2lin(buf[i * 3] / 255) / baseT[0],
      srgb2lin(buf[i * 3 + 1] / 255) / baseT[1],
      srgb2lin(buf[i * 3 + 2] / 255) / baseT[2],
    ]);
    let sum = 0;
    for (let f = 0; f < 4; f++) {
      tBuf[f][i] = bestT[f];
      sum += bestT[f];
    }
    if (sum > naturalChannelMaxMm) naturalChannelMaxMm = sum;
  }

  // Thickness scale: stretch/shrink the colour layers so the tallest column
  // reaches targetTotalMm (the fixed white floor+cap is not scaled). Default
  // 1 = natural thickness.
  let scale = 1;
  if (targetTotalMm && naturalChannelMaxMm > 1e-6) {
    scale = (targetTotalMm - fixedWhiteMm) / naturalChannelMaxMm;
    if (scale < 0.05) scale = 0.05;
    else if (scale > 8) scale = 8;
  }

  // Pass 2: DETERMINISTIC nearest-printable-COLOUR quantization (no dithering —
  // every cell is one layer-combo). One layer is a coarse density step, so
  // rounding each channel independently banded smooth low-ink regions into false
  // colour: a blue sky needs a FRACTION of a magenta layer everywhere — round it
  // up and green is over-blocked so red leaks (purple); round it down and green
  // over-passes (too cyan). Instead, per pixel we search the small integer
  // neighbourhood of the continuous solve for the combo whose FORWARD-MODELLED
  // colour is nearest the target in CIELAB, with four guards: a MAGENTA DEADZONE
  // (MAGENTA_MIN_LAYERS) pins magenta to 0 wherever the continuous solve asks for
  // less than a full layer — that ≈½-layer is the incidental, red-leaking magenta
  // a blue sky asks for everywhere, so it is forbidden and cyan carries the
  // green-blocking; lightness is down-weighted (LAB_L_WEIGHT) so ties favour HUE;
  // the total C+M+Y is ANCHORED (INK_W) to the continuous solve's so the search
  // can't over-darken neutrals by piling on ink; and for COOL targets the a*
  // distance is ASYMMETRIC (MAGENTA_OVERSHOOT_W) so any magenta that DOES survive
  // (≥1 layer) still lands a blue on the slightly-cyan side rather than the purple
  // side. The printable lattice is only a few thousand points, so each candidate's
  // Lab is precomputed ONCE into a table and the per-pixel search is table lookups
  // + a weighted squared distance. White is the uniform top cap (capTop), as elsewhere.
  const C = new Uint8Array(n);
  const M = new Uint8Array(n);
  const Y = new Uint8Array(n);
  const W = new Uint8Array(n);
  const capTop = Math.min(topLayers, caps[3]);
  const whiteTopMm = capTop * layerMm + baseMm;

  // Candidate Lab table over the printable C/M/Y lattice (full ceilings so
  // saturated/dark areas stay reachable), all at the fixed white cap.
  const Cn = caps[0] + 1;
  const Mn = caps[1] + 1;
  const Yn = caps[2] + 1;
  const tabL = new Float32Array(Cn * Mn * Yn);
  const tabA = new Float32Array(Cn * Mn * Yn);
  const tabB = new Float32Array(Cn * Mn * Yn);
  for (let c = 0; c < Cn; c++)
    for (let m = 0; m < Mn; m++)
      for (let yy = 0; yy < Yn; yy++) {
        const lin = transmit(cal, [c * layerMm, m * layerMm, yy * layerMm, whiteTopMm]);
        const lab = linRgbToLab(lin[0], lin[1], lin[2]);
        const j = (c * Mn + m) * Yn + yy;
        tabL[j] = lab[0];
        tabA[j] = lab[1];
        tabB[j] = lab[2];
      }

  for (let i = 0; i < n; i++) {
    // Target = the (scaled) continuous solve's OWN forward colour at the white
    // cap — the achievable in-gamut colour it is aiming at. At scale 1 this is the
    // photo colour; targetTotalMm rescales it toward a thicker/thinner (more/less
    // saturated) look and the search tracks it.
    const tc = tBuf[0][i] * scale;
    const tm = tBuf[1][i] * scale;
    const ty = tBuf[2][i] * scale;
    const lin = transmit(cal, [tc, tm, ty, whiteTopMm]);
    const tgt = linRgbToLab(lin[0], lin[1], lin[2]);
    const tL = tgt[0];
    const tA = tgt[1];
    const tB = tgt[2];
    const contInk = (tc + tm + ty) / layerMm; // continuous total C+M+Y (layers)

    const c0 = Math.round(tc / layerMm);
    const m0 = Math.round(tm / layerMm);
    const y0 = Math.round(ty / layerMm);
    const cLo = Math.max(0, c0 - CYAN_SPAN);
    const cHi = Math.min(Cn - 1, c0 + CYAN_SPAN);
    // magenta deadzone: below MAGENTA_MIN_LAYERS the magenta is incidental — pin
    // it to 0 so the search matches with C/Y only (cyan does the green-blocking),
    // keeping blues off the purple side. Above it, search magenta normally.
    const dropMagenta = tm / layerMm < MAGENTA_MIN_LAYERS;
    const mLo = dropMagenta ? 0 : Math.max(0, m0 - 1);
    const mHi = dropMagenta ? 0 : Math.min(Mn - 1, m0 + 2);
    const yLo = Math.max(0, y0 - 1);
    const yHi = Math.min(Yn - 1, y0 + 2);
    let best = Infinity;
    let bc = cLo;
    let bm = mLo;
    let by = yLo;
    for (let c = cLo; c <= cHi; c++)
      for (let m = mLo; m <= mHi; m++)
        for (let yy = yLo; yy <= yHi; yy++) {
          const j = (c * Mn + m) * Yn + yy;
          const dL = tabL[j] - tL;
          const dA = tabA[j] - tA;
          const dB = tabB[j] - tB;
          const dInk = c + m + yy - contInk;
          // asymmetric a*: for a COOL target, overshooting toward magenta (+a*) is
          // the purple-sky artifact — penalise it harder than erring toward cyan.
          const wA = dA > 0 && tA < 0 ? MAGENTA_OVERSHOOT_W : 1;
          const e = LAB_L_WEIGHT * dL * dL + wA * dA * dA + dB * dB + INK_W * dInk * dInk;
          if (e < best) {
            best = e;
            bc = c;
            bm = m;
            by = yy;
          }
        }
    C[i] = bc;
    M[i] = bm;
    Y[i] = by;
    W[i] = capTop;
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
    th[3] = W[i] * layerMm + baseMm; // white = floor (baseMm) + uniform top cap (channel W)
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
