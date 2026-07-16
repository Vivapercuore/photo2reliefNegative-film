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
