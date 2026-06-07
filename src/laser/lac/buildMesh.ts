import * as THREE from 'three';
import { LacModel, Plate, Loop, Pt } from './parseLac';

/** Near-white base material color for all cut bodies (easier to read in 3D). */
export const BASE_COLOR = '#ededea';

/**
 * Distinct, lower-saturation colors used to tag each engrave process (by
 * energy). The same palette drives both the parameter table's row border and
 * the painted top faces on the model, so users can match them visually.
 */
export const ENGRAVE_PALETTE = [
  '#c8786b',
  '#cfa46a',
  '#7aa6b5',
  '#8aa173',
  '#a98cc0',
  '#c489a4',
  '#7baea3',
  '#b59a6a',
];

/** Color for the i-th distinct engrave process (wraps around the palette). */
export function engraveColorAt(i: number): string {
  return ENGRAVE_PALETTE[((i % ENGRAVE_PALETTE.length) + ENGRAVE_PALETTE.length) % ENGRAVE_PALETTE.length];
}

/** Ordered list of distinct engrave process types (energy desc, matches table). */
export function engraveProcessOrder(model: LacModel): string[] {
  return model.processes
    .filter((u) => u.process === 'engrave')
    .map((u) => u.params.processType);
}

export interface BuildOptions {
  /** extrusion height in mm */
  thickness: number;
  /** uniform scale applied to the X/Y path coordinates */
  scale: number;
  /** flip the Y axis (SVG/laser space is Y-down) */
  flipY: boolean;
  /** subtract holes (nested contours) from their outer contour */
  cutHoles: boolean;
  /** gap (mm) between plates when tiling all of them */
  plateGap?: number;
  /** if set, build only this plate index (1-based); otherwise tile all plates */
  onlyPlate?: number;
  /** render engrave paths as recessed grooves on the top surface */
  engraveAsGroove?: boolean;
  /**
   * Power→depth ratio. Groove depth = thickness × (pathEnergy / cutEnergy) ×
   * depthRatio, where energy = power/speed×passes. cutEnergy maps to full
   * thickness; this scales the engrave fraction. Default 1.
   */
  depthRatio?: number;
  /**
   * Energy→width ratio (mm of groove width per unit energy density).
   * Groove width = pathEnergy × widthRatio (clamped to a small minimum).
   * Default 1.
   */
  widthRatio?: number;
  /** paint the per-energy color hint on engrave marks (preview only). Default true. */
  showEngraveColors?: boolean;
}

/**
 * One physical part on a plate. A part is a single watertight solid (e.g. one
 * cut outline, or one inner plug). An engraved part keeps its two stacked
 * layers (bottom + grooved top) here so they export together as one object.
 */
export interface PartBuild {
  name: string;
  /** export geometries forming this single part (world space, Y-up) */
  geometries: THREE.BufferGeometry[];
}

/** Per-plate build output (geometry already in world/scene space). */
export interface PlateBuild {
  index: number;
  name: string;
  geometries: THREE.BufferGeometry[];
  /** individual parts on this plate, each exportable as its own 3MF object */
  parts: PartBuild[];
  triangleCount: number;
  /** plate size in mm (after scale) */
  size: { x: number; y: number };
}

export interface BuildResult {
  /** group of all meshes, ready to add to a scene */
  group: THREE.Group;
  /** flat list of every geometry in the build (world space) */
  geometries: THREE.BufferGeometry[];
  /** per-plate breakdown (for per-plate STL export) */
  plates: PlateBuild[];
  triangleCount: number;
  /** overall footprint in mm */
  size: { x: number; y: number; z: number };
  /**
   * Footprint of the single largest part, in the model's ORIGINAL (unscaled)
   * mm. `maxEdge` is the longer of its two edges — used to drive "scale the
   * largest part to a target length".
   */
  largestPart: { x: number; y: number; maxEdge: number };
}

function stripClose(loop: Loop): Pt[] {
  if (loop.length > 1) {
    const a = loop[0];
    const b = loop[loop.length - 1];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) {
      return loop.slice(0, -1);
    }
  }
  return loop;
}

/** Point-merge tolerance (mm). Source .lac paths frequently place vertices a
 *  few hundredths of a mm apart; merging them removes the T-junctions that make
 *  ExtrudeGeometry emit open boundary edges. Well below the laser kerf (~0.1mm),
 *  so real geometry is unaffected. */
const WELD_EPS_MM = 0.05;

/**
 * Sanitise a raw contour before extrusion. Laser .lac paths are often **open
 * polylines** that (a) repeat near-coincident points, (b) double back on
 * themselves as zero-width "antenna" spikes (e.g. p0→p1→p2→p1→p0), and
 * (c) carry redundant collinear points. Extruding such a contour makes the side
 * walls overlap and the end caps invert — producing the non-manifold edges,
 * "backwards" edges, reversed faces and zero/negative-volume solids that
 * slicers reject. Cleaning yields a simple polygon that extrudes watertight.
 *
 * Steps: drop consecutive duplicates (incl. wrap-around) within `eps`, then
 * iteratively remove vertices whose turn angle is ~0° collinear or ~180°
 * reversal (the antenna tips), until the polygon stabilises.
 */
function cleanContour(loop: Pt[], eps = WELD_EPS_MM): Pt[] {
  let p: Pt[] = [];
  for (const q of loop) {
    const last = p[p.length - 1];
    if (!last || Math.hypot(last.x - q.x, last.y - q.y) > eps) p.push(q);
  }
  // Open .lac polylines sometimes trace the contour once and then start a
  // SECOND lap (e.g. p0 p1 p2 p3 p0 p1 p2): the path returns to its start and
  // keeps going, so the trailing-point pop below cannot catch it and the extra
  // lap self-intersects. Truncate at the first return to the start vertex so
  // only one clean lap survives.
  for (let k = 3; k < p.length; k++) {
    if (Math.hypot(p[k].x - p[0].x, p[k].y - p[0].y) <= eps) {
      p = p.slice(0, k);
      break;
    }
  }
  while (p.length > 1 && Math.hypot(p[0].x - p[p.length - 1].x, p[0].y - p[p.length - 1].y) <= eps) {
    p.pop();
  }
  if (p.length < 3) return p;

  let changed = true;
  while (changed && p.length >= 3) {
    changed = false;
    const out: Pt[] = [];
    const n = p.length;
    for (let i = 0; i < n; i++) {
      const a = p[(i - 1 + n) % n];
      const b = p[i];
      const c = p[(i + 1) % n];
      const v1x = b.x - a.x, v1y = b.y - a.y;
      const v2x = c.x - b.x, v2y = c.y - b.y;
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
      if (l1 < eps || l2 < eps) { changed = true; continue; } // collapsed spur
      const sinT = (v1x * v2y - v1y * v2x) / (l1 * l2); // sin of turn angle
      const cosT = (v1x * v2x + v1y * v2y) / (l1 * l2); // cos of turn angle
      if (Math.abs(sinT) < 1e-3 && cosT < 0) { changed = true; continue; } // 180° antenna reversal
      if (Math.abs(sinT) < 1e-6) { changed = true; continue; }            // exactly collinear
      out.push(b);
    }
    p = out;
  }
  return p;
}

function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect = (yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** A resolved outer contour with its (even-odd) holes, as point arrays. */
interface ShapeSpec {
  outer: Pt[];
  holes: Pt[][];
}

/**
 * Resolve outer contours vs. holes within a single piece using the even-odd
 * containment rule.
 *
 * - `cutHoles = true`: only even-depth contours become solids; their odd-depth
 *   children are subtracted as real holes and the inner cut-outs are discarded
 *   (genuine through-holes).
 * - `cutHoles = false`: EVERY contour becomes its own solid that still carves
 *   its immediate children, so the inner cut-outs are kept as separate solid
 *   plugs rather than filling the parent flat. The parent keeps its hole and
 *   the plug is split out as an independent part (useful for laser assembly).
 */
function resolveShapes(loops: Loop[], cutHoles: boolean): ShapeSpec[] {
  // Sanitise every contour first: remove the duplicate points, zero-width
  // antenna spikes and bowtie/zero-area artefacts that the source .lac paths
  // carry, which would otherwise extrude into non-manifold / inverted solids.
  const polys = loops
    .map(stripClose)
    .map((l) => cleanContour(l))
    .filter((l) => l.length >= 3 && Math.abs(signedArea(l)) >= MIN_AREA_MM2);
  if (!polys.length) return [];

  const depth = polys.map((p, i) => {
    const t = p[0];
    let d = 0;
    for (let j = 0; j < polys.length; j++) {
      if (j !== i && pointInPoly(t, polys[j])) d++;
    }
    return d;
  });

  const out: ShapeSpec[] = [];
  for (let oi = 0; oi < polys.length; oi++) {
    // cutHoles: skip odd-depth contours (they are holes, discarded).
    // !cutHoles: keep every contour as its own solid part.
    if (cutHoles && depth[oi] % 2 !== 0) continue;
    // Drop degenerate sliver contours (parse artifacts a few µm across). Left
    // in, they export as near-zero objects that trip BambuStudio's "object too
    // small" heuristic, which offers to ×1000 the whole file (→ 3000mm spikes).
    if (isSliver(polys[oi])) continue;
    const holes: Pt[][] = [];
    for (let hi = 0; hi < polys.length; hi++) {
      if (depth[hi] === depth[oi] + 1 && pointInPoly(polys[hi][0], polys[oi]) && !isSliver(polys[hi])) {
        holes.push(polys[hi]);
      }
    }
    out.push({ outer: polys[oi], holes });
  }
  return out;
}

/** Min real extent (mm) a contour must span on both axes to count as a part. */
const MIN_EXTENT_MM = 0.1;

/** Min absolute area (mm²) a contour must enclose. Catches bowtie / collapsed
 *  contours whose bbox looks fine but whose signed area is ~0 — these extrude
 *  into zero/negative-volume solids that slicers flag as empty. */
const MIN_AREA_MM2 = 0.05;

/** True when a contour is a degenerate sliver (below MIN_EXTENT on an axis). */
function isSliver(p: Pt[]): boolean {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const q of p) {
    if (q.x < minX) minX = q.x;
    if (q.x > maxX) maxX = q.x;
    if (q.y < minY) minY = q.y;
    if (q.y > maxY) maxY = q.y;
  }
  return maxX - minX < MIN_EXTENT_MM || maxY - minY < MIN_EXTENT_MM;
}

/** Signed area (shoelace); >0 = counter-clockwise, <0 = clockwise. */
function signedArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    a += p[j].x * p[i].y - p[i].x * p[j].y;
  }
  return a / 2;
}

/** Force a contour to the given orientation (true = CCW / positive area). */
function orient(p: Pt[], ccw: boolean): Pt[] {
  return (signedArea(p) >= 0) === ccw ? p : [...p].reverse();
}

/**
 * Build a THREE.Shape with NORMALIZED winding: the outer contour is forced
 * counter-clockwise and every hole clockwise. This is essential: when `flipY`
 * mirrors the path coordinates (determinant −1) it inverts every contour's
 * orientation, and ExtrudeGeometry then triangulates the caps from the actual
 * orientation while building side walls from a fixed convention — the two
 * disagree and produce tens of thousands of inverted-winding (non-manifold)
 * edges that slicers reject. Pinning winding here makes the solid watertight
 * regardless of source orientation or flipY.
 */
function specToShape(spec: ShapeSpec, extraHoles: Pt[][] = []): THREE.Shape {
  const outer = orient(spec.outer, true);
  const shape = new THREE.Shape(outer.map((p) => new THREE.Vector2(p.x, p.y)));
  for (const h of spec.holes)
    shape.holes.push(new THREE.Path(orient(h, false).map((p) => new THREE.Vector2(p.x, p.y))));
  for (const h of extraHoles)
    shape.holes.push(new THREE.Path(orient(h, false).map((p) => new THREE.Vector2(p.x, p.y))));
  return shape;
}

/**
 * Seal any open boundary edges left in an extruded solid so it is watertight.
 *
 * ExtrudeGeometry triangulates its end caps with earcut, which on the source
 * .lac's self-intersecting / degenerate contours occasionally drops or flips a
 * cap triangle, leaving a small hole bounded by unmatched edges. The side walls
 * are always built per-segment and stay closed, so every leftover boundary edge
 * lies in a cap plane and chains into one or more closed loops. We weld the
 * mesh's vertices, find the directed boundary edges (used by exactly one
 * triangle), walk them into loops, and fan-fill each loop with new triangles
 * oriented to pair with the boundary — turning every unmatched edge into a
 * shared edge. The result has no open / non-manifold boundary edges, which is
 * exactly what BambuStudio flags. A watertight mesh is a no-op (no boundary
 * edges → nothing added).
 */
function sealOpenBoundaries(geom: THREE.BufferGeometry): void {
  // The fill triangles a single pass adds can themselves leave a few unmatched
  // edges where two filled cycles meet, so re-run the pass until the mesh stops
  // changing (a watertight pass is a no-op and returns 0). Bounded to avoid any
  // pathological loop.
  for (let pass = 0; pass < 8; pass++) if (sealPass(geom) === 0) break;
}

/** One sealing pass; returns the number of fill floats appended (0 if none). */
function sealPass(geom: THREE.BufferGeometry): number {
  const g = geom.index ? geom.toNonIndexed() : geom;
  const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return 0;

  const key = (x: number, y: number, z: number) =>
    `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
  const id = new Map<string, number>();
  const rep: number[][] = []; // representative float coord per welded vertex
  const tris: number[][] = [];
  const vid = (x: number, y: number, z: number): number => {
    const k = key(x, y, z);
    let i = id.get(k);
    if (i === undefined) { i = rep.length; rep.push([x, y, z]); id.set(k, i); }
    return i;
  };
  for (let i = 0; i < pos.count; i += 3) {
    const t: number[] = [];
    for (let k = 0; k < 3; k++) t.push(vid(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)));
    if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) continue;
    tris.push(t);
  }

  // Undirected edge use-count; an edge used once is on the boundary.
  const use = new Map<string, number>();
  for (const t of tris)
    for (let e = 0; e < 3; e++) {
      const a = t[e], b = t[(e + 1) % 3];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      use.set(k, (use.get(k) || 0) + 1);
    }
  // Directed boundary edges a→b (their undirected edge is used exactly once).
  const next = new Map<number, number[]>();
  let boundaryCount = 0;
  for (const t of tris)
    for (let e = 0; e < 3; e++) {
      const a = t[e], b = t[(e + 1) % 3];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (use.get(k) === 1) {
        (next.get(a) || next.set(a, []).get(a)!).push(b);
        boundaryCount++;
      }
    }
  if (!boundaryCount) return 0; // already watertight

  // Walk directed boundary edges into closed cycles and fill each. A self-
  // intersecting source contour can pinch the boundary into a figure-8 (a vertex
  // with in/out degree 2); filling such a walk as one loop would reuse an edge
  // and create a non-manifold/backwards edge. So we split the walk into SIMPLE
  // sub-cycles at every revisited vertex (a stack-based Eulerian decomposition)
  // and triangulate each simple cycle on its (planar) cap.
  const used = new Set<string>();
  const add: number[] = [];
  // Every leftover boundary edge lies in a cap plane (constant Y after the
  // rotate in finalize), so each simple cycle is a planar polygon. Triangulate
  // it by ear-clipping in the (x,z) plane — NOT a naive fan, which would bridge
  // a large/concave loop with giant triangles that shoot across the part (the
  // "spikes" the slicer showed).
  //
  // Watertightness is a purely TOPOLOGICAL requirement: the surface owns each
  // boundary directed edge a→b exactly once, so every fill triangle that sits
  // on the cycle boundary must present the REVERSE edge b→a. The cycle walk
  // gives the boundary order cycle[i]→cycle[i+1]; therefore the fill's contour
  // edges must run cycle[i+1]→cycle[i]. triangulateShape returns faces in a
  // consistent (but coordinate-dependent) winding, so we detect whether its
  // contour edges follow the cycle's forward order and flip ALL faces if they
  // do. Geometry/signed-area is never used — that heuristic cracked one cap.
  const fillCycle = (cycle: number[]) => {
    const n = cycle.length;
    if (n < 3) return;
    const emit = (i0: number, i1: number, i2: number, flip: boolean) => {
      const order = flip ? [i0, i2, i1] : [i0, i1, i2];
      for (const v of order) add.push(...rep[v]);
    };
    if (n === 3) {
      // Triangle: reverse the cycle so its edges oppose the boundary edges.
      emit(cycle[0], cycle[2], cycle[1], false);
      return;
    }
    const contour = cycle.map((v) => new THREE.Vector2(rep[v][0], rep[v][2]));
    let faces: number[][] = [];
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch {
      faces = [];
    }
    if (!faces.length) {
      // Fallback fan, reversed to oppose the boundary direction.
      for (let i = 1; i + 1 < n; i++) emit(cycle[0], cycle[i + 1], cycle[i], false);
      return;
    }
    // Detect winding: find a face edge that lies on the contour (local indices
    // p,q consecutive mod n). If it runs forward (q === p+1) the faces follow
    // the cycle's boundary order and must be flipped so the fill reverses it.
    let flip = false;
    outer: for (const f of faces) {
      for (let e = 0; e < 3; e++) {
        const p = f[e], q = f[(e + 1) % 3];
        if (q === (p + 1) % n) { flip = true; break outer; }
        if (p === (q + 1) % n) { flip = false; break outer; }
      }
    }
    for (const f of faces) emit(cycle[f[0]], cycle[f[1]], cycle[f[2]], flip);
  };
  for (const [start, outs] of Array.from(next.entries())) {
    for (const first of outs) {
      if (used.has(`${start}->${first}`)) continue;
      const stack: number[] = [start];
      const seen = new Map<number, number>([[start, 0]]); // vertex → stack index
      let prev = start, cur = first, guard = 0;
      while (guard++ < 1e6) {
        used.add(`${prev}->${cur}`);
        const at = seen.get(cur);
        if (at !== undefined) {
          // Closed a simple sub-cycle stack[at..] + cur; fill and pop it.
          const cycle = stack.slice(at);
          if (cycle.length >= 3) fillCycle(cycle);
          for (let k = stack.length - 1; k > at; k--) seen.delete(stack[k]);
          stack.length = at + 1;
        } else {
          seen.set(cur, stack.length);
          stack.push(cur);
        }
        const outs2 = next.get(cur);
        let nx = -1;
        if (outs2) for (const n of outs2) if (!used.has(`${cur}->${n}`)) { nx = n; break; }
        if (nx < 0) break;
        prev = cur; cur = nx;
      }
    }
  }
  if (!add.length) return 0;

  const old = pos.array as Float32Array;
  const merged = new Float32Array(old.length + add.length);
  merged.set(old, 0);
  merged.set(add, old.length);
  geom.setIndex(null);
  geom.setAttribute('position', new THREE.BufferAttribute(merged, 3));
  geom.deleteAttribute('normal');
  geom.deleteAttribute('uv');
  return add.length;
}

/** Largest-area loop of a piece, used as its outer outline for containment. */
function largestLoop(loops: Loop[]): Pt[] | null {
  let best: Pt[] | null = null;
  let bestA = -1;
  for (const lp of loops) {
    const p = stripClose(lp);
    if (p.length < 3) continue;
    let a = 0;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j].x * p[i].y - p[i].x * p[j].y;
    a = Math.abs(a) / 2;
    if (a > bestA) {
      bestA = a;
      best = p;
    }
  }
  return best;
}

/** A stroked ribbon: an outer outline plus, for closed input rings, the inner
 *  outline as a hole — so a closed loop becomes a clean annular band with no
 *  bridging seam (a single concatenated outline cracks open at the start). */
interface Ribbon {
  outer: Pt[];
  /** present only for closed input rings (the band's inner edge) */
  hole?: Pt[];
}

/**
 * Convert an (open or closed) polyline into a ribbon of the given width — used
 * to turn an engrave line into a subtractable groove or a colored top-face mark.
 *
 * Uses proper miter joins so the ribbon keeps a constant width through corners
 * (a naive center-difference normal makes corners pinch/bulge along straight
 * segments), and treats closed rings as annular bands so the loop closes
 * seamlessly instead of cracking open at its start/end vertex.
 */
function strokePolyline(pts: Pt[], width: number): Ribbon | null {
  // drop consecutive duplicates
  const p: Pt[] = [];
  for (const q of pts) {
    const last = p[p.length - 1];
    if (!last || Math.abs(last.x - q.x) > 1e-6 || Math.abs(last.y - q.y) > 1e-6) p.push(q);
  }
  // A closed ring repeats its first point at the end — drop it and wrap instead.
  let closed = false;
  if (p.length >= 3) {
    const a = p[0];
    const b = p[p.length - 1];
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) {
      p.pop();
      closed = true;
    }
  }
  if (p.length < 2) return null;

  const hw = width / 2;
  const n = p.length;
  const miterLimit = 4; // cap spike length at sharp corners
  const left: Pt[] = [];
  const right: Pt[] = [];

  const dir = (a: Pt, b: Pt) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  };

  for (let i = 0; i < n; i++) {
    const hasPrev = closed || i > 0;
    const hasNext = closed || i < n - 1;
    const din = hasPrev ? dir(p[(i - 1 + n) % n], p[i]) : null;
    const dout = hasNext ? dir(p[i], p[(i + 1) % n]) : null;

    // Offset direction (left normal) and how far to push it for a clean join.
    let mx: number;
    let my: number;
    let ext = 1;
    if (din && dout) {
      const nInx = -din.y;
      const nIny = din.x;
      const nOutx = -dout.y;
      const nOuty = dout.x;
      let bx = nInx + nOutx;
      let by = nIny + nOuty;
      const bl = Math.hypot(bx, by);
      if (bl < 1e-6) {
        // near 180° reversal → just use the outgoing normal
        mx = nOutx;
        my = nOuty;
      } else {
        bx /= bl;
        by /= bl;
        const cosHalf = bx * nInx + by * nIny; // cos(half exterior angle)
        ext = Math.min(miterLimit, 1 / Math.max(cosHalf, 1e-3));
        mx = bx;
        my = by;
      }
    } else {
      const d = (din || dout)!;
      mx = -d.y;
      my = d.x;
    }
    left.push({ x: p[i].x + mx * hw * ext, y: p[i].y + my * hw * ext });
    right.push({ x: p[i].x - mx * hw * ext, y: p[i].y - my * hw * ext });
  }

  if (closed) {
    // Annular band: outer = left ring, inner = right ring (as a hole).
    return { outer: left, hole: right };
  }
  // Open stroke: a single cap-less ribbon outline.
  return { outer: left.concat(right.reverse()) };
}

/**
 * Build one plate's meshes into `group`, offset by (offsetX, offsetZ) in scene
 * space. Returns the plate build info; geometry is laid flat (XZ plane, Y up).
 */
function buildPlate(
  plate: Plate,
  opts: BuildOptions,
  cutEnergy: number,
  offsetX: number,
  offsetZ: number,
  group: THREE.Group,
  /** process_type → color tagging each engrave energy on the top face */
  engraveColors: Record<string, THREE.Color>
): PlateBuild {
  const { thickness, scale, flipY, cutHoles } = opts;
  const engraveAsGroove = opts.engraveAsGroove !== false;
  const showEngraveColors = opts.showEngraveColors !== false;
  const depthRatio = opts.depthRatio ?? 1;
  const widthRatio = opts.widthRatio ?? 1;
  const fullDepth = thickness * scale;
  const geometries: THREE.BufferGeometry[] = [];
  const parts: PartBuild[] = [];

  const w = plate.bbox.width;
  const h = plate.bbox.height;
  const cx = (plate.bbox.minX + plate.bbox.maxX) / 2;
  const cy = (plate.bbox.minY + plate.bbox.maxY) / 2;

  // Center each plate around its own middle, scale, optional Y flip.
  const tx = (x: number) => (x - cx) * scale;
  const ty = (y: number) => (flipY ? -(y - cy) : y - cy) * scale;
  const tPt = (p: Pt): Pt => ({ x: tx(p.x), y: ty(p.y) });

  // Per-piece groove geometry from laser energy density:
  //   depth = thickness × (energy / cutEnergy) × depthRatio   (cut = full depth)
  //   width = energy × widthRatio                              (in mm, ×scale)
  // Falls back to a 0.3×thickness / 0.6mm baseline if energy is unknown.
  const pieceDepth = (energy?: number) => {
    const frac = energy != null && cutEnergy > 0 ? energy / cutEnergy : 0.3;
    return Math.min(fullDepth * 0.95, Math.max(0, frac * depthRatio * fullDepth));
  };
  const pieceWidth = (energy?: number) => {
    const base = energy != null ? energy * widthRatio : 0.6 * widthRatio;
    return Math.max(0.05, base) * scale;
  };

  let triangleCount = 0;

  let cutPieces = plate.pieces.filter((p) => p.process === 'cut');
  let engravePieces = plate.pieces.filter((p) => p.process === 'engrave');

  // Safety net: if after energy-based classification a plate still has only
  // engrave pieces and no cut body, there'd be nothing to extrude. Promote the
  // engraves to cuts so the geometry is still viewable/exportable.
  const promoted = !cutPieces.length && engravePieces.length > 0;
  if (promoted) {
    cutPieces = engravePieces;
    engravePieces = [];
  }

  // Pre-stroke engrave lines into ribbon polygons (scene space), each carrying
  // its own depth derived from its laser energy and the color tagging its
  // energy (so the painted top faces match the parameter table).
  const baseColor = new THREE.Color(BASE_COLOR);
  const engraveRibbons: { ribbon: Ribbon; depth: number; color: THREE.Color }[] = [];
  for (const e of engravePieces) {
    const depth = pieceDepth(e.laser.energy);
    const width = pieceWidth(e.laser.energy);
    const color = engraveColors[e.laser.processType] || new THREE.Color(0.6, 0.15, 0.7);
    for (const lp of e.loops) {
      const ribbon = strokePolyline(lp.map(tPt), width);
      if (ribbon && ribbon.outer.length >= 3) engraveRibbons.push({ ribbon, depth, color });
    }
  }

  const finalize = (
    geom: THREE.BufferGeometry,
    baseY: number,
    color: THREE.Color,
    /** preview-only mesh: shown in the viewer but excluded from export geometry */
    decorative = false,
    /** when set, the export geometry is also grouped under this part */
    part?: PartBuild
  ) => {
    // ExtrudeGeometry lies in XY (z = 0..depth) with thickness along +Z; rotate
    // to lay flat on XZ ground with thickness up along +Y, then lift to baseY
    // and move into the plate's grid cell. Baked so exported STL matches view.
    geom.rotateX(-Math.PI / 2);
    geom.translate(offsetX, baseY, offsetZ);
    // Exported solids must be watertight: seal any open cap edges earcut left on
    // self-intersecting source contours (preview-only meshes don't need it).
    if (!decorative) sealOpenBoundaries(geom);
    geom.computeVertexNormals();
    const pos = geom.getAttribute('position');
    if (!pos || pos.count === 0) {
      geom.dispose();
      return;
    }
    triangleCount += pos.count / 3;
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    group.add(new THREE.Mesh(geom, material));
    if (!decorative) {
      geometries.push(geom);
      if (part) part.geometries.push(geom);
    }
  };

  let partSeq = 0;
  for (const piece of cutPieces) {
    const tLoops: Loop[] = piece.loops.map((lp) => lp.map(tPt));
    const specs = resolveShapes(tLoops, cutHoles);
    if (!specs.length) continue;

    // Which engrave ribbons fall on this part (test against its outer outline)?
    const outer = largestLoop(tLoops);
    const ribbonsHere =
      outer && engraveRibbons.length
        ? engraveRibbons.filter((rb) => pointInPoly(rb.ribbon.outer[0], outer))
        : [];

    // Cut bodies always render in the near-white base color so the 3D
    // structure stays easy to read; the energy color goes on the top face.
    const color = baseColor;

    // Groove depth for this part = max depth among its ribbons (engrave params
    // are uniform per process type, so this is exact in practice).
    const grooveDepth = ribbonsHere.reduce((m, rb) => Math.max(m, rb.depth), 0);

    // Line-cut files have no surface grooves — paint the whole top face of each
    // promoted part with its energy color so the energy stays identifiable.
    const topCapColor = promoted && showEngraveColors ? engraveColors[piece.laser.processType] : undefined;
    // Extremely thin flush color skin: just enough to render, lifted a hair to
    // avoid z-fighting with the part's own top face, never looking raised.
    const skinH = Math.min(fullDepth * 0.05, 0.02);
    const skinLift = Math.min(fullDepth * 0.01, 0.01);
    const paintTopCap = (s: ShapeSpec) => {
      if (!topCapColor) return;
      try {
        const cap = new THREE.ExtrudeGeometry(specToShape(s), {
          depth: skinH,
          bevelEnabled: false,
          steps: 1,
        });
        finalize(cap, fullDepth - skinH + skinLift, topCapColor, true);
      } catch {
        /* skip degenerate */
      }
    };

    // Each resolved shape becomes its OWN part (independent solid). Fusing
    // several outlines into one ExtrudeGeometry makes shared boundary edges be
    // used by 4+ triangles → non-manifold; one geometry per shape keeps every
    // body watertight. Splitting into parts also lets the exporter emit each as
    // a separate object for easier bed arrangement.
    for (const s of specs) {
      const part: PartBuild = { name: `${piece.name || 'part'}#${++partSeq}`, geometries: [] };
      if (!ribbonsHere.length || grooveDepth <= 0) {
        // Plain through-cut part: single full-thickness extrusion.
        try {
          const geom = new THREE.ExtrudeGeometry(specToShape(s), {
            depth: fullDepth,
            bevelEnabled: false,
            steps: 1,
          });
          finalize(geom, 0, color, false, part);
          paintTopCap(s);
        } catch {
          /* skip degenerate */
        }
      } else {
        // Engraved part: bottom layer (solid, thickness - grooveDepth) + top
        // layer (grooveDepth tall) with the engrave ribbons subtracted as holes
        // → a real recessed groove on the top face. Both layers belong to the
        // same part so they export together as one object.
        const bottomDepth = fullDepth - grooveDepth;
        // Ribbons that fall inside THIS shape carve grooves on its top layer.
        // A closed-ring ribbon is an annular band (outer minus hole); subtract
        // its outer outline and add its inner outline back as solid so only the
        // band is recessed, not the whole enclosed area. Open ribbons subtract
        // their single outline directly.
        const myHoles: Pt[][] = [];
        const myIslands: Pt[][] = [];
        for (const rb of ribbonsHere) {
          if (!pointInPoly(rb.ribbon.outer[0], s.outer)) continue;
          myHoles.push(rb.ribbon.outer);
          if (rb.ribbon.hole) myIslands.push(rb.ribbon.hole);
        }
        try {
          if (bottomDepth > 1e-4) {
            const bottom = new THREE.ExtrudeGeometry(specToShape(s), {
              depth: bottomDepth,
              bevelEnabled: false,
              steps: 1,
            });
            finalize(bottom, 0, color, false, part);
          }
          const top = new THREE.ExtrudeGeometry(specToShape(s, myHoles), {
            depth: grooveDepth,
            bevelEnabled: false,
            steps: 1,
          });
          finalize(top, Math.max(0, bottomDepth), color, false, part);
          // Refill the inner area of each annular groove so only the band is
          // recessed (the area enclosed by a closed ring stays at full height).
          for (const island of myIslands) {
            if (island.length < 3) continue;
            const isl = new THREE.ExtrudeGeometry(
              new THREE.Shape(island.map((p) => new THREE.Vector2(p.x, p.y))),
              { depth: grooveDepth, bevelEnabled: false, steps: 1 }
            );
            finalize(isl, Math.max(0, bottomDepth), color, false, part);
          }
        } catch {
          /* skip degenerate */
        }
      }
      if (part.geometries.length) parts.push(part);
    }
  }

  // Paint the engrave marks with their per-energy color so each energy is
  // visually identifiable and matches the parameter table. The colored skin is
  // laid flush with the top surface (its top at fullDepth, reaching only a hair
  // below) so it tints the marks without protruding above the part.
  if (showEngraveColors) {
    // An extremely thin color skin sitting right at the surface — just enough
    // thickness to render reliably, lifted a hair to avoid z-fighting.
    const markerH = Math.min(fullDepth * 0.05, 0.02);
    const lift = Math.min(fullDepth * 0.01, 0.01);
    for (const rb of engraveRibbons) {
      if (rb.ribbon.outer.length < 3) continue;
      try {
        const shape = new THREE.Shape(rb.ribbon.outer.map((p) => new THREE.Vector2(p.x, p.y)));
        // A closed-ring ribbon is an annular band: punch its inner outline so
        // only the band is tinted, matching the recessed groove geometry.
        if (rb.ribbon.hole && rb.ribbon.hole.length >= 3) {
          shape.holes.push(new THREE.Path(rb.ribbon.hole.map((p) => new THREE.Vector2(p.x, p.y))));
        }
        const geom = new THREE.ExtrudeGeometry(shape, {
          depth: markerH,
          bevelEnabled: false,
          steps: 1,
        });
        // In groove mode the skin rests on the recessed groove floor (depth
        // below the surface) so the color clearly reads as sunk in; otherwise
        // it sits flush on the top face.
        const baseY = engraveAsGroove
          ? Math.max(0, fullDepth - rb.depth) + lift
          : fullDepth - markerH + lift;
        finalize(geom, baseY, rb.color, true);
      } catch {
        /* skip */
      }
    }
  }

  return {
    index: plate.index,
    name: plate.name,
    geometries,
    parts,
    triangleCount,
    size: { x: w * scale, y: h * scale },
  };
}

/** Build a 3D model from a parsed LAC model, tiling plates in a grid. */
export function buildModel(model: LacModel, opts: BuildOptions): BuildResult {
  const group = new THREE.Group();
  const scale = opts.scale;
  const gap = (opts.plateGap ?? 20) * scale;

  const selected =
    opts.onlyPlate != null ? model.plates.filter((p) => p.index === opts.onlyPlate) : model.plates;

  // Grid layout: near-square arrangement of plate cells.
  const n = selected.length || 1;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const cellW = Math.max(...selected.map((p) => p.bbox.width), 1) * scale + gap;
  const cellH = Math.max(...selected.map((p) => p.bbox.height), 1) * scale + gap;

  const plates: PlateBuild[] = [];
  let triangleCount = 0;
  const allGeoms: THREE.BufferGeometry[] = [];
  // Footprint (XZ, world space) of the largest single part seen so far.
  let largestArea = -1;
  let largestPartWorld = { x: 0, y: 0 };

  // Reference energy for the through-cut process: the depth baseline (full
  // thickness). Prefer the parsed cutEnergy; otherwise infer from pieces.
  const cutEnergy =
    model.meta.cutEnergy ??
    model.plates.reduce(
      (m, pl) => pl.pieces.reduce((mm, pc) => (pc.process === 'cut' ? Math.max(mm, pc.laser.energy ?? 0) : mm), m),
      0
    );

  // Tag each distinct engrave energy with a palette color (same order as the
  // parameter table), so the painted top faces match the table's row borders.
  const engraveColors: Record<string, THREE.Color> = {};
  engraveProcessOrder(model).forEach((pt, i) => {
    engraveColors[pt] = new THREE.Color(engraveColorAt(i));
  });

  selected.forEach((plate, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    // Center the whole grid around the origin.
    const rows = Math.ceil(n / cols);
    const offsetX = (col - (cols - 1) / 2) * cellW;
    const offsetZ = (row - (rows - 1) / 2) * cellH;
    const pb = buildPlate(plate, opts, cutEnergy, offsetX, offsetZ, group, engraveColors);
    plates.push(pb);
    triangleCount += pb.triangleCount;
    allGeoms.push(...pb.geometries);
    // Track the largest part by XZ footprint area (world space).
    for (const part of pb.parts) {
      const fp = partFootprint(part.geometries);
      const area = fp.x * fp.y;
      if (area > largestArea) {
        largestArea = area;
        largestPartWorld = fp;
      }
    }
  });

  // Rest panels on the ground plane (thickness runs 0..thickness*scale in Y).
  const scaledThickness = opts.thickness * scale;
  group.position.y = -scaledThickness / 2;

  const rows = Math.ceil(n / cols);
  const size = {
    x: cols * cellW - gap,
    y: scaledThickness,
    z: rows * cellH - gap,
  };

  // Largest part footprint back in original (unscaled) mm for the UI.
  const lp = {
    x: largestArea > 0 ? largestPartWorld.x / scale : 0,
    y: largestArea > 0 ? largestPartWorld.y / scale : 0,
    maxEdge: largestArea > 0 ? Math.max(largestPartWorld.x, largestPartWorld.y) / scale : 0,
  };

  return { group, geometries: allGeoms, plates, triangleCount, size, largestPart: lp };
}

/** XZ-plane (footprint) extents of a set of world-space geometries, in mm. */
function partFootprint(geoms: THREE.BufferGeometry[]): { x: number; y: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const g of geoms) {
    const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!isFinite(minX)) return { x: 0, y: 0 };
  return { x: maxX - minX, y: maxZ - minZ };
}

/** Release all GPU/CPU resources held by a build result. */
export function disposeBuild(result: BuildResult | null) {
  if (!result) return;
  result.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else if (mat) mat.dispose();
  });
}
