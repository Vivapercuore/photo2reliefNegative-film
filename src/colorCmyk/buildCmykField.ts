import * as THREE from 'three';
import { PaletteColor } from '../colorPositive/dither';
import { pushBox } from '../colorPositive/buildColorField';
import { CmykField, CMYK_PALETTE } from './cmyk';

/**
 * Geometry builder for the CMY+White lithophane: every cell of every channel
 * becomes a box spanning [bottom, bottom + thickness] where bottom is the
 * running sum of the channels stacked below it — a contiguous per-pixel column,
 * no air gaps.
 *
 * Stack order bottom→top is W → Y → M → C: the white diffuser/luminance layer
 * sits against the backlight (its thickness sets 明度, lithophane-style), with
 * C/M/Y on top carrying colour. Filament slots stay in C,M,Y,W order (1..4).
 *
 * Cells with equal (bottom, thickness) are greedy-merged into rectangles, and
 * — as in the color-positive module — every box is exported as an independent
 * solid (vertices welded per box) so touching boxes never produce non-manifold
 * edges in the slicer.
 */
export interface CmykPart {
  palette: PaletteColor;
  /** 1-based filament slot in CMYK_PALETTE order */
  extruder: number;
  geometry: THREE.BufferGeometry;
  triangles: number;
}

export interface CmykBuildOptions {
  /** print layer height (mm) — the channel-thickness quantum */
  layerMm: number;
  /** uniform base slab in LAYERS, printed in Y (the lightest ink) — keeps
   *  pure-white cells (all channels 0) from becoming through-holes */
  baseLayers: number;
  /** uniform white cap in LAYERS on TOP of every column (viewing-side diffuser,
   *  conformal — follows each column's height) */
  topLayers: number;
  addBorder: boolean;
  /** border width (mm), printed in K at the tallest column height */
  borderWidth: number;
}

/** Stack order bottom→top as indices into channels[C,M,Y,W]: W, Y, M, C
 *  (white diffuser/luminance against the backlight, colours on top). */
const STACK_ORDER = [3, 2, 1, 0];

interface LevelRect {
  c: number;
  r: number;
  w: number;
  h: number;
  /** bottom of the box in layers */
  bot: number;
  /** thickness of the box in layers */
  lv: number;
}

/**
 * Greedy-merge cells whose (bottom, thickness) pair is identical into maximal
 * rectangles; zero-thickness cells are skipped (holes in that channel).
 */
function greedyLevelRects(
  bottom: Uint16Array,
  lv: Uint8Array,
  cols: number,
  rows: number
): LevelRect[] {
  const used = new Uint8Array(cols * rows);
  const out: LevelRect[] = [];
  const key = (i: number) => (lv[i] === 0 ? -1 : bottom[i] * 256 + lv[i]);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (used[i]) continue;
      const k = key(i);
      if (k < 0) {
        used[i] = 1;
        continue;
      }
      let w = 1;
      while (c + w < cols && !used[i + w] && key(i + w) === k) w++;
      let h = 1;
      grow: while (r + h < rows) {
        const base = (r + h) * cols + c;
        for (let dx = 0; dx < w; dx++) {
          if (used[base + dx] || key(base + dx) !== k) break grow;
        }
        h++;
      }
      for (let dy = 0; dy < h; dy++) {
        for (let dx = 0; dx < w; dx++) used[(r + dy) * cols + c + dx] = 1;
      }
      out.push({ c, r, w, h, bot: bottom[i], lv: lv[i] });
    }
  }
  return out;
}

/** Build the four per-channel solids (only non-empty channels are returned). */
export function buildCmykParts(field: CmykField, opts: CmykBuildOptions): CmykPart[] {
  const { cols, rows, dotMm, channels } = field;
  const { layerMm, baseLayers, topLayers, addBorder, borderWidth } = opts;
  const W = cols * dotMm;
  const D = rows * dotMm;
  const bw = addBorder ? borderWidth : 0;

  const buffers: number[][] = [[], [], [], []];
  // running bottom (in layers) per cell — every channel stacks on the previous
  const bottom = new Uint16Array(cols * rows).fill(baseLayers);
  let maxTop = baseLayers;

  for (const ch of STACK_ORDER) {
    const lv = channels[ch];
    for (const { c, r, w, h, bot, lv: t } of greedyLevelRects(bottom, lv, cols, rows)) {
      pushBox(
        buffers[ch],
        c * dotMm,
        (c + w) * dotMm,
        bot * layerMm,
        (bot + t) * layerMm,
        r * dotMm,
        (r + h) * dotMm
      );
    }
    for (let i = 0; i < bottom.length; i++) {
      bottom[i] += lv[i];
      if (bottom[i] > maxTop) maxTop = bottom[i];
    }
  }

  // conformal white cap on TOP of every column (viewing-side diffuser): each
  // cell gets `topLayers` white from its current top upward — greedy-merged by
  // shared (bottom, thickness). White is filament index 3.
  if (topLayers > 0) {
    const topLv = new Uint8Array(cols * rows).fill(topLayers);
    for (const { c, r, w, h, bot, lv: t } of greedyLevelRects(bottom, topLv, cols, rows)) {
      pushBox(
        buffers[3],
        c * dotMm,
        (c + w) * dotMm,
        bot * layerMm,
        (bot + t) * layerMm,
        r * dotMm,
        (r + h) * dotMm
      );
    }
    for (let i = 0; i < bottom.length; i++) {
      bottom[i] += topLayers;
      if (bottom[i] > maxTop) maxTop = bottom[i];
    }
  }

  // white diffuser floor: full footprint 0..base — evens the backlight and
  // keeps pure-white cells solid (no holes). White is filament index 3.
  if (baseLayers > 0) {
    pushBox(buffers[3], 0, W, 0, baseLayers * layerMm, 0, D);
  }

  // border wall (white — no black filament here), tallest-column height
  if (addBorder) {
    const hTop = maxTop * layerMm;
    pushBox(buffers[3], -bw, W + bw, 0, hTop, -bw, 0); // front
    pushBox(buffers[3], -bw, W + bw, 0, hTop, D, D + bw); // back
    pushBox(buffers[3], -bw, 0, 0, hTop, 0, D); // left
    pushBox(buffers[3], W, W + bw, 0, hTop, 0, D); // right
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
