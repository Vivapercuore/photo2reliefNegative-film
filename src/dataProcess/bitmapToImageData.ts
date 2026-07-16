/**
 * ImageBitmap → 按 MaxLength/Quality 缩放的 ImageData（OffscreenCanvas）。
 * 尺寸公式与旧版 getImageRGBList 一致：final = round(zoom*边*Quality) + 1，
 * zoom 把长边缩放到 MaxLength。relief 与 colorPositive 两个 worker 共用，
 * 保证两个模块的成品尺寸完全一致（含 0.2mm 尺寸修正）。
 */
export function bitmapToImageData(bitmap: ImageBitmap, maxLength: number, quality: number): ImageData {
  const w = bitmap.width;
  const h = bitmap.height;
  const zoom = w >= h ? maxLength / w : maxLength / h;
  const finalW = Math.max(2, Math.round(zoom * w * quality) + 1);
  const finalH = Math.max(2, Math.round(zoom * h * quality) + 1);
  const canvas = new OffscreenCanvas(finalW, finalH);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('无法创建 OffscreenCanvas 2D 上下文');
  ctx.drawImage(bitmap, 0, 0, w, h, 0, 0, finalW, finalH);
  return ctx.getImageData(0, 0, finalW, finalH);
}
