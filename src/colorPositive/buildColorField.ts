import * as THREE from 'three';
import { DitherResult, PaletteColor } from './dither';

/**
 * One printable color body: all dots of a single palette color, merged into one
 * solid, bound to a filament slot (extruder). Geometry is Three.js Y-up (height
 * along +Y); the 3MF exporter rotates it to Z-up.
 */
export interface ColorPart {
  palette: PaletteColor;
  /** 1-based filament slot = palette index + 1 */
  extruder: number;
  geometry: THREE.BufferGeometry;
  /** triangles in this body */
  triangles: number;
}

export interface ColorFieldOptions {
  /** colored pixel layer thickness (mm) */
  colorThickness: number;
  /** solid black backing thickness (mm) */
  baseThickness: number;
  addBorder: boolean;
  /** border width (mm) */
  borderWidth: number;
  /**
   * Raise the fill-color (black/white) dots to the full height instead of
   * leaving them recessed at base height, so the top face comes out flat.
   * Only sensible when every palette color has its own filament slot (≥5-slot
   * AMS) — with the shared black/white-slot trick the fill MUST stay below the
   * pause layer.
   */
  flattenTop?: boolean;
}

// Unit cube (Three BoxGeometry, outward winding), range [-0.5, 0.5], non-indexed.
const UNIT_BOX = (() => {
  const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const arr = (g.getAttribute('position').array as Float32Array).slice();
  g.dispose();
  return arr;
})();

/** Append an axis-aligned box's triangles (outward) to a flat position array. */
export function pushBox(
  arr: number[],
  x0: number, x1: number,
  y0: number, y1: number,
  z0: number, z1: number
): void {
  const sx = x1 - x0;
  const sy = y1 - y0;
  const sz = z1 - z0;
  for (let i = 0; i < UNIT_BOX.length; i += 3) {
    arr.push(
      (UNIT_BOX[i] + 0.5) * sx + x0,
      (UNIT_BOX[i + 1] + 0.5) * sy + y0,
      (UNIT_BOX[i + 2] + 0.5) * sz + z0
    );
  }
}

// fill / backing color = the grayscale palette entry (black OR white): r===g===b
function indexOfFill(palette: PaletteColor[]): number {
  const i = palette.findIndex((p) => p.rgb[0] === p.rgb[1] && p.rgb[1] === p.rgb[2]);
  return i >= 0 ? i : palette.length - 1;
}

interface Rect {
  c: number;
  r: number;
  w: number;
  h: number;
}

/**
 * Greedy meshing: merge contiguous cells matching `pred` into maximal rectangles
 * so a solid region becomes a few big blocks instead of thousands of dots.
 */
function greedyRects(
  pred: (idx: number) => boolean,
  indices: Uint8Array,
  cols: number,
  rows: number
): Rect[] {
  const used = new Uint8Array(cols * rows);
  const rects: Rect[] = [];
  const free = (c: number, r: number) => pred(indices[r * cols + c]) && !used[r * cols + c];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!free(c, r)) continue;
      let w = 1;
      while (c + w < cols && free(c + w, r)) w++;
      let h = 1;
      grow: while (r + h < rows) {
        for (let k = 0; k < w; k++) {
          if (!free(c + k, r + h)) break grow;
        }
        h++;
      }
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) used[(r + dy) * cols + c + dx] = 1;
      }
      rects.push({ c, r, w, h });
    }
  }
  return rects;
}

/**
 * Build per-color solids from a dither result:
 *  - black (K): ONE full-footprint slab (z 0..base) — its own dots plus the
 *    backing under the colored dots union into the whole rectangle, so a single
 *    box replaces thousands of merged dot boxes. Black dots read as the slab
 *    top showing through (recessed by colorThickness) — unless `flattenTop`,
 *    which adds full-height columns over the black dots for a flat top face.
 *  - R/G/B (and white): the top layer (z base..total) over their dots, so the
 *    colored dots stand proud while black sits in the valleys.
 * Cells are greedy-merged per color. One ColorPart per used palette color.
 *
 * Every box is an independent closed solid: the exporter welds vertices per
 * solid only (see geometryToMesh), so touching boxes never share vertices —
 * sharing them makes slicers flag every shared face as non-manifold edges.
 */
export function buildColorField(res: DitherResult, opts: ColorFieldOptions): ColorPart[] {
  const { cols, rows, dotMm, indices, palette } = res;
  const { colorThickness, baseThickness, addBorder, borderWidth, flattenTop } = opts;
  const fillIdx = indexOfFill(palette);
  const total = baseThickness + colorThickness;
  const W = cols * dotMm;
  const D = rows * dotMm;
  const bw = addBorder ? borderWidth : 0;

  const buffers: number[][] = palette.map(() => []);
  const rectsFor = (pred: (idx: number) => boolean) => greedyRects(pred, indices, cols, rows);

  // black slab: dots + backing under colored dots = the whole footprint 0..base
  if (baseThickness > 0) {
    pushBox(buffers[fillIdx], 0, W, 0, baseThickness, 0, D);
  }

  // flattenTop → black dot columns (base..total) on the slab, levelling the top
  if (flattenTop && colorThickness > 0) {
    for (const { c, r, w, h } of rectsFor((i) => i === fillIdx)) {
      pushBox(buffers[fillIdx], c * dotMm, (c + w) * dotMm, baseThickness, total, r * dotMm, (r + h) * dotMm);
    }
  }

  // border wall (black), full height, around the four edges
  if (addBorder) {
    pushBox(buffers[fillIdx], -bw, W + bw, 0, total, -bw, 0); // front
    pushBox(buffers[fillIdx], -bw, W + bw, 0, total, D, D + bw); // back
    pushBox(buffers[fillIdx], -bw, 0, 0, total, 0, D); // left
    pushBox(buffers[fillIdx], W, W + bw, 0, total, 0, D); // right
  }

  // colored top layer (R/G/B): z base..total over their dots
  if (colorThickness > 0) {
    for (let ci = 0; ci < palette.length; ci++) {
      if (ci === fillIdx) continue;
      for (const { c, r, w, h } of rectsFor((i) => i === ci)) {
        pushBox(buffers[ci], c * dotMm, (c + w) * dotMm, baseThickness, total, r * dotMm, (r + h) * dotMm);
      }
    }
  }

  const parts: ColorPart[] = [];
  palette.forEach((p, i) => {
    const buf = buffers[i];
    if (!buf.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buf, 3));
    geo.computeVertexNormals();
    parts.push({ palette: p, extruder: i + 1, geometry: geo, triangles: buf.length / 9 });
  });
  return parts;
}

/**
 * Split a ColorPart's merged geometry back into its constituent boxes, one
 * BufferGeometry per box (36 vertices each — pushBox's unit). Pass this array
 * to the 3MF exporter so each box welds as an independent closed solid;
 * welding the whole part as one mesh fuses the faces of touching boxes into
 * shared edges, which Bambu reports as thousands of non-manifold edges.
 * The views share the source Float32Array — no geometry data is copied.
 */
export function partSolids(part: ColorPart): THREE.BufferGeometry[] {
  return splitBoxSolids(part.geometry);
}

/** Generic form of `partSolids` for any pushBox-built geometry (CMYK module). */
export function splitBoxSolids(geometry: THREE.BufferGeometry): THREE.BufferGeometry[] {
  const arr = (geometry.getAttribute('position') as THREE.BufferAttribute)
    .array as Float32Array;
  const out: THREE.BufferGeometry[] = [];
  const FLOATS_PER_BOX = UNIT_BOX.length; // 36 verts × 3
  for (let o = 0; o + FLOATS_PER_BOX <= arr.length; o += FLOATS_PER_BOX) {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.BufferAttribute(arr.subarray(o, o + FLOATS_PER_BOX), 3)
    );
    out.push(g);
  }
  return out;
}
