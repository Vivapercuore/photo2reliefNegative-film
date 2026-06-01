import * as THREE from 'three';
import { LacModel, Plate, Loop, Pt } from './parseLac';

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
}

/** Per-plate build output (geometry already in world/scene space). */
export interface PlateBuild {
  index: number;
  name: string;
  geometries: THREE.BufferGeometry[];
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
 */
function resolveShapes(loops: Loop[], cutHoles: boolean): ShapeSpec[] {
  const polys = loops.map(stripClose).filter((l) => l.length >= 3);
  if (!polys.length) return [];

  if (!cutHoles) {
    return polys.map((p) => ({ outer: p, holes: [] }));
  }

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
    if (depth[oi] % 2 !== 0) continue; // odd depth → it's a hole
    const holes: Pt[][] = [];
    for (let hi = 0; hi < polys.length; hi++) {
      if (depth[hi] === depth[oi] + 1 && pointInPoly(polys[hi][0], polys[oi])) {
        holes.push(polys[hi]);
      }
    }
    out.push({ outer: polys[oi], holes });
  }
  return out;
}

function specToShape(spec: ShapeSpec, extraHoles: Pt[][] = []): THREE.Shape {
  const shape = new THREE.Shape(spec.outer.map((p) => new THREE.Vector2(p.x, p.y)));
  for (const h of spec.holes) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
  for (const h of extraHoles) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
  return shape;
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

/**
 * Convert an (open or closed) polyline into a closed ribbon polygon of the
 * given width — used to turn an engrave line into a subtractable groove.
 */
function strokePolyline(pts: Pt[], width: number): Pt[] | null {
  // drop consecutive duplicates
  const p: Pt[] = [];
  for (const q of pts) {
    const last = p[p.length - 1];
    if (!last || Math.abs(last.x - q.x) > 1e-6 || Math.abs(last.y - q.y) > 1e-6) p.push(q);
  }
  if (p.length < 2) return null;

  const hw = width / 2;
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < p.length; i++) {
    const prev = p[Math.max(0, i - 1)];
    const next = p[Math.min(p.length - 1, i + 1)];
    let tx = next.x - prev.x;
    let ty = next.y - prev.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    // left normal = (-ty, tx)
    const nx = -ty;
    const ny = tx;
    left.push({ x: p[i].x + nx * hw, y: p[i].y + ny * hw });
    right.push({ x: p[i].x - nx * hw, y: p[i].y - ny * hw });
  }
  return left.concat(right.reverse());
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
  group: THREE.Group
): PlateBuild {
  const { thickness, scale, flipY, cutHoles } = opts;
  const engraveAsGroove = opts.engraveAsGroove !== false;
  const depthRatio = opts.depthRatio ?? 1;
  const widthRatio = opts.widthRatio ?? 1;
  const fullDepth = thickness * scale;
  const geometries: THREE.BufferGeometry[] = [];

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

  const cutPieces = plate.pieces.filter((p) => p.process === 'cut');
  const engravePieces = plate.pieces.filter((p) => p.process === 'engrave');

  // Pre-stroke engrave lines into ribbon polygons (scene space), each carrying
  // its own depth derived from its laser energy.
  const engraveRibbons: { poly: Pt[]; depth: number }[] = [];
  if (engraveAsGroove) {
    for (const e of engravePieces) {
      const depth = pieceDepth(e.laser.energy);
      if (depth <= 0) continue;
      const width = pieceWidth(e.laser.energy);
      for (const lp of e.loops) {
        const ribbon = strokePolyline(lp.map(tPt), width);
        if (ribbon && ribbon.length >= 3) engraveRibbons.push({ poly: ribbon, depth });
      }
    }
  }

  const finalize = (
    geom: THREE.BufferGeometry,
    baseY: number,
    color: THREE.Color
  ) => {
    // ExtrudeGeometry lies in XY (z = 0..depth) with thickness along +Z; rotate
    // to lay flat on XZ ground with thickness up along +Y, then lift to baseY
    // and move into the plate's grid cell. Baked so exported STL matches view.
    geom.rotateX(-Math.PI / 2);
    geom.translate(offsetX, baseY, offsetZ);
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
    geometries.push(geom);
  };

  for (const piece of cutPieces) {
    const tLoops: Loop[] = piece.loops.map((lp) => lp.map(tPt));
    const specs = resolveShapes(tLoops, cutHoles);
    if (!specs.length) continue;

    // Which engrave ribbons fall on this part (test against its outer outline)?
    const outer = largestLoop(tLoops);
    const ribbonsHere =
      outer && engraveRibbons.length
        ? engraveRibbons.filter((rb) => pointInPoly(rb.poly[0], outer))
        : [];

    const [r, g, b] = piece.color;
    const color = new THREE.Color(r / 255, g / 255, b / 255);

    // Groove depth for this part = max depth among its ribbons (engrave params
    // are uniform per process type, so this is exact in practice).
    const grooveDepth = ribbonsHere.reduce((m, rb) => Math.max(m, rb.depth), 0);

    if (!ribbonsHere.length || grooveDepth <= 0) {
      // Plain through-cut part: single full-thickness extrusion.
      try {
        const geom = new THREE.ExtrudeGeometry(
          specs.map((s) => specToShape(s)),
          { depth: fullDepth, bevelEnabled: false, steps: 1 }
        );
        finalize(geom, 0, color);
      } catch {
        /* skip degenerate */
      }
      continue;
    }

    // Engraved part: bottom layer (solid, thickness - grooveDepth) + top layer
    // (grooveDepth tall) with the engrave ribbons subtracted as holes → a real
    // recessed groove on the top face.
    const bottomDepth = fullDepth - grooveDepth;
    const holes = ribbonsHere.map((rb) => rb.poly);
    try {
      if (bottomDepth > 1e-4) {
        const bottom = new THREE.ExtrudeGeometry(
          specs.map((s) => specToShape(s)),
          { depth: bottomDepth, bevelEnabled: false, steps: 1 }
        );
        finalize(bottom, 0, color);
      }
      const top = new THREE.ExtrudeGeometry(
        specs.map((s) => specToShape(s, holes)),
        { depth: grooveDepth, bevelEnabled: false, steps: 1 }
      );
      finalize(top, Math.max(0, bottomDepth), color);
    } catch {
      /* skip degenerate */
    }
  }

  // Fallback: when grooves are disabled, still show engrave lines as thin
  // colored ribbons laid on the top surface so they remain visible.
  if (!engraveAsGroove) {
    const markerColor = new THREE.Color(0.6, 0.15, 0.7);
    const markerH = Math.max(0.2, fullDepth * 0.04);
    for (const e of engravePieces) {
      const width = pieceWidth(e.laser.energy);
      for (const lp of e.loops) {
        const ribbon = strokePolyline(lp.map(tPt), width);
        if (!ribbon || ribbon.length < 3) continue;
        try {
          const geom = new THREE.ExtrudeGeometry(
            new THREE.Shape(ribbon.map((p) => new THREE.Vector2(p.x, p.y))),
            { depth: markerH, bevelEnabled: false, steps: 1 }
          );
          finalize(geom, fullDepth, markerColor);
        } catch {
          /* skip */
        }
      }
    }
  }

  return {
    index: plate.index,
    name: plate.name,
    geometries,
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

  // Reference energy for the through-cut process: the depth baseline (full
  // thickness). Prefer the parsed cutEnergy; otherwise infer from pieces.
  const cutEnergy =
    model.meta.cutEnergy ??
    model.plates.reduce(
      (m, pl) => pl.pieces.reduce((mm, pc) => (pc.process === 'cut' ? Math.max(mm, pc.laser.energy ?? 0) : mm), m),
      0
    );

  selected.forEach((plate, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    // Center the whole grid around the origin.
    const rows = Math.ceil(n / cols);
    const offsetX = (col - (cols - 1) / 2) * cellW;
    const offsetZ = (row - (rows - 1) / 2) * cellH;
    const pb = buildPlate(plate, opts, cutEnergy, offsetX, offsetZ, group);
    plates.push(pb);
    triangleCount += pb.triangleCount;
    allGeoms.push(...pb.geometries);
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

  return { group, geometries: allGeoms, plates, triangleCount, size };
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
