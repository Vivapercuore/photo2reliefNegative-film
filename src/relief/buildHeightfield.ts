import type { DeepMap } from '../dataProcess/type';

export interface HeightfieldResult {
  /** non-indexed triangle vertex positions (x,y,z per vertex, 3 verts/triangle) */
  positions: Float32Array;
  /** finished size in mm */
  size: { x: number; y: number; z: number };
  /** triangle count */
  triangles: number;
  /** grid dimensions actually used */
  cols: number;
  rows: number;
}

/**
 * Build a watertight, printable solid from a relief depth map.
 *
 * Conventions chosen to match the legacy OpenSCAD output exactly:
 *  - `DeepMap` cell value = depth in mm × 100  → height_mm = value / 100
 *    (legacy scad used `scale z = 0.01`).
 *  - XY pixel spacing = 1 / quality mm/pixel
 *    (legacy scad used `scale xy = 1/Quality`).
 *
 * Geometry: the depth map is the TOP surface (facing +Y, laid flat on the XZ
 * plane like the laser viewer). A flat base sits at y=0 and perimeter walls
 * close the solid so it is watertight and directly 3D-printable. The model is
 * centred on X/Z around the origin.
 */
export function buildHeightfield(deepMap: DeepMap, quality: number): HeightfieldResult {
  const rows = deepMap.length;
  const cols = rows > 0 ? deepMap[0].length : 0;
  if (rows < 2 || cols < 2) {
    return { positions: new Float32Array(0), size: { x: 0, y: 0, z: 0 }, triangles: 0, cols, rows };
  }

  const spacing = 1 / quality;
  const sizeX = (cols - 1) * spacing;
  const sizeZ = (rows - 1) * spacing;
  const cx = sizeX / 2;
  const cz = sizeZ / 2;

  const h = (r: number, c: number) => deepMap[r][c] / 100;
  const px = (c: number) => c * spacing - cx;
  const pz = (r: number) => r * spacing - cz;

  // triangle budget:
  //   top    = (cols-1)*(rows-1)*2
  //   bottom = (cols-1)*(rows-1)*2  (mirror grid keeps base flat & watertight)
  //   walls  = (2*(cols-1) + 2*(rows-1)) * 2
  const topTris = (cols - 1) * (rows - 1) * 2;
  const bottomTris = topTris;
  const wallTris = (2 * (cols - 1) + 2 * (rows - 1)) * 2;
  const triangles = topTris + bottomTris + wallTris;

  const positions = new Float32Array(triangles * 9);
  let o = 0;
  const v = (x: number, y: number, z: number) => {
    positions[o++] = x;
    positions[o++] = y;
    positions[o++] = z;
  };
  // CCW winding when viewed from outside; normals are recomputed downstream.
  const tri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cxx: number, cyy: number, czz: number
  ) => {
    v(ax, ay, az);
    v(bx, by, bz);
    v(cxx, cyy, czz);
  };

  let maxH = 0;

  // Top surface (height field), facing up (+Y).
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const x0 = px(c);
      const x1 = px(c + 1);
      const z0 = pz(r);
      const z1 = pz(r + 1);
      const h00 = h(r, c);
      const h01 = h(r, c + 1);
      const h10 = h(r + 1, c);
      const h11 = h(r + 1, c + 1);
      if (h00 > maxH) maxH = h00;
      // two triangles, top faces +Y → CCW seen from above (y up)
      tri(x0, h00, z0, x0, h10, z1, x1, h11, z1);
      tri(x0, h00, z0, x1, h11, z1, x1, h01, z0);
    }
  }

  // Bottom (flat at y=0), facing down (−Y).
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const x0 = px(c);
      const x1 = px(c + 1);
      const z0 = pz(r);
      const z1 = pz(r + 1);
      tri(x0, 0, z0, x1, 0, z1, x0, 0, z1);
      tri(x0, 0, z0, x1, 0, z0, x1, 0, z1);
    }
  }

  // Walls along the four edges (connect top edge heights down to y=0).
  // front edge (r = 0)
  for (let c = 0; c < cols - 1; c++) {
    const x0 = px(c);
    const x1 = px(c + 1);
    const z = pz(0);
    const ya = h(0, c);
    const yb = h(0, c + 1);
    tri(x0, 0, z, x1, 0, z, x1, yb, z);
    tri(x0, 0, z, x1, yb, z, x0, ya, z);
  }
  // back edge (r = rows-1)
  for (let c = 0; c < cols - 1; c++) {
    const x0 = px(c);
    const x1 = px(c + 1);
    const z = pz(rows - 1);
    const ya = h(rows - 1, c);
    const yb = h(rows - 1, c + 1);
    tri(x0, 0, z, x1, yb, z, x1, 0, z);
    tri(x0, 0, z, x0, ya, z, x1, yb, z);
  }
  // left edge (c = 0)
  for (let r = 0; r < rows - 1; r++) {
    const z0 = pz(r);
    const z1 = pz(r + 1);
    const x = px(0);
    const ya = h(r, 0);
    const yb = h(r + 1, 0);
    tri(x, 0, z0, x, yb, z1, x, 0, z1);
    tri(x, 0, z0, x, ya, z0, x, yb, z1);
  }
  // right edge (c = cols-1)
  for (let r = 0; r < rows - 1; r++) {
    const z0 = pz(r);
    const z1 = pz(r + 1);
    const x = px(cols - 1);
    const ya = h(r, cols - 1);
    const yb = h(r + 1, cols - 1);
    tri(x, 0, z0, x, 0, z1, x, yb, z1);
    tri(x, 0, z0, x, yb, z1, x, ya, z0);
  }

  return {
    positions,
    size: { x: sizeX, y: maxH, z: sizeZ },
    triangles,
    cols,
    rows,
  };
}
