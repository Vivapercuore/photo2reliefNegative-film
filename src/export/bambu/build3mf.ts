import * as THREE from 'three';
import { zipSync, strToU8, Zippable } from 'fflate';
import {
  CONTENT_TYPES,
  ROOT_RELS,
  SLICE_INFO,
  BambuProjectMeta,
  today,
} from './templates';

/**
 * Generate a Bambu Studio `.3mf` (OPC ZIP) from Three.js geometries, carrying
 * 项目信息 (metadata) and 工艺参数 (the per-feature `project_settings.config`).
 *
 * Geometry convention: input geometries are Three.js **Y-up** (height on +Y,
 * laid on the XZ plane, base at y=0) exactly as relief/laser produce them.
 * They are rotated into 3MF's **Z-up, millimetre** frame here, then placed on
 * the plate via each build item's translation.
 */

/** Known template folders under public/bambu/ (any string path is accepted). */
export type BambuTemplate =
  | 'relief/precision'
  | 'relief/default'
  | 'relief/speed'
  | 'laser'
  | (string & {});

/** One model that becomes a top-level <object> on the plate. */
export interface Object3mf {
  /** Human-readable part/object name (shown in the slicer tree). */
  name: string;
  /**
   * World-space geometry, Three.js Y-up. May be an array (e.g. all parts on a
   * laser plate); each entry is welded as an independent solid (never fused
   * across solids) so touching parts stay manifold.
   */
  geometry: THREE.BufferGeometry | THREE.BufferGeometry[];
  /**
   * 1-based print plate this object should sit on. Objects sharing a plate are
   * auto-arranged together on one bed; different plates each get their own bed
   * (bed-local coordinates, so plates may overlap in space). Default: plate 1.
   */
  plate?: number;
}

export interface Pack3mfOptions {
  /** Plate (bed) size in mm for centring/auto-arrange. Default 256 (Bambu A1/X1). */
  bedSize?: { x: number; y: number };
  /** Gap between objects when auto-arranging multiple (mm). Default 5. */
  gap?: number;
  /**
   * Shallow-merge these keys into the template's `project_settings.config`
   * before embedding (values are strings, as Bambu stores them). Use for
   * custom mode to force `layer_height`/`initial_layer_print_height` to match
   * the geometry's layer thickness.
   */
  projectSettingsOverrides?: Record<string, string>;
  /**
   * Path prefix where `public/bambu/` is served. Empty (default) means the app
   * is served at the origin root (docker / dev / current mirrors). Set this to
   * the sub-path (e.g. `/photo2stl`) only if you deploy under one, e.g. on
   * GitHub Pages.
   */
  publicBase?: string;
  /**
   * Patch the template's `metadata.xml` (项目信息) before injecting: set a
   * field to a new value, or `null` to remove it. Missing fields are appended.
   * Used by custom mode to neutralise the profile-level identity while keeping
   * the model-level one.
   */
  metadataOverrides?: Record<string, string | null>;
  /**
   * Register these keys into `different_settings_to_system[0]` so Bambu shows
   * them as "modified vs system preset" — pair with `projectSettingsOverrides`.
   */
  markModified?: string[];
}

const DEFAULT_BED = { x: 256, y: 256 };

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Round to 1e-4 mm and strip trailing zeros — shrinks file and welds verts. */
function fmt(n: number): string {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? '0' : String(r);
}

interface MeshXml {
  /** `<mesh>…</mesh>` body. */
  xml: string;
  triangleCount: number;
  /** Axis-aligned bounds in 3MF (Z-up) coordinates, mm. */
  bbox: { min: THREE.Vector3; max: THREE.Vector3 };
}

/**
 * Convert one or more Three.js (Y-up) geometries to a single 3MF mesh in Z-up.
 * Mapping (x,y,z)→(x,−z,y) is a +90° rotation about X (det=+1), so triangle
 * winding — and outward normals — is preserved.
 *
 * Welding is done **per input geometry**: vertices are only merged within the
 * same solid, never across solids. Merging across solids (e.g. all parts of a
 * laser plate, or the two layers of an engraved groove) fused coincident/
 * touching vertices of independent bodies into shared edges, which slicers
 * report as non-manifold edges. Keeping each body's vertex set disjoint yields
 * a clean "multiple separate solids in one object" mesh.
 */
function geometryToMesh(input: THREE.BufferGeometry | THREE.BufferGeometry[]): MeshXml {
  const geoms = Array.isArray(input) ? input : [input];

  const vLines: string[] = [];
  const tLines: string[] = [];
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

  let triangleCount = 0;
  for (const geom of geoms) {
    const g = geom.index ? geom.toNonIndexed() : geom;
    const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) continue;

    // Per-geometry weld map: keys map to global vertex ids in vLines, but the
    // map is reset for each solid so distinct bodies never share a vertex.
    const index = new Map<string, number>();
    const vertexId = (X: string, Y: string, Z: string): number => {
      const key = `${X},${Y},${Z}`;
      let id = index.get(key);
      if (id === undefined) {
        id = vLines.length;
        vLines.push(`    <vertex x="${X}" y="${Y}" z="${Z}"/>`);
        index.set(key, id);
        const x = +X, y = +Y, z = +Z;
        if (x < min.x) min.x = x; if (x > max.x) max.x = x;
        if (y < min.y) min.y = y; if (y > max.y) max.y = y;
        if (z < min.z) min.z = z; if (z > max.z) max.z = z;
      }
      return id;
    };

    for (let i = 0; i < pos.count; i += 3) {
      const ids: number[] = [];
      for (let k = 0; k < 3; k++) {
        const j = i + k;
        // Three Y-up → 3MF Z-up: x'=x, y'=-z, z'=y
        ids.push(vertexId(fmt(pos.getX(j)), fmt(-pos.getZ(j)), fmt(pos.getY(j))));
      }
      // Skip degenerate triangles produced by welding coincident verts.
      if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue;
      tLines.push(`    <triangle v1="${ids[0]}" v2="${ids[1]}" v3="${ids[2]}"/>`);
      triangleCount++;
    }
  }
  if (!triangleCount) throw new Error('几何为空，无法导出');

  const xml =
    `   <mesh>\n` +
    `    <vertices>\n${vLines.join('\n')}\n    </vertices>\n` +
    `    <triangles>\n${tLines.join('\n')}\n    </triangles>\n` +
    `   </mesh>`;

  return { xml, triangleCount, bbox: { min, max } };
}

interface PreparedObject {
  name: string;
  mesh: MeshXml;
  /** 1-based print plate this object sits on. */
  plate: number;
  /** Plate translation (mm) applied via the build item transform. */
  tx: number;
  ty: number;
  tz: number;
}

type MeshedObject = { name: string; mesh: MeshXml; plate: number };

/**
 * Place one plate's objects on its bed cell, **preserving their relative
 * layout**. `(cellX, cellY)` is the world-space origin of this plate's bed so
 * that distinct plates occupy distinct, non-overlapping regions.
 *
 * The input geometries already carry the faithful .lac arrangement (each part
 * sits at its real position on the sheet), so we must NOT re-pack them — doing
 * so scrambles the layout and, when a sheet is larger than the bed, wraps parts
 * into a tall overlapping column. Instead we translate the whole plate rigidly
 * so its combined footprint is centred on its bed cell; every part keeps its
 * original position and the parts stay non-overlapping exactly as designed.
 */
function layoutPlate(
  objects: MeshedObject[],
  bed: { x: number; y: number },
  cellX: number,
  cellY: number
): PreparedObject[] {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  for (const o of objects) {
    const { min, max } = o.mesh.bbox;
    if (min.x < minX) minX = min.x;
    if (min.y < minY) minY = min.y;
    if (min.z < minZ) minZ = min.z;
    if (max.x > maxX) maxX = max.x;
    if (max.y > maxY) maxY = max.y;
  }
  // Single shared translation centres the plate's combined bbox on its bed cell
  // and drops it onto the bed surface; relative positions are untouched.
  const tx = cellX + bed.x / 2 - (minX + maxX) / 2;
  const ty = cellY + bed.y / 2 - (minY + maxY) / 2;
  const tz = -minZ;
  return objects.map((o) => ({ name: o.name, mesh: o.mesh, plate: o.plate, tx, ty, tz }));
}

/**
 * Auto-arrange objects per print plate. Objects are grouped by their `plate`
 * id; each plate is placed on its own bed cell, and the cells are tiled in a
 * grid in world space so plates never physically overlap (BambuStudio still
 * shows them as separate beds via `model_settings.config`). Relative part
 * positions within a plate are preserved. Returns objects ordered by plate.
 */
function layout(objects: MeshedObject[], bed: { x: number; y: number }, _gap: number): PreparedObject[] {
  const byPlate = new Map<number, MeshedObject[]>();
  for (const o of objects) {
    const list = byPlate.get(o.plate);
    if (list) list.push(o);
    else byPlate.set(o.plate, [o]);
  }
  const out: PreparedObject[] = [];
  const plateIds = Array.from(byPlate.keys()).sort((a, b) => a - b);
  // Grid of bed cells (near-square), one per plate, spaced by the bed size plus
  // a margin so adjacent beds keep clear of each other.
  const margin = 60;
  const strideX = bed.x + margin;
  const strideY = bed.y + margin;
  const cols = Math.max(1, Math.ceil(Math.sqrt(plateIds.length)));
  plateIds.forEach((plate, i) => {
    const cellX = (i % cols) * strideX;
    const cellY = Math.floor(i / cols) * strideY;
    out.push(...layoutPlate(byPlate.get(plate)!, bed, cellX, cellY));
  });
  return out;
}

function buildMetadataBlock(meta: BambuProjectMeta): string {
  const date = today();
  const pairs: [string, string][] = [
    ['Application', meta.application || 'photo2relief'],
    ['BambuStudio:3mfVersion', '1'],
    ['CreationDate', date],
    ['ModificationDate', date],
    ['Title', meta.title],
    ['Designer', meta.designer || ''],
    ['Description', meta.description || ''],
    ['License', meta.license || ''],
    ...Object.entries(meta.extra || {}),
  ];
  return pairs
    .map(([k, v]) => ` <metadata name="${escapeXml(k)}">${escapeXml(v)}</metadata>`)
    .join('\n');
}

/**
 * Replace / remove / append `<metadata name=...>` lines in an existing block.
 * Each metadata element sits on its own line (as our templates store them),
 * so we can edit line-by-line without disturbing the verbatim Description.
 */
function applyMetadataOverrides(
  block: string,
  overrides: Record<string, string | null>
): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of block.split('\n')) {
    const m = line.match(/<metadata name="([^"]+)">/);
    const name = m && m[1];
    if (name && name in overrides) {
      seen.add(name);
      const v = overrides[name];
      if (v !== null) out.push(` <metadata name="${name}">${escapeXml(v)}</metadata>`);
      // v === null → drop the field
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== null && !seen.has(k)) {
      out.push(` <metadata name="${k}">${escapeXml(v)}</metadata>`);
    }
  }
  return out.join('\n');
}

function buildModelXml(prepared: PreparedObject[], metaBlock: string): string {
  const objects = prepared
    .map(
      (p, i) =>
        `  <object id="${i + 1}" type="model">\n${p.mesh.xml}\n  </object>`
    )
    .join('\n');
  const items = prepared
    .map(
      (p, i) =>
        `  <item objectid="${i + 1}" transform="1 0 0 0 1 0 0 0 1 ${fmt(p.tx)} ${fmt(
          p.ty
        )} ${fmt(p.tz)}" printable="1"/>`
    )
    .join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" ` +
    `xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ` +
    `xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">\n` +
    `${metaBlock}\n` +
    ` <resources>\n${objects}\n </resources>\n` +
    ` <build>\n${items}\n </build>\n` +
    `</model>`
  );
}

/** model_settings.config: name each object, bind it to its plate, single extruder. */
function buildModelSettingsXml(prepared: PreparedObject[]): string {
  const objs = prepared
    .map(
      (p, i) =>
        `  <object id="${i + 1}">\n` +
        `    <metadata key="name" value="${escapeXml(p.name)}"/>\n` +
        `    <metadata key="extruder" value="1"/>\n` +
        `    <part id="1" subtype="normal_part">\n` +
        `      <metadata key="name" value="${escapeXml(p.name)}"/>\n` +
        `      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n` +
        `      <metadata key="extruder" value="1"/>\n` +
        `      <mesh_stat face_count="${p.mesh.triangleCount}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n` +
        `    </part>\n` +
        `  </object>`
    )
    .join('\n');

  // One <plate> per distinct plate id, listing only the instances on it.
  const plateIds = Array.from(new Set(prepared.map((p) => p.plate))).sort((a, b) => a - b);
  const plates = plateIds
    .map((plateId, pIdx) => {
      const instances = prepared
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => p.plate === plateId)
        .map(
          ({ i }) =>
            `    <model_instance>\n` +
            `      <metadata key="object_id" value="${i + 1}"/>\n` +
            `      <metadata key="instance_id" value="${i}"/>\n` +
            `    </model_instance>`
        )
        .join('\n');
      return (
        `  <plate>\n` +
        `    <metadata key="plater_id" value="${pIdx + 1}"/>\n` +
        `    <metadata key="plater_name" value="plate-${pIdx + 1}"/>\n` +
        `    <metadata key="locked" value="false"/>\n` +
        `    <metadata key="filament_map_mode" value="Auto For Flush"/>\n` +
        `    <metadata key="filament_maps" value="1"/>\n` +
        `${instances}\n` +
        `  </plate>`
      );
    })
    .join('\n');

  const assembles = prepared
    .map(
      (_p, i) =>
        `   <assemble_item object_id="${i + 1}" instance_id="${i}" transform="1 0 0 0 1 0 0 0 1 0 0 0" offset="0 0 0" />`
    )
    .join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<config>\n${objs}\n` +
    `${plates}\n` +
    `  <assemble>\n${assembles}\n  </assemble>\n` +
    `</config>`
  );
}

async function fetchText(url: string, required: boolean): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    if (required) throw new Error(`无法加载模板 ${url}：${(e as Error).message}`);
    return null;
  }
  if (!res.ok) {
    if (required) throw new Error(`无法加载模板 ${url}（HTTP ${res.status}）`);
    return null;
  }
  const text = await res.text();
  // Static / SPA hosts (e.g. create-react-app) serve index.html with HTTP 200
  // for paths that don't exist. If we asked for a config/metadata file and got
  // the app's HTML page back, treat it as missing rather than injecting the
  // page's markup into the 3MF (which corrupts the XML → "no geometry").
  const head = text.slice(0, 256).trim().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
    if (required) throw new Error(`模板 ${url} 不存在（服务器返回了应用首页 HTML）`);
    return null;
  }
  return text;
}

/**
 * Build a Bambu `.3mf` from a template under `public/bambu/<template>/`.
 *
 * @param template e.g. `'relief/default'`, `'relief/precision'`, `'laser'`.
 *   The folder must contain `project_settings.config` (工艺参数). It may also
 *   contain `metadata.xml` (项目信息 — injected verbatim, e.g. your MakerWorld
 *   DesignModelId/Title/Description) and `filament_settings_1.config`; both are
 *   optional. Swap any of these files to ship your own profile.
 * @param meta Fallback 项目信息 used only when the template has no metadata.xml.
 */
export async function pack3mf(
  template: BambuTemplate,
  objects: Object3mf[],
  meta: BambuProjectMeta = { title: 'model' },
  options: Pack3mfOptions = {}
): Promise<Uint8Array> {
  if (!objects.length) throw new Error('没有可导出的几何');
  const bed = options.bedSize || DEFAULT_BED;
  const gap = options.gap ?? 5;
  const dir = `${options.publicBase || ''}/bambu/${template}`;

  const meshed = objects.map((o) => ({
    name: o.name,
    mesh: geometryToMesh(o.geometry),
    plate: o.plate ?? 1,
  }));
  const prepared = layout(meshed, bed, gap);

  const [projectSettings, metadataXml, filamentSettings] = await Promise.all([
    fetchText(`${dir}/project_settings.config`, true),
    fetchText(`${dir}/metadata.xml`, false),
    fetchText(`${dir}/filament_settings_1.config`, false),
  ]);

  let metaBlock = metadataXml || buildMetadataBlock(meta);
  if (options.metadataOverrides) {
    metaBlock = applyMetadataOverrides(metaBlock, options.metadataOverrides);
  }

  let projectSettingsText = projectSettings as string;
  if (options.projectSettingsOverrides || options.markModified) {
    const obj = JSON.parse(projectSettingsText);
    if (options.projectSettingsOverrides) {
      Object.assign(obj, options.projectSettingsOverrides);
    }
    if (options.markModified && Array.isArray(obj.different_settings_to_system)) {
      const cur = String(obj.different_settings_to_system[0] || '')
        .split(';')
        .filter(Boolean);
      for (const k of options.markModified) if (!cur.includes(k)) cur.push(k);
      obj.different_settings_to_system[0] = cur.join(';');
    }
    projectSettingsText = JSON.stringify(obj, null, 4);
  }

  const files: Zippable = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(ROOT_RELS),
    '3D/3dmodel.model': strToU8(buildModelXml(prepared, metaBlock)),
    'Metadata/project_settings.config': strToU8(projectSettingsText),
    'Metadata/model_settings.config': strToU8(buildModelSettingsXml(prepared)),
    'Metadata/slice_info.config': strToU8(SLICE_INFO),
  };
  if (filamentSettings) {
    files['Metadata/filament_settings_1.config'] = strToU8(filamentSettings);
  }
  return zipSync(files);
}
