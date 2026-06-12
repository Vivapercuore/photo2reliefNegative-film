/**
 * Render a preview image (data URL) centred on a size×size dark canvas → PNG
 * bytes, for use as 3MF thumbnails (`Metadata/plate_1.png` 512²,
 * `plate_1_small.png` 128²). The OPC thumbnail relationship makes Windows
 * Explorer show the preview; the bambulab cover relationships feed Bambu
 * Studio's project browser. See `Pack3mfOptions.thumbnails`.
 */
export async function makeThumbnail(srcUrl: string, size: number): Promise<Uint8Array> {
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error('缩略图加载失败'));
    img.src = srcUrl;
  });
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const cx = c.getContext('2d');
  if (!cx) throw new Error('canvas 2d 不可用');
  cx.fillStyle = '#1f1f23';
  cx.fillRect(0, 0, size, size);
  const margin = size * 0.06;
  const s = Math.min((size - 2 * margin) / img.width, (size - 2 * margin) / img.height);
  const w = img.width * s;
  const h = img.height * s;
  cx.imageSmoothingEnabled = false; // 像素点风格，不要插值糊掉
  cx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
  if (!blob) throw new Error('缩略图编码失败');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Both 3MF thumbnail sizes (middle 512², small 128²) from one preview URL. */
export async function makeThumbnails(
  srcUrl: string
): Promise<{ middle: Uint8Array; small: Uint8Array }> {
  const [middle, small] = await Promise.all([
    makeThumbnail(srcUrl, 512),
    makeThumbnail(srcUrl, 128),
  ]);
  return { middle, small };
}
