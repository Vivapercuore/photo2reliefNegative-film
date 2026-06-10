import { LacModel } from './parseLac';

/** Longest edge (cells) of the relief sampling grid built from a raster image.
 *  320² ≈ 0.4M triangles for the slab — detailed enough for an engraved photo,
 *  light enough to rebuild interactively. */
const MAX_GRID = 320;

/**
 * Decode every raster engrave image in a parsed model (browser-only step —
 * parseLac itself stays synchronous): an ImageBitmap for the 2D path preview,
 * plus a downsampled darkness grid (0..1 = darkness × alpha) that drives the
 * engraved-relief mesh. Mutates the RasterPieces in place; returns
 * human-readable warnings for images that failed to decode.
 */
export async function decodeLacImages(model: LacModel): Promise<string[]> {
  const warnings: string[] = [];
  const jobs: Promise<void>[] = [];
  for (const plate of model.plates) {
    for (const img of plate.images) {
      if (img.gray) continue; // already decoded
      jobs.push(
        (async () => {
          const bitmap = await createImageBitmap(new Blob([img.pngBytes], { type: 'image/png' }));
          img.bitmap = bitmap;
          const k = Math.min(1, MAX_GRID / Math.max(bitmap.width, bitmap.height));
          const cols = Math.max(2, Math.round(bitmap.width * k));
          const rows = Math.max(2, Math.round(bitmap.height * k));
          const cv = document.createElement('canvas');
          cv.width = cols;
          cv.height = rows;
          const ctx = cv.getContext('2d', { willReadFrequently: true });
          if (!ctx) throw new Error('无法创建 2D canvas');
          ctx.drawImage(bitmap, 0, 0, cols, rows);
          const data = ctx.getImageData(0, 0, cols, rows).data;
          const gray = new Float32Array(cols * rows);
          for (let i = 0; i < cols * rows; i++) {
            const r = data[i * 4];
            const g = data[i * 4 + 1];
            const b = data[i * 4 + 2];
            const a = data[i * 4 + 3] / 255;
            const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            // dark & opaque pixels get the most laser energy ⇒ engraved deepest;
            // transparent pixels are untouched material
            gray[i] = (1 - luma) * a;
          }
          img.gray = { data: gray, cols, rows };
        })().catch((e: any) => {
          warnings.push(`位图「${img.name || img.objId}」解码失败：${e?.message || e}`);
        })
      );
    }
  }
  await Promise.all(jobs);
  return warnings;
}
