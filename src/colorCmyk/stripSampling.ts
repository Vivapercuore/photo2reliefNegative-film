/**
 * Calibration-strip alignment geometry (DOM-free, unit testable).
 *
 * The user prints one 7-step calibration strip per filament and photographs it.
 * A draggable quad ("对准框") is laid over each photo to sample the step patches
 * and the bare-backlight white reference above/below the strip. This module is
 * the pure-geometry core of that quad: everything is plain arithmetic on source
 * (full-resolution) canvas pixel coordinates, so it can be unit tested without a
 * DOM. All functions are PURE — they never mutate their inputs.
 *
 * Quad corner order is TL, TR, BR, BL. The parametric surface matches the old
 * inline `bil` in CmykCalibrate.tsx: u runs along the top/bottom edges (0 at the
 * left, 1 at the right), v runs from the top edge (0) to the bottom edge (1).
 */

export interface Pt {
  x: number;
  y: number;
}

/** Four corners in TL, TR, BR, BL order, in source-canvas pixel coordinates. */
export type Quad = [Pt, Pt, Pt, Pt];

/**
 * Bilinear interpolation over the quad. u ∈ [0,1] runs along the top edge
 * (TL→TR) and the bottom edge (BL→BR); v ∈ [0,1] runs from the top edge to the
 * bottom edge. Matches the old `bil` semantics exactly.
 */
export function bilinear(q: Quad, u: number, v: number): Pt {
  const [TL, TR, BR, BL] = q;
  const tx = TL.x + (TR.x - TL.x) * u;
  const ty = TL.y + (TR.y - TL.y) * u;
  const bx = BL.x + (BR.x - BL.x) * u;
  const by = BL.y + (BR.y - BL.y) * u;
  return { x: tx + (bx - tx) * v, y: ty + (by - ty) * v };
}

/**
 * Initial quad: an axis-aligned rectangle centred horizontally and vertically.
 * Width = 70% of the image width; height = width / 7 (each of the 7 steps is
 * roughly square). If that height would exceed 60% of the image height the
 * whole box is scaled down uniformly, and it is additionally shrunk so that at
 * least 20% of the image height remains clear above AND below the box (room for
 * the white-reference patches). Corners returned in TL, TR, BR, BL order.
 */
export function defaultQuad(w: number, h: number): Quad {
  let bw = 0.7 * w;
  let bh = bw / 7;
  // never taller than 60% of the image (keeps the near-square step ratio in
  // check on very narrow/tall photos)
  const maxH = 0.6 * h;
  if (bh > maxH) {
    const s = maxH / bh;
    bw *= s;
    bh *= s;
  }
  // reserve >= 20% image height above and below → box height <= 60% image height
  const maxHReserve = 0.6 * h;
  if (bh > maxHReserve) {
    const s = maxHReserve / bh;
    bw *= s;
    bh *= s;
  }
  const cx = w / 2;
  const cy = h / 2;
  const x0 = cx - bw / 2;
  const x1 = cx + bw / 2;
  const y0 = cy - bh / 2;
  const y1 = cy + bh / 2;
  return [
    { x: x0, y: y0 }, // TL
    { x: x1, y: y0 }, // TR
    { x: x1, y: y1 }, // BR
    { x: x0, y: y1 }, // BL
  ];
}

/** Centres of the n step patches: u = (j+0.5)/n, v = 0.5. */
export function stepCenters(q: Quad, n: number): Pt[] {
  const out: Pt[] = [];
  for (let j = 0; j < n; j++) out.push(bilinear(q, (j + 0.5) / n, 0.5));
  return out;
}

/**
 * Per-column white-reference positions: for each of the n steps, a point above
 * the box (v = -offFrac) and below it (v = 1 + offFrac). offFrac is measured in
 * box-height multiples (the box's own v scale), so it tracks the box size.
 */
export function whiteRefPairs(
  q: Quad,
  n: number,
  offFrac: number
): { above: Pt; below: Pt }[] {
  const out: { above: Pt; below: Pt }[] = [];
  for (let j = 0; j < n; j++) {
    const u = (j + 0.5) / n;
    out.push({ above: bilinear(q, u, -offFrac), below: bilinear(q, u, 1 + offFrac) });
  }
  return out;
}

/** One step cell's size in source pixels: width = top-edge length / n,
 *  height = left-edge length (both by Euclidean distance). */
export function cellSizePx(q: Quad, n: number): { w: number; h: number } {
  const [TL, TR, , BL] = q;
  const w = Math.hypot(TR.x - TL.x, TR.y - TL.y) / n;
  const h = Math.hypot(BL.x - TL.x, BL.y - TL.y);
  return { w, h };
}

/** Half-size (source px) of the square sample window inside a cell: a quarter
 *  of the smaller cell dimension, never below 2 (so a box is always sampled). */
export function sampleHalf(q: Quad, n: number): number {
  const { w, h } = cellSizePx(q, n);
  return Math.max(2, 0.25 * Math.min(w, h));
}

/** Clamp a scalar to [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Move a single corner i to (x, y), clamped to the image bounds [0,w]×[0,h].
 *  The other three corners are unchanged. */
export function moveCorner(q: Quad, i: number, x: number, y: number, w: number, h: number): Quad {
  const next = q.map((p) => ({ x: p.x, y: p.y })) as Quad;
  next[i] = { x: clamp(x, 0, w), y: clamp(y, 0, h) };
  return next;
}

/**
 * Move edge i (connecting corner i and corner (i+1)%4) by (dx, dy): both of its
 * corners translate together. The delta is first SHRUNK to the largest amount
 * that keeps BOTH corners inside [0,w]×[0,h] — the shape of the edge never
 * changes (no per-corner clamping, which would deform it).
 */
export function moveEdge(q: Quad, edge: number, dx: number, dy: number, w: number, h: number): Quad {
  const a = edge;
  const b = (edge + 1) % 4;
  const xs = [q[a].x, q[b].x];
  const ys = [q[a].y, q[b].y];
  const cdx = clampDelta(dx, xs, w);
  const cdy = clampDelta(dy, ys, h);
  const next = q.map((p) => ({ x: p.x, y: p.y })) as Quad;
  next[a] = { x: q[a].x + cdx, y: q[a].y + cdy };
  next[b] = { x: q[b].x + cdx, y: q[b].y + cdy };
  return next;
}

/**
 * Translate the whole quad by (dx, dy), first shrinking the delta so all four
 * corners stay inside [0,w]×[0,h]. Shape and size are preserved.
 */
export function translateQuad(q: Quad, dx: number, dy: number, w: number, h: number): Quad {
  const xs = q.map((p) => p.x);
  const ys = q.map((p) => p.y);
  const cdx = clampDelta(dx, xs, w);
  const cdy = clampDelta(dy, ys, h);
  return q.map((p) => ({ x: p.x + cdx, y: p.y + cdy })) as Quad;
}

/**
 * Largest signed shift of `vals` toward `d`'s direction that keeps every value
 * in [0, hi]. For d ≥ 0 the limiting corner is the max value (headroom hi−max);
 * for d < 0 it's the min value (headroom −min). Guarantees no value leaves the
 * range while shifting them all by the SAME amount (rigid translation).
 */
function clampDelta(d: number, vals: number[], hi: number): number {
  if (d >= 0) {
    const room = hi - Math.max(...vals);
    return Math.min(d, Math.max(0, room));
  }
  const room = -Math.min(...vals); // ≤ 0, the most negative allowed shift
  return Math.max(d, Math.min(0, room));
}
