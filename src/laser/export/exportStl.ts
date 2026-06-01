import * as THREE from 'three';
import { zipSync, Zippable } from 'fflate';

/**
 * Build a binary STL (ArrayBuffer) from a set of world-space geometries.
 * Geometries are expected to already carry their final coordinates.
 */
export function exportBinarySTL(geometries: THREE.BufferGeometry[]): ArrayBuffer {
  const prepared = geometries.map((g) => (g.index ? g.toNonIndexed() : g));

  let triangleCount = 0;
  for (const g of prepared) {
    const pos = g.getAttribute('position');
    if (pos) triangleCount += pos.count / 3;
  }

  const buffer = new ArrayBuffer(84 + triangleCount * 50);
  const dv = new DataView(buffer);
  // 80-byte header is left as zeros.
  dv.setUint32(80, triangleCount, true);

  let offset = 84;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  const writeVec = (v: THREE.Vector3) => {
    dv.setFloat32(offset, v.x, true);
    dv.setFloat32(offset + 4, v.y, true);
    dv.setFloat32(offset + 8, v.z, true);
    offset += 12;
  };

  for (const g of prepared) {
    const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i);
      b.fromBufferAttribute(pos, i + 1);
      c.fromBufferAttribute(pos, i + 2);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      normal.crossVectors(ab, ac).normalize();
      writeVec(normal);
      writeVec(a);
      writeVec(b);
      writeVec(c);
      dv.setUint16(offset, 0, true);
      offset += 2;
    }
  }

  return buffer;
}

/** Sanitize a string for safe use as a file name. */
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim() || 'file';
}

/** One named STL file (raw bytes) to be packed into a zip. */
export interface StlEntry {
  name: string;
  data: ArrayBuffer;
}

/** Pack several STL files into a single zip (stored, no compression). */
export function zipStlFiles(entries: StlEntry[]): Uint8Array {
  const files: Zippable = {};
  for (const e of entries) {
    files[`${safeName(e.name)}.stl`] = [new Uint8Array(e.data), { level: 0 }];
  }
  return zipSync(files);
}
