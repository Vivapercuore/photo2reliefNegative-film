import * as THREE from 'three';
import { pushBox } from '../colorPositive/buildColorField';
import { CMYK_PALETTE } from '../colorPositive/dither';
import { CmykPart } from './buildCmykField';
import { CAL_LAYERS, CAL_LAYER_MM } from './calibration';

/**
 * Piece-able calibration print: each filament (C, M, Y, W) is a SEPARATE
 * single-colour strip, exported on its own print plate, so the user swaps one
 * filament and prints each plate with NO colour changes (no AMS needed). The
 * four printed strips then SLIDE together edge-to-edge via sliding dovetails
 * into one flat tile for the backlit photo.
 *
 * Each strip = a row of 7 wedge patches (the CAL_LAYERS thicknesses) bridging a
 * top rail and a bottom rail. Adjacent strips join along their shared X edge:
 * the lower edge of a strip carries a dovetail TONGUE that slides (along X) into
 * the GROOVE on the upper edge of the next strip. The dovetail is built as a
 * Y-staircase (each step a box) that approximates the undercut, so it prints
 * support-free yet locks the strips against in-plane separation.
 *
 * Rows top→bottom: C, M, Y, W. The white reference (I₀) is the bare backlight
 * AROUND the assembled block — sampled just above/below each column — so no
 * separate reference row is printed.
 */

/** Filament rows of the assembled tile, top→bottom (also the patch rows). */
export const CAL_ROWS = ['C', 'M', 'Y', 'W'] as const;

const PATCH_X = 10; // column width (mm)
const ROW_P = 13; // row depth in Z (mm)
const RAIL_H = 1.6; // rail / dovetail height (mm)

// sliding-dovetail (staircase) parameters
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
  // solid back wall connecting the strip body to the joint
  pushBox(buf, x0, x1, 0, RAIL_H, zEdge + DOVE_TIP, zEdge + RAIL_DEPTH);
  // overhang lips that capture the tongue's wider lower steps
  for (let s = 0; s < DOVE_STEPS; s++) {
    const voidEnd = doveExt(s) + DOVE_CLR;
    if (DOVE_TIP > voidEnd) {
      pushBox(buf, x0, x1, s * DOVE_DY, (s + 1) * DOVE_DY, zEdge + voidEnd, zEdge + DOVE_TIP);
    }
  }
}

/**
 * Build the four single-colour strips. Returned as CmykPart[] (C,M,Y,W) so the
 * export can place each on its own plate.
 */
export function buildCalibrationTile(): CmykPart[] {
  const cols = CAL_LAYERS.length;
  const W = cols * PATCH_X; // x extent
  const buffers: number[][] = [[], [], [], []]; // C, M, Y, W

  for (let i = 0; i < CAL_ROWS.length; i++) {
    const buf = buffers[i];
    const zTop = i * ROW_P;
    const zBot = (i + 1) * ROW_P;

    // top edge: solid rail for the first row (C), groove for the rest
    if (i === 0) {
      pushBox(buf, 0, W, 0, RAIL_H, zTop, zTop + RAIL_DEPTH);
    } else {
      pushGroove(buf, 0, W, zTop);
    }

    // bottom edge: solid rail, plus a tongue for all but the last row (W)
    pushBox(buf, 0, W, 0, RAIL_H, zBot - RAIL_DEPTH, zBot);
    if (i < CAL_ROWS.length - 1) {
      pushTongue(buf, 0, W, zBot);
    }

    // wedge patches between the rails (pure thickness — no base under them)
    const pz0 = zTop + RAIL_DEPTH;
    const pz1 = zBot - RAIL_DEPTH;
    for (let j = 0; j < cols; j++) {
      pushBox(buf, j * PATCH_X, (j + 1) * PATCH_X, 0, CAL_LAYERS[j] * CAL_LAYER_MM, pz0, pz1);
    }
  }

  const parts: CmykPart[] = [];
  CMYK_PALETTE.forEach((p, i) => {
    const buf = buffers[i];
    if (!buf.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buf, 3));
    geo.computeVertexNormals();
    parts.push({ palette: p, extruder: i + 1, geometry: geo, triangles: buf.length / 9 });
  });
  return parts;
}
