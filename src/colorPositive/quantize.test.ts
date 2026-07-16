import { extractPalette, quantizeToLabels, hexToRgb, rgbToHex, luminance } from './quantize';

interface RgbaPixel {
  c: [number, number, number, number?];
  count: number;
}

/** 生成 RGBA 缓冲：把若干 [r,g,b,a?] 各重复 count 次 */
function rgba(pixels: RgbaPixel[]): Uint8ClampedArray {
  const total = pixels.reduce((s, p) => s + p.count, 0);
  const out = new Uint8ClampedArray(total * 4);
  let o = 0;
  for (const p of pixels) {
    for (let i = 0; i < p.count; i++) {
      out[o++] = p.c[0];
      out[o++] = p.c[1];
      out[o++] = p.c[2];
      out[o++] = p.c[3] ?? 255;
    }
  }
  return out;
}

describe('hex/rgb 转换', () => {
  it('往返一致', () => {
    expect(hexToRgb('#3FD8F0')).toEqual([63, 216, 240]);
    expect(rgbToHex(63, 216, 240)).toBe('#3FD8F0');
  });
});

describe('extractPalette', () => {
  it('两个纯色的图提取出两色，按亮度暗→亮排序', () => {
    const data = rgba([
      { c: [200, 30, 30], count: 500 },
      { c: [240, 240, 240], count: 500 },
    ]);
    const pal = extractPalette(data, 2);
    expect(pal).toHaveLength(2);
    const [dark, light] = pal.map(hexToRgb);
    expect(luminance(dark[0], dark[1], dark[2])).toBeLessThan(luminance(light[0], light[1], light[2]));
    expect(dark).toEqual([200, 30, 30]);
    expect(light).toEqual([240, 240, 240]);
  });

  it('确定性：同一输入两次结果一致', () => {
    const data = rgba([
      { c: [10, 20, 30], count: 300 },
      { c: [100, 150, 60], count: 300 },
      { c: [220, 210, 190], count: 400 },
    ]);
    expect(extractPalette(data, 3)).toEqual(extractPalette(data, 3));
  });

  it('唯一色少于 n 时补齐到恰好 n 个', () => {
    const data = rgba([{ c: [50, 50, 50], count: 100 }]);
    expect(extractPalette(data, 4)).toHaveLength(4);
  });

  it('四个等面积纯色提取出恰好这四色（不并色、不拆近似白）', () => {
    const data = rgba([
      { c: [26, 34, 56], count: 250 },    // 海军蓝 #1A2238
      { c: [192, 57, 43], count: 250 },   // 红 #C0392B
      { c: [230, 126, 34], count: 250 },  // 橙 #E67E22
      { c: [245, 240, 232], count: 250 }, // 米白 #F5F0E8
    ]);
    expect(extractPalette(data, 4)).toEqual(['#1A2238', '#C0392B', '#E67E22', '#F5F0E8']);
  });

  it('少量反走样边缘混色像素不应诱使按跨度选盒把海军蓝和红并成一色', () => {
    // 复现真实图片场景：四块纯色之间有极少量边界反走样像素（颜色介于
    // 白和深色之间），这些离群像素会把"米白"盒子的通道跨度撑得很大，
    // 但因为数量少，它对误差平方和(SSE)贡献很小——真正该切分的是像素
    // 数量对半、颜色差异巨大的海军蓝+红盒子。按跨度选盒的旧实现会被
    // 这几个离群像素误导，反复去切米白盒子，导致海军蓝和红始终并在一起。
    const data = rgba([
      { c: [26, 34, 56], count: 250 },    // 海军蓝
      { c: [192, 57, 43], count: 250 },   // 红
      { c: [230, 126, 34], count: 248 },  // 橙
      { c: [245, 240, 232], count: 248 }, // 米白
      { c: [70, 65, 80], count: 2 },      // 海军蓝<->米白 边缘混色（离群，跨度大）
      { c: [110, 90, 90], count: 2 },     // 红<->米白 边缘混色（离群，跨度大）
    ]);
    const pal = extractPalette(data, 4);
    expect(pal).toHaveLength(4);
    expect(new Set(pal).size).toBe(4); // 四色互不相同：海军蓝和红没有被并色
    expect(pal).toEqual(['#1A2238', '#BE392C', '#E67D22', '#F5EFE6']);
  });
});

describe('quantizeToLabels', () => {
  it('像素分到最近的调色板色，counts 正确', () => {
    const data = rgba([
      { c: [10, 10, 10], count: 3 },
      { c: [250, 250, 250], count: 7 },
    ]);
    const { labels, counts } = quantizeToLabels(data, ['#000000', '#FFFFFF']);
    expect(Array.from(labels.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(labels.slice(3))).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(counts).toEqual([3, 7]);
  });

  it('透明像素按白底合成', () => {
    const data = rgba([{ c: [0, 0, 0, 0], count: 1 }]); // 全透明 → 白
    const { labels } = quantizeToLabels(data, ['#000000', '#FFFFFF']);
    expect(labels[0]).toBe(1);
  });
});
