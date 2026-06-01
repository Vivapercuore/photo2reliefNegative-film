import { unzipSync, strFromU8 } from 'fflate';

/** 2D point */
export interface Pt {
  x: number;
  y: number;
}

/** A single (closed) sub-path / contour */
export type Loop = Pt[];

/** Fabrication operation for a path. */
export type ProcessType = 'cut' | 'engrave';

/** Laser parameters resolved for a path's process type. */
export interface LaserParams {
  /** raw process_type string from object_settings, e.g. "LaserLineEngrave" */
  processType: string;
  /** max laser power 0-100 (if known) */
  power?: number;
  /** feed speed (if known) */
  speed?: number;
  /** number of passes */
  passes?: number;
  /**
   * Relative energy density = power / speed * passes. Higher = deeper/wider.
   * Cut paths have the highest density (full through-cut); engrave much lower.
   */
  energy?: number;
}

/** One geometry object after placement into a plate's world (mm) space */
export interface Piece {
  objId: number | string;
  name: string;
  /** RGBA 0-255 */
  color: [number, number, number, number];
  /** sub-paths in plate-local mm coordinates (outer + holes mixed) */
  loops: Loop[];
  /** cut = through cut (solid part); engrave = surface groove (no cut-through) */
  process: ProcessType;
  /** whether the source path was marked closed */
  closed: boolean;
  /** resolved laser parameters for this path's process type */
  laser: LaserParams;
}

export interface Bbox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/** One physical cut plate (≈ a single sheet of material). */
export interface Plate {
  index: number;
  name: string;
  pieces: Piece[];
  bbox: Bbox;
}

export interface LacMeta {
  title?: string;
  designer?: string;
  description?: string;
  /** material name parsed from Metadata2D/*.config, e.g. "3mm Birch Plywood" */
  material?: string;
  /** thickness in mm parsed from the material name */
  thicknessMm?: number;
  application?: string;
  fileVersion?: string;
  /** how plates were derived: project_settings layout, or a fallback */
  source: 'project_settings' | 'components' | 'flat';
  /** reference energy density of the through-cut process (depth baseline) */
  cutEnergy?: number;
  /** representative energy density of engrave paths (if any) */
  engraveEnergy?: number;
}

/** A distinct laser process used in the file, with how many paths use it. */
export interface ProcessUsage {
  params: LaserParams;
  /** kind derived from the process type */
  process: ProcessType;
  /** number of resolved path pieces using this process type */
  count: number;
}

export interface LacModel {
  plates: Plate[];
  /** bbox over every plate's own local content (max extents) */
  bbox: Bbox;
  meta: LacMeta;
  /** every distinct process_type actually used by resolved pieces */
  processes: ProcessUsage[];
  warnings: string[];
}

type Mat = [number, number, number, number, number, number]; // a b c d e f
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

function parseTransform(s?: string): Mat {
  if (!s) return IDENTITY;
  const n = s.trim().split(/[\s,]+/).map(Number);
  if (n.length >= 6 && n.every((x) => !Number.isNaN(x))) {
    return [n[0], n[1], n[2], n[3], n[4], n[5]];
  }
  return IDENTITY;
}

/** Compose two affine matrices: result applies `child` first, then `parent`. */
function compose(p: Mat, c: Mat): Mat {
  return [
    p[0] * c[0] + p[2] * c[1],
    p[1] * c[0] + p[3] * c[1],
    p[0] * c[2] + p[2] * c[3],
    p[1] * c[2] + p[3] * c[3],
    p[0] * c[4] + p[2] * c[5] + p[4],
    p[1] * c[4] + p[3] * c[5] + p[5],
  ];
}

function applyMat(m: Mat, x: number, y: number): Pt {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

function parseColor(c?: string): [number, number, number, number] {
  if (typeof c === 'string') {
    const n = c.trim().split(/[\s,]+/).map(Number);
    if (n.length >= 3 && n.slice(0, 3).every((x) => !Number.isNaN(x))) {
      return [n[0], n[1], n[2], n.length > 3 && !Number.isNaN(n[3]) ? n[3] : 255];
    }
  }
  return [180, 140, 100, 255];
}

/**
 * Parse an SVG path-data string into an array of sub-paths (loops of points).
 * Bambu cut data uses only M/L/Z; curve commands are coarsely approximated by
 * their end points so unexpected input won't crash.
 */
export function parsePathData(d: string): Loop[] {
  const loops: Loop[] = [];
  let cur: Pt[] = [];
  let start: Pt = { x: 0, y: 0 };
  let cx = 0;
  let cy = 0;
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
  let i = 0;
  let cmd = '';
  const num = () => parseFloat(tokens[i++]);
  const isCmd = (t: string) => /^[a-zA-Z]$/.test(t);
  const push = (x: number, y: number) => {
    cur.push({ x, y });
    cx = x;
    cy = y;
  };
  const flush = () => {
    if (cur.length > 1) loops.push(cur);
    cur = [];
  };

  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++];
    switch (cmd) {
      case 'M':
        flush();
        start = { x: num(), y: num() };
        cur = [{ ...start }];
        cx = start.x;
        cy = start.y;
        cmd = 'L';
        break;
      case 'm':
        flush();
        start = { x: cx + num(), y: cy + num() };
        cur = [{ ...start }];
        cx = start.x;
        cy = start.y;
        cmd = 'l';
        break;
      case 'L':
        push(num(), num());
        break;
      case 'l':
        push(cx + num(), cy + num());
        break;
      case 'H':
        push(num(), cy);
        break;
      case 'h':
        push(cx + num(), cy);
        break;
      case 'V':
        push(cx, num());
        break;
      case 'v':
        push(cx, cy + num());
        break;
      case 'Z':
      case 'z':
        if (cur.length) cur.push({ ...start });
        flush();
        cx = start.x;
        cy = start.y;
        break;
      case 'C':
        num(); num(); num(); num();
        push(num(), num());
        break;
      case 'c':
        num(); num(); num(); num();
        push(cx + num(), cy + num());
        break;
      case 'S':
      case 'Q':
        num(); num();
        push(num(), num());
        break;
      case 's':
      case 'q':
        num(); num();
        push(cx + num(), cy + num());
        break;
      case 'T':
        push(num(), num());
        break;
      case 't':
        push(cx + num(), cy + num());
        break;
      case 'A':
        num(); num(); num(); num(); num();
        push(num(), num());
        break;
      case 'a':
        num(); num(); num(); num(); num();
        push(cx + num(), cy + num());
        break;
      default:
        i++;
        break;
    }
  }
  flush();
  return loops;
}

function emptyBbox(): Bbox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, width: 0, height: 0 };
}

function growBbox(b: Bbox, p: Pt) {
  if (p.x < b.minX) b.minX = p.x;
  if (p.y < b.minY) b.minY = p.y;
  if (p.x > b.maxX) b.maxX = p.x;
  if (p.y > b.maxY) b.maxY = p.y;
}

function finalizeBbox(b: Bbox) {
  if (!Number.isFinite(b.minX)) {
    b.minX = b.minY = b.maxX = b.maxY = 0;
  }
  b.width = b.maxX - b.minX;
  b.height = b.maxY - b.minY;
}

/**
 * Recursively resolve a component (which may target a PathObject or an
 * AttachedGroup of nested components) into placed pieces, accumulating the
 * affine transform down the tree.
 */
function collectComponent(
  objId: number | string,
  worldT: Mat,
  byId: Record<string, any>,
  laserMap: Record<string, LaserParams>,
  out: Piece[],
  bbox: Bbox,
  depth = 0
) {
  if (depth > 32) return; // guard against pathological cycles
  const o = byId[objId];
  if (!o) return;

  if (o.type === 'PathObject' && typeof o.path_data === 'string') {
    const rawLoops = parsePathData(o.path_data);
    if (!rawLoops.length) return;
    const loops = rawLoops.map((lp) =>
      lp.map((p) => {
        const wp = applyMat(worldT, p.x, p.y);
        growBbox(bbox, wp);
        return wp;
      })
    );
    const laser: LaserParams = laserMap[o.obj_id] || { processType: 'LaserLineCut' };
    out.push({
      objId: o.obj_id,
      name: o.name || '',
      color: parseColor(o.color),
      loops,
      process: /cut/i.test(laser.processType) && !/engrav|deboss|score|pen|draw/i.test(laser.processType) ? 'cut' : 'engrave',
      closed: o.is_closed !== false,
      laser,
    });
    return;
  }

  if (o.type === 'AttachedGroup' && Array.isArray(o.components)) {
    for (const child of o.components) {
      collectComponent(child.obj_id, compose(worldT, parseTransform(child.transform)), byId, laserMap, out, bbox, depth + 1);
    }
  }
}

/** Translate a plate's pieces so its content starts near the origin (0,0). */
function localizePlate(pieces: Piece[], bbox: Bbox) {
  const dx = bbox.minX;
  const dy = bbox.minY;
  for (const piece of pieces) {
    for (const lp of piece.loops) {
      for (const p of lp) {
        p.x -= dx;
        p.y -= dy;
      }
    }
  }
  bbox.maxX -= dx;
  bbox.maxY -= dy;
  bbox.minX = 0;
  bbox.minY = 0;
}

/** Parse a Bambu `.lac` (Bambu Suite 2D laser / knife-cut) package. */
export function parseLac(buf: Uint8Array): LacModel {
  const warnings: string[] = [];

  // Decompress only the small text entries (the package also has tens of MB of
  // preview images we don't need).
  const files = unzipSync(buf, {
    filter: (f) => /\.(json|config|xml|rels)$/i.test(f.name),
  });

  const findKey = (re: RegExp) => Object.keys(files).find((k) => re.test(k));
  const readJson = (re: RegExp) => {
    const k = findKey(re);
    if (!k) return null;
    try {
      return JSON.parse(strFromU8(files[k]));
    } catch {
      return null;
    }
  };

  const modelKey = findKey(/2dmodel\.json$/i);
  if (!modelKey) {
    throw new Error('未在 .lac 中找到 2D/2dmodel.json，可能不是受支持的激光刀切文件');
  }
  const model = JSON.parse(strFromU8(files[modelKey]));

  const meta: LacMeta = {
    application: model.Application,
    fileVersion: model.FileVersion,
    source: 'flat',
  };

  const entry = readJson(/entry\.json$/i);
  if (entry) {
    meta.title = entry.Title || entry.ProfileTitle;
    meta.designer = entry.Designer || entry.DesignerUserName || entry.ProfileUserName;
    meta.description = entry.Description;
  }

  // Material thickness from the Metadata2D config filename (skip process /
  // machine configs).
  const matKey = Object.keys(files).find(
    (k) => /metadata2d\/.+\.config$/i.test(k) && !/process/i.test(k) && !/h2d|bambu lab/i.test(k)
  );
  if (matKey) {
    meta.material = matKey.replace(/^.*\//, '').replace(/\.config$/i, '');
    const m = meta.material.match(/(\d+(?:\.\d+)?)\s*mm/i);
    if (m) meta.thicknessMm = parseFloat(m[1]);
  }

  // Process config: per process_type laser power/speed. Energy density
  // (power/speed*passes) drives how deep/wide a path engraves vs cuts.
  const procCfgKey = Object.keys(files).find((k) => /metadata2d\/.*process.*\.config$/i.test(k));
  const procCfg = procCfgKey ? (() => { try { return JSON.parse(strFromU8(files[procCfgKey])); } catch { return null; } })() : null;
  const energyOf = (pt: string): LaserParams => {
    const c = procCfg?.[pt];
    if (c && typeof c === 'object') {
      const power = typeof c.max_power === 'number' ? c.max_power : undefined;
      const speed = typeof c.speed === 'number' ? c.speed : undefined;
      const passes = typeof c.number_of_passes === 'number' ? c.number_of_passes : 1;
      const energy = power != null && speed ? (power / speed) * passes : undefined;
      return { processType: pt, power, speed, passes, energy };
    }
    return { processType: pt };
  };

  // Index every object by id (across all canvases).
  const byId: Record<string, any> = {};
  const canvases: any[] = Array.isArray(model.canvas_list) ? model.canvas_list : [];
  for (const cv of canvases) {
    for (const o of cv.obj_list || []) byId[o.obj_id] = o;
  }

  const plates: Plate[] = [];

  // Preferred path: project_settings.json carries the real plate layout
  // (each plate's components hold the true mm transforms).
  const ps = readJson(/project_settings\.json$/i);
  const platesSpec: any[] = ps?.canvas_settings?.[0]?.making_batch_list?.[0]?.making_plate_list;

  // Per-object fabrication operation. object_settings maps obj_id ->
  // process_type ("LaserLineCut" through cut, "LaserLineEngrave" = surface
  // engrave/score, plus Deboss/Score/Pen variants which are also non-through).
  // We resolve each to its laser params (with energy density) once, cached.
  const laserMap: Record<string, LaserParams> = {};
  const energyCache: Record<string, LaserParams> = {};
  const objSettings: any[] = ps?.canvas_settings?.[0]?.object_settings;
  const isCut = (t: string) => /cut/i.test(t) && !/engrav|deboss|score|pen|draw/i.test(t);
  if (Array.isArray(objSettings)) {
    for (const s of objSettings) {
      const t = String(s.process_type || 'LaserLineCut');
      if (!energyCache[t]) energyCache[t] = energyOf(t);
      laserMap[s.obj_id] = energyCache[t];
      const e = energyCache[t].energy;
      if (e != null) {
        if (isCut(t)) meta.cutEnergy = Math.max(meta.cutEnergy ?? 0, e);
        else meta.engraveEnergy = meta.engraveEnergy == null ? e : Math.max(meta.engraveEnergy, e);
      }
    }
  }

  if (Array.isArray(platesSpec) && platesSpec.length) {
    meta.source = 'project_settings';
    platesSpec.forEach((pl, i) => {
      const pieces: Piece[] = [];
      const bbox = emptyBbox();
      for (const comp of pl.components || []) {
        collectComponent(comp.obj_id, parseTransform(comp.transform), byId, laserMap, pieces, bbox);
      }
      finalizeBbox(bbox);
      if (pieces.length) {
        localizePlate(pieces, bbox);
        plates.push({ index: i + 1, name: pl.name || '', pieces, bbox });
      }
    });
  }

  // Fallback: no usable project_settings → treat every PathObject as one plate
  // (identity placement). Geometry won't be physically positioned but is still
  // viewable/exportable.
  if (!plates.length) {
    meta.source = 'flat';
    const pieces: Piece[] = [];
    const bbox = emptyBbox();
    for (const cv of canvases) {
      for (const o of cv.obj_list || []) {
        if (o.type === 'PathObject') collectComponent(o.obj_id, IDENTITY, byId, laserMap, pieces, bbox);
      }
    }
    finalizeBbox(bbox);
    if (pieces.length) {
      localizePlate(pieces, bbox);
      plates.push({ index: 1, name: '', pieces, bbox });
    }
  }

  if (!plates.length) warnings.push('没有解析到任何闭合路径几何');

  // Tally distinct processes from the resolved pieces (counts match geometry).
  const usageByType = new Map<string, ProcessUsage>();
  for (const pl of plates) {
    for (const pc of pl.pieces) {
      const key = pc.laser.processType || 'unknown';
      const u = usageByType.get(key);
      if (u) u.count++;
      else usageByType.set(key, { params: pc.laser, process: pc.process, count: 1 });
    }
  }
  const processes = Array.from(usageByType.values()).sort(
    (a, b) => (b.params.energy ?? 0) - (a.params.energy ?? 0)
  );

  // Overall bbox = max plate extents (each plate is in its own local space).
  const overall: Bbox = { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  for (const p of plates) {
    if (p.bbox.width > overall.maxX) overall.maxX = p.bbox.width;
    if (p.bbox.height > overall.maxY) overall.maxY = p.bbox.height;
  }
  overall.width = overall.maxX;
  overall.height = overall.maxY;

  return { plates, bbox: overall, meta, processes, warnings };
}
