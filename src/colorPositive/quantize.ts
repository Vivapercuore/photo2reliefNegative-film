/**
 * 多色正片的量化核心（DOM-free，可在 Worker / jest 运行）：
 *  - extractPalette: median-cut 自动提取 n 个主色（确定性，无随机）
 *  - quantizeToLabels: 逐像素最近色（sRGB 欧氏距离，确定性，无抖动）
 * 透明像素一律先合成到白底（成品是不透明的矩形版画）。
 */

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const v = parseInt(full, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const to2 = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/** Rec.709 亮度（0..255），用于「暗→亮」默认排序。 */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** RGBA 像素合成到白底后的 [r, g, b]。 */
function overWhite(data: Uint8ClampedArray, o: number): [number, number, number] {
  const a = data[o + 3] / 255;
  return [
    Math.round(data[o] * a + 255 * (1 - a)),
    Math.round(data[o + 1] * a + 255 * (1 - a)),
    Math.round(data[o + 2] * a + 255 * (1 - a)),
  ];
}

/**
 * median-cut 提取 n 色，返回按亮度暗→亮排序的 hex 数组（长度恰为 n）。
 * 选盒准则是「误差平方和最大」（而非通道跨度最大）：跨度对个别离群像素
 * （如反走样边缘的混色像素）很敏感，会让本该合并的大块纯色盒子（如两个
 * 等面积但颜色不同的区域）迟迟排不上切分；误差平方和按像素数加权，能正
 * 确识别出「真正该切」的盒子。切分轴仍取盒子自身最宽的通道，切点仍是中位数。
 * 确定性：无随机初始化；并列时按固定顺序取第一个。图片唯一色少于 n 时
 * 重复末尾颜色补齐（重复色不会分到像素——quantizeToLabels 用严格小于）。
 */
export function extractPalette(data: Uint8ClampedArray, n: number): string[] {
  const pixelCount = data.length / 4;
  // 采样步长：最多处理 ~65536 个像素，提色精度足够且耗时可控
  const stride = Math.max(1, Math.floor(pixelCount / 65536));
  const px: number[] = [];
  for (let i = 0; i < pixelCount; i += stride) {
    const [r, g, b] = overWhite(data, i * 4);
    px.push(r, g, b);
  }
  const count = px.length / 3;
  const all = new Array<number>(count);
  for (let i = 0; i < count; i++) all[i] = i;

  interface Box {
    idx: number[];
  }
  const boxes: Box[] = [{ idx: all }];

  /** 一个盒子的统计量：最宽通道(切分轴)、跨度、以及到均值的误差平方和(选盒准则) */
  const boxStats = (box: Box): { chan: number; span: number; sse: number } => {
    const mins = [255, 255, 255];
    const maxs = [0, 0, 0];
    let mr = 0;
    let mg = 0;
    let mb = 0;
    for (const i of box.idx) {
      mr += px[i * 3];
      mg += px[i * 3 + 1];
      mb += px[i * 3 + 2];
      for (let c = 0; c < 3; c++) {
        const v = px[i * 3 + c];
        if (v < mins[c]) mins[c] = v;
        if (v > maxs[c]) maxs[c] = v;
      }
    }
    const k = box.idx.length || 1;
    mr /= k;
    mg /= k;
    mb /= k;
    let sse = 0;
    for (const i of box.idx) {
      const dr = px[i * 3] - mr;
      const dg = px[i * 3 + 1] - mg;
      const db = px[i * 3 + 2] - mb;
      sse += dr * dr + dg * dg + db * db;
    }
    let chan = 0;
    let span = -1;
    for (let c = 0; c < 3; c++) {
      const s = maxs[c] - mins[c];
      if (s > span) {
        span = s;
        chan = c;
      }
    }
    return { chan, span, sse };
  };

  while (boxes.length < n) {
    // 选误差平方和最大的盒子，沿其最宽通道在中位数处切分（确定性：取第一个最大者）
    let bi = -1;
    let bSse = 0;
    let bChan = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].idx.length < 2) continue;
      const { chan, span, sse } = boxStats(boxes[i]);
      if (span === 0) continue; // 颜色完全相同的盒子不可再分
      if (sse > bSse) {
        bSse = sse;
        bi = i;
        bChan = chan;
      }
    }
    if (bi < 0) break; // 所有盒子都不可再分（跨度为 0 或只剩单像素）
    const box = boxes[bi];
    box.idx.sort((a, b) => px[a * 3 + bChan] - px[b * 3 + bChan] || a - b);
    const mid = box.idx.length >> 1;
    boxes.splice(bi, 1, { idx: box.idx.slice(0, mid) }, { idx: box.idx.slice(mid) });
  }

  const colors = boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const i of box.idx) {
      r += px[i * 3];
      g += px[i * 3 + 1];
      b += px[i * 3 + 2];
    }
    const k = box.idx.length || 1;
    return [Math.round(r / k), Math.round(g / k), Math.round(b / k)];
  });
  while (colors.length < n) colors.push(colors[colors.length - 1]);
  colors.sort(
    (a, b) =>
      luminance(a[0], a[1], a[2]) - luminance(b[0], b[1], b[2]) ||
      a[0] - b[0] ||
      a[1] - b[1] ||
      a[2] - b[2]
  );
  return colors.map((c) => rgbToHex(c[0], c[1], c[2]));
}

export interface QuantizeResult {
  /** 每像素的调色板下标（0..palette.length-1） */
  labels: Uint8Array;
  /** 每个调色板下标的像素数 */
  counts: number[];
}

/** 逐像素最近色（sRGB 欧氏距离平方；严格小于 → 并列取下标小者，确定性）。 */
export function quantizeToLabels(data: Uint8ClampedArray, palette: string[]): QuantizeResult {
  const pal = palette.map(hexToRgb);
  const pixelCount = data.length / 4;
  const labels = new Uint8Array(pixelCount);
  const counts = new Array<number>(pal.length).fill(0);
  for (let i = 0; i < pixelCount; i++) {
    const [r, g, b] = overWhite(data, i * 4);
    let best = 0;
    let bestD = Infinity;
    for (let p = 0; p < pal.length; p++) {
      const dr = r - pal[p][0];
      const dg = g - pal[p][1];
      const db = b - pal[p][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    labels[i] = best;
    counts[best]++;
  }
  return { labels, counts };
}
