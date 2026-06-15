import * as THREE from 'three';
import { pushBox, ColorPart } from './buildColorField';
import { PaletteColor } from './dither';
import { CAL_PRIMARIES, PRIMARY_LABEL, PRIMARY_NOMINAL } from './calibration';

/**
 * Piece-able RGB calibration print: each primary (R, G, B, K, W) is a SEPARATE
 * single-colour strip on its own print plate, so the user swaps one filament
 * and prints each plate with NO colour changes (no AMS needed). The printed
 * strips then SLIDE together edge-to-edge via sliding dovetails into one flat
 * tile, photographed once under even reflective light.
 *
 * Unlike the CMYK tile (a row of thickness WEDGES — thickness is the variable
 * there), each RGB strip is a single SOLID, opaque swatch: the only thing the
 * first-order Neugebauer model measures is each primary's real solid colour.
 * The white (W) strip doubles as the white reference (reflective has no bare
 * backlight to sample), so no separate reference row is printed.
 *
 * Rows top→bottom: R, G, B, K, W (= CAL_PRIMARIES order).
 */

/** Filament rows of the assembled tile, top→bottom (also the patch rows). */
export const CAL_ROWS = CAL_PRIMARIES;

/** Fixed slicing layer height (mm) for the calibration print. */
export const CAL_LAYER_MM = 0.1;

const SWATCH_W = 40; // swatch width in X (mm)
const ROW_P = 16; // row depth in Z (mm)
const SWATCH_H = 1.0; // solid swatch thickness in Y (mm) — opaque for reflective
const RAIL_H = 1.6; // rail / dovetail height (mm)

// sliding-dovetail (staircase) parameters — same geometry as the CMYK tile
const DOVE_STEPS = 6;
const DOVE_DY = RAIL_H / DOVE_STEPS;
const DOVE_TIP = 2.5; // protrusion depth at the bottom (widest) step (mm)
const DOVE_TOP = 1.6; // protrusion depth at the top (narrowest) step (mm)
const DOVE_CLR = 0.25; // sliding clearance (mm)
const RAIL_DEPTH = DOVE_TIP + 1.0; // groove zone + 1mm solid back wall

/** Protrusion depth (mm) at staircase step s (widest at the bottom). */
const doveExt = (s: number) => DOVE_TIP - (s * (DOVE_TIP - DOVE_TOP)) / (DOVE_STEPS - 1);

/** Dovetail TONGUE protruding +Z from `zEdge`, full X span (one strip's lower edge). */
function pushTongue(buf: number[], x0: number, x1: number, zEdge: number): void {
  for (let s = 0; s < DOVE_STEPS; s++) {
    pushBox(buf, x0, x1, s * DOVE_DY, (s + 1) * DOVE_DY, zEdge, zEdge + doveExt(s));
  }
}

/** Dovetail GROOVE at z ≥ `zEdge` receiving a +Z tongue: a solid back wall plus
 *  the staircase overhang lips (the complement of the tongue + clearance). */
function pushGroove(buf: number[], x0: number, x1: number, zEdge: number): void {
  pushBox(buf, x0, x1, 0, RAIL_H, zEdge + DOVE_TIP, zEdge + RAIL_DEPTH);
  for (let s = 0; s < DOVE_STEPS; s++) {
    const voidEnd = doveExt(s) + DOVE_CLR;
    if (DOVE_TIP > voidEnd) {
      pushBox(buf, x0, x1, s * DOVE_DY, (s + 1) * DOVE_DY, zEdge + voidEnd, zEdge + DOVE_TIP);
    }
  }
}

/** PaletteColor for a calibration primary (ideal colour — only used to label /
 *  bind the slot; the printed colour is what we measure). */
function primaryPalette(id: (typeof CAL_PRIMARIES)[number]): PaletteColor {
  return { id, label: PRIMARY_LABEL[id], rgb: PRIMARY_NOMINAL[id] };
}

/**
 * Build the five single-colour strips. Returned as ColorPart[] (R,G,B,K,W) so
 * the export can place each on its own plate.
 */
export function buildRgbCalibrationTile(): ColorPart[] {
  const W = SWATCH_W;
  const buffers: number[][] = CAL_ROWS.map(() => []);

  for (let i = 0; i < CAL_ROWS.length; i++) {
    const buf = buffers[i];
    const zTop = i * ROW_P;
    const zBot = (i + 1) * ROW_P;

    // top edge: solid rail for the first row, groove for the rest
    if (i === 0) {
      pushBox(buf, 0, W, 0, RAIL_H, zTop, zTop + RAIL_DEPTH);
    } else {
      pushGroove(buf, 0, W, zTop);
    }

    // bottom edge: solid rail, plus a tongue for all but the last row
    pushBox(buf, 0, W, 0, RAIL_H, zBot - RAIL_DEPTH, zBot);
    if (i < CAL_ROWS.length - 1) {
      pushTongue(buf, 0, W, zBot);
    }

    // single solid swatch between the rails
    const pz0 = zTop + RAIL_DEPTH;
    const pz1 = zBot - RAIL_DEPTH;
    pushBox(buf, 0, W, 0, SWATCH_H, pz0, pz1);
  }

  const parts: ColorPart[] = [];
  CAL_ROWS.forEach((id, i) => {
    const buf = buffers[i];
    if (!buf.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buf, 3));
    geo.computeVertexNormals();
    parts.push({ palette: primaryPalette(id), extruder: i + 1, geometry: geo, triangles: buf.length / 9 });
  });
  return parts;
}
