# 多色正片 ColorPositive 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增「多色正片」工作台页：图片量化为 n 个纯色 → 单体分层台阶 3D 模型（高度=颜色）→ 导出带分层换色（AMS 自动 / 暂停手动）的 3MF。

**Architecture:** 完全沿用 relief 模块的成熟形态——页面（参数 + 调度）→ 两级 Web Worker（量化级缓存标签图、几何级复用 `buildHeightfield`）→ 共享 `ModelViewer` 预览（按世界 y 高度着色的 ShaderMaterial，预览语义=打印语义）→ `bambu-3mf` 的 `pauses`/`filaments` 写换色。设计规格见 `docs/superpowers/specs/2026-07-16-color-positive-design.md`。

**Tech Stack:** CRA (react-scripts 5) + TypeScript 4.9 + Arco Design 2.66 + three 0.160（勿升级）+ bambu-3mf 0.1.0 + lodash-es debounce + jest (react-scripts test)。

## Global Constraints

- **禁止新增运行时依赖**：median-cut / 最近色全部手写纯 TS（不引入 kmeans-js/colorthief/jimp）。
- **量化必须确定性**：禁抖动、禁随机初始化（用户明确要求）。
- **UI 全中文**；遵守 `src/theme/DESIGN.md`（LUMEN）：深色工程面板、一切数字用 `.lx-data`(JetBrains Mono)、光谱渐变只准出现在既有 5 处（本模块不新增）、`prefers-reduced-motion`、分区用 `.lx-eyebrow` 眉标（中文+英文 code）。
- **本计划不新增 Arco 样式覆盖**；若实现中必须覆盖，类名先 `grep node_modules/@arco-design/web-react/dist/css/arco.css` 验证。
- 每个任务完成即 `git commit`；提交前该任务的测试与 `npx tsc --noEmit` 必须通过。
- Worker 大缓冲（positions/preview）必须走 Transferable 转移；所有计算在本地浏览器完成。
- 几何约定与 relief 一致：Y-up、DeepMap 单元 = mm×100、XY 间距 = 1/quality mm。
- 换色高度以「层数」定义，z 只由 `首层层高 + (层数−1)×层高` 推导，保留 2 位小数（`round2`）。

## 文件结构总览

```
src/dataProcess/bitmapToImageData.ts   （新，从 relief.worker.ts 提取的共享缩放函数）
src/colorPositive/
  quantize.ts          纯函数：median-cut 提色 + 最近色标签（Task 1）
  quantize.test.ts     （Task 1）
  bands.ts             纯函数：色带高度表 / PauseLayer / 导出选项（Task 2）
  bands.test.ts        （Task 2）
  worker/color.worker.ts  两级计算 Worker（Task 3）
  heightShader.ts      按高度分带着色材质（Task 4）
  PaletteBands.tsx     色带图例编辑器（Task 5）
  PaletteBands.css     （Task 5）
  ColorPositive.tsx    页面（Task 6）
  ColorPositive.css    （Task 6）
public/bambu/color/    切片模板 = relief/default 的副本（Task 6）
src/App.tsx            +1 路由（Task 6）
src/Home.tsx           +1 卡片（Task 6）
```

---

### Task 1: 量化核心 quantize.ts

**Files:**
- Create: `src/colorPositive/quantize.ts`
- Test: `src/colorPositive/quantize.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，DOM-free）
- Produces（后续任务依赖的精确签名）:
  - `hexToRgb(hex: string): [number, number, number]`
  - `rgbToHex(r: number, g: number, b: number): string`（大写 `#RRGGBB`）
  - `luminance(r: number, g: number, b: number): number`（Rec.709，0..255）
  - `extractPalette(data: Uint8ClampedArray, n: number): string[]`（RGBA 字节 → 恰好 n 个 hex，按亮度暗→亮）
  - `quantizeToLabels(data: Uint8ClampedArray, palette: string[]): QuantizeResult`，其中 `QuantizeResult = { labels: Uint8Array; counts: number[] }`

- [ ] **Step 1: 写失败测试**

`src/colorPositive/quantize.test.ts`：

```ts
import { extractPalette, quantizeToLabels, hexToRgb, rgbToHex, luminance } from './quantize';

/** 生成 RGBA 缓冲：把若干 [r,g,b,a?] 各重复 count 次 */
function rgba(pixels: Array<{ c: [number, number, number, number?]; count: number }>): Uint8ClampedArray {
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx react-scripts test --watchAll=false --testPathPattern=colorPositive`
Expected: FAIL —— `Cannot find module './quantize'`

- [ ] **Step 3: 实现 quantize.ts**

`src/colorPositive/quantize.ts`：

```ts
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

  /** 一个盒子的最宽通道及其跨度 */
  const widest = (box: Box): { chan: number; span: number } => {
    const mins = [255, 255, 255];
    const maxs = [0, 0, 0];
    for (const i of box.idx) {
      for (let c = 0; c < 3; c++) {
        const v = px[i * 3 + c];
        if (v < mins[c]) mins[c] = v;
        if (v > maxs[c]) maxs[c] = v;
      }
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
    return { chan, span };
  };

  while (boxes.length < n) {
    // 选跨度最大的盒子沿其最宽通道在中位数处切分（确定性：取第一个最大者）
    let bi = -1;
    let bSpan = 0;
    let bChan = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].idx.length < 2) continue;
      const { chan, span } = widest(boxes[i]);
      if (span > bSpan) {
        bSpan = span;
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx react-scripts test --watchAll=false --testPathPattern=colorPositive`
Expected: PASS（7 个用例全绿）

- [ ] **Step 5: 类型检查 + 提交**

```powershell
npx tsc --noEmit
git add src/colorPositive/quantize.ts src/colorPositive/quantize.test.ts
git commit -m "feat(colorPositive): median-cut 提色与最近色量化纯函数"
```

---

### Task 2: 打印语义 bands.ts（色带高度 / 换色层 / 导出选项）

**Files:**
- Create: `src/colorPositive/bands.ts`
- Test: `src/colorPositive/bands.test.ts`

**Interfaces:**
- Consumes: `bambu-3mf` 的类型 `PauseLayer`、`Pack3mfOptions`（仅 `import type`，jest 无需解析运行时）。`PauseLayer.atZ` 语义（包内文档）：G-code 插在「顶面到达 atZ 的那一层」开始打印之前。
- Produces（后续任务依赖的精确签名）:
  - `interface Band { label: number; color: string; layers: number }`（label=量化标签、稳定 id；数组约定底→顶）
  - `interface PrintParams { layerHeight: number; firstLayerHeight: number; baseLayers: number }`
  - `type ChangeMode = 'ams' | 'pause'`
  - 常量 `DEFAULT_BAND_LAYERS=3`、`DEFAULT_BASE_LAYERS=3`、`FIRST_LAYER_HEIGHT=0.2`、`LAYER_HEIGHT_OPTIONS=[0.08,0.12,0.16,0.2]`、`DEFAULT_LAYER_HEIGHT=0.2`、`MIN_COLORS=2`、`MAX_COLORS=8`
  - `layerTopZ(layerCount: number, p: PrintParams): number`
  - `interface BandZ { zBottom: number; zTop: number; startLayer: number; endLayer: number }`
  - `bandZTable(bands: Band[], p: PrintParams): BandZ[]`
  - `heightsByLabel(bands: Band[], p: PrintParams): number[]`（label → 顶面 z mm）
  - `buildPauses(bands: Band[], p: PrintParams, mode: ChangeMode): PauseLayer[]`
  - `buildExportOptions(bands: Band[], p: PrintParams, mode: ChangeMode): Pack3mfOptions`

- [ ] **Step 1: 写失败测试**

`src/colorPositive/bands.test.ts`：

```ts
import {
  layerTopZ,
  bandZTable,
  heightsByLabel,
  buildPauses,
  buildExportOptions,
  Band,
  PrintParams,
} from './bands';

const P: PrintParams = { layerHeight: 0.2, firstLayerHeight: 0.2, baseLayers: 3 };
const BANDS: Band[] = [
  { label: 0, color: '#101010', layers: 3 },
  { label: 1, color: '#3355AA', layers: 3 },
  { label: 2, color: '#CC8833', layers: 3 },
  { label: 3, color: '#F0F0F0', layers: 3 },
];

describe('layerTopZ', () => {
  it('第 1 层顶面 = 首层层高', () => expect(layerTopZ(1, P)).toBe(0.2));
  it('0 层 = 0', () => expect(layerTopZ(0, P)).toBe(0));
  it('首层与层高不同时', () =>
    expect(layerTopZ(4, { layerHeight: 0.12, firstLayerHeight: 0.2, baseLayers: 0 })).toBe(0.56));
});

describe('bandZTable', () => {
  it('底板层并入第一带；区间首尾相接、含层号', () => {
    expect(bandZTable(BANDS, P)).toEqual([
      { zBottom: 0, zTop: 1.2, startLayer: 1, endLayer: 6 },
      { zBottom: 1.2, zTop: 1.8, startLayer: 7, endLayer: 9 },
      { zBottom: 1.8, zTop: 2.4, startLayer: 10, endLayer: 12 },
      { zBottom: 2.4, zTop: 3, startLayer: 13, endLayer: 15 },
    ]);
  });
});

describe('heightsByLabel', () => {
  it('乱序色带也按 label 映射顶面高度', () => {
    const shuffled = [BANDS[2], BANDS[0], BANDS[3], BANDS[1]];
    const h = heightsByLabel(shuffled, P);
    expect(h[2]).toBe(1.2);
    expect(h[0]).toBe(1.8);
    expect(h[3]).toBe(2.4);
    expect(h[1]).toBe(3);
  });
});

describe('buildPauses', () => {
  it('AMS 模式：n-1 条 type:2，atZ = 上一带完成后下一层的顶面', () => {
    expect(buildPauses(BANDS, P, 'ams')).toEqual([
      { atZ: 1.4, type: 2, extruder: 2, color: '#3355AA' },
      { atZ: 2, type: 2, extruder: 3, color: '#CC8833' },
      { atZ: 2.6, type: 2, extruder: 4, color: '#F0F0F0' },
    ]);
  });
  it('暂停模式：type:1 + M400 U1', () => {
    expect(buildPauses(BANDS.slice(0, 2), P, 'pause')).toEqual([
      { atZ: 1.4, type: 1, gcode: 'M400 U1', color: '#3355AA' },
    ]);
  });
  it('单色不产生换色', () => {
    expect(buildPauses(BANDS.slice(0, 1), P, 'ams')).toEqual([]);
  });
});

describe('buildExportOptions', () => {
  it('料表 = 底→顶颜色；层高写入并标记修改', () => {
    const o = buildExportOptions(BANDS, P, 'ams');
    expect(o.filaments).toEqual(['#101010', '#3355AA', '#CC8833', '#F0F0F0']);
    expect(o.pauses).toHaveLength(3);
    expect(o.projectSettingsOverrides).toEqual({
      layer_height: '0.2',
      initial_layer_print_height: '0.2',
    });
    expect(o.markModified).toEqual(['layer_height', 'initial_layer_print_height']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx react-scripts test --watchAll=false --testPathPattern=colorPositive`
Expected: FAIL —— `Cannot find module './bands'`

- [ ] **Step 3: 实现 bands.ts**

`src/colorPositive/bands.ts`：

```ts
import type { PauseLayer, Pack3mfOptions } from 'bambu-3mf';

/** 一个色带：label = 量化标签（稳定 id），layers = 本带打印层数。数组约定底→顶。 */
export interface Band {
  label: number;
  color: string;
  layers: number;
}

/** 打印全局参数（层号 ↔ z 换算用）。 */
export interface PrintParams {
  layerHeight: number;
  firstLayerHeight: number;
  /** 底板层数：并入最底部色带（同色连续） */
  baseLayers: number;
}

export type ChangeMode = 'ams' | 'pause';

export const DEFAULT_BAND_LAYERS = 3;
export const DEFAULT_BASE_LAYERS = 3;
export const FIRST_LAYER_HEIGHT = 0.2;
export const LAYER_HEIGHT_OPTIONS = [0.08, 0.12, 0.16, 0.2] as const;
export const DEFAULT_LAYER_HEIGHT = 0.2;
export const MIN_COLORS = 2;
export const MAX_COLORS = 8;

const round2 = (v: number) => Math.round(v * 100) / 100;

/** 打印完第 layerCount 层后的顶面 z（mm）；第 1 层 = 首层层高。 */
export function layerTopZ(layerCount: number, p: PrintParams): number {
  if (layerCount <= 0) return 0;
  return round2(p.firstLayerHeight + (layerCount - 1) * p.layerHeight);
}

export interface BandZ {
  zBottom: number;
  zTop: number;
  /** 本带首层 / 末层（1-based，含底板层） */
  startLayer: number;
  endLayer: number;
}

/** 各色带（底→顶）的高度区间与层号区间；底板层并入第一带。 */
export function bandZTable(bands: Band[], p: PrintParams): BandZ[] {
  const out: BandZ[] = [];
  let cum = p.baseLayers;
  let prevTop = 0;
  let prevCum = 0;
  for (const b of bands) {
    cum += b.layers;
    const zTop = layerTopZ(cum, p);
    out.push({ zBottom: prevTop, zTop, startLayer: prevCum + 1, endLayer: cum });
    prevTop = zTop;
    prevCum = cum;
  }
  return out;
}

/** label → 顶面高度 z（mm）。几何级用它把标签图变成深度图。 */
export function heightsByLabel(bands: Band[], p: PrintParams): number[] {
  const zs = bandZTable(bands, p);
  const out: number[] = [];
  bands.forEach((b, i) => {
    out[b.label] = zs[i].zTop;
  });
  return out;
}

/**
 * n−1 条换色记录。bambu-3mf 的 PauseLayer.atZ 语义：G-code 插在「顶面到达
 * atZ 的那一层」开始打印之前 —— 要在色带 i−1 完成后、色带 i 首层之前换色，
 * atZ = 色带 i 首层的顶面 z。
 */
export function buildPauses(bands: Band[], p: PrintParams, mode: ChangeMode): PauseLayer[] {
  const out: PauseLayer[] = [];
  if (!bands.length) return out;
  let cum = p.baseLayers + bands[0].layers;
  for (let i = 1; i < bands.length; i++) {
    const atZ = layerTopZ(cum + 1, p);
    out.push(
      mode === 'ams'
        ? { atZ, type: 2, extruder: i + 1, color: bands[i].color }
        : { atZ, type: 1, gcode: 'M400 U1', color: bands[i].color }
    );
    cum += bands[i].layers;
  }
  return out;
}

/** 组装 pack3mf 导出选项（不含缩略图——缩略图在页面侧异步生成后并入）。 */
export function buildExportOptions(bands: Band[], p: PrintParams, mode: ChangeMode): Pack3mfOptions {
  return {
    filaments: bands.map((b) => b.color),
    pauses: buildPauses(bands, p, mode),
    projectSettingsOverrides: {
      layer_height: String(p.layerHeight),
      initial_layer_print_height: String(p.firstLayerHeight),
    },
    markModified: ['layer_height', 'initial_layer_print_height'],
    metadataOverrides: {
      ProfileTitle: '多色正片（分层换色）',
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx react-scripts test --watchAll=false --testPathPattern=colorPositive`
Expected: PASS（Task 1 + Task 2 全部用例绿）

- [ ] **Step 5: 类型检查 + 提交**

```powershell
npx tsc --noEmit
git add src/colorPositive/bands.ts src/colorPositive/bands.test.ts
git commit -m "feat(colorPositive): 色带高度表 / 换色层 / 3MF 导出选项纯函数"
```

---

### Task 3: 两级计算 Worker（含 bitmapToImageData 共享提取）

**Files:**
- Create: `src/dataProcess/bitmapToImageData.ts`
- Modify: `src/relief/worker/relief.worker.ts`（删除本地 `bitmapToImageData`，改为 import）
- Create: `src/colorPositive/worker/color.worker.ts`

**Interfaces:**
- Consumes: Task 1 `extractPalette/quantizeToLabels/hexToRgb`；Task 2 `Band/PrintParams/heightsByLabel/DEFAULT_BAND_LAYERS`；`src/relief/buildHeightfield.ts` 的 `buildHeightfield(deepMap: DeepMap, quality: number): HeightfieldResult`；`src/dataProcess/type.ts` 的 `DeepMap`。
- Produces（页面依赖的消息协议）:
  - `interface ColorConfig { maxLength: number; quality: number; bands: Band[]; print: PrintParams }`
  - `interface QuantizeRequest { type: 'quantize'; bitmap: ImageBitmap; autoExtract: boolean; autoN: number; config: ColorConfig }`
  - `interface GeometryRequest { type: 'geometry'; config: ColorConfig }`
  - `type ColorRequest = QuantizeRequest | GeometryRequest`
  - `interface ColorDone { type: 'done'; positions: Float32Array; size: {x,y,z}; triangles: number; bands?: Band[]; counts?: number[]; preview?: Uint8ClampedArray; previewWidth?: number; previewHeight?: number }`
  - `type ColorResponse = ColorProgress | ColorError | ColorDone`（progress/error 字段与 relief 相同）

- [ ] **Step 1: 提取共享 bitmapToImageData**

新建 `src/dataProcess/bitmapToImageData.ts`（函数体与 relief.worker.ts 现有实现逐字相同——`+1` 的尺寸公式是成品尺寸准确性的关键，两个模块必须一致）：

```ts
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
```

- [ ] **Step 2: relief.worker.ts 改用共享函数**

在 `src/relief/worker/relief.worker.ts`：
1. import 区加一行：`import { bitmapToImageData } from '../../dataProcess/bitmapToImageData';`
2. 删除文件内的整个本地 `bitmapToImageData` 函数（第 48–64 行的 JSDoc + 函数体）。
其余不动。

- [ ] **Step 3: 验证 relief 不回归**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 实现 color.worker.ts**

`src/colorPositive/worker/color.worker.ts`：

```ts
/* eslint-disable no-restricted-globals */
import type { DeepMap } from '../../dataProcess/type';
import { bitmapToImageData } from '../../dataProcess/bitmapToImageData';
import { buildHeightfield } from '../../relief/buildHeightfield';
import { extractPalette, quantizeToLabels, hexToRgb } from '../quantize';
import { Band, PrintParams, heightsByLabel, DEFAULT_BAND_LAYERS } from '../bands';

export interface ColorConfig {
  maxLength: number;
  quality: number;
  /** 色带（底→顶）；label = 量化标签 */
  bands: Band[];
  print: PrintParams;
}

/** 全量：量化 + 几何。autoExtract 时忽略 config.bands，自动提取 autoN 色。 */
export interface QuantizeRequest {
  type: 'quantize';
  bitmap: ImageBitmap;
  autoExtract: boolean;
  autoN: number;
  config: ColorConfig;
}

/** 仅几何：复用上次量化缓存的标签图（改顺序/层数/层高时走这里，毫秒级）。 */
export interface GeometryRequest {
  type: 'geometry';
  config: ColorConfig;
}

export type ColorRequest = QuantizeRequest | GeometryRequest;

export interface ColorProgress {
  type: 'progress';
  percent: number;
  info: string;
}

export interface ColorError {
  type: 'error';
  message: string;
}

export interface ColorDone {
  type: 'done';
  positions: Float32Array;
  size: { x: number; y: number; z: number };
  triangles: number;
  /** 以下仅量化通道返回 */
  bands?: Band[];
  counts?: number[];
  preview?: Uint8ClampedArray;
  previewWidth?: number;
  previewHeight?: number;
}

export type ColorResponse = ColorProgress | ColorError | ColorDone;

const post = (msg: ColorResponse, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer || []);
const progress = (percent: number, info: string) => post({ type: 'progress', percent, info });

/** 量化缓存：标签图与其网格尺寸/质量（geometry 请求复用） */
let cache: {
  labels: Uint8Array;
  cols: number;
  rows: number;
  quality: number;
} | null = null;

function buildGeometry(config: ColorConfig): {
  positions: Float32Array;
  size: { x: number; y: number; z: number };
  triangles: number;
} | null {
  if (!cache) return null;
  const { labels, cols, rows, quality } = cache;
  const heights = heightsByLabel(config.bands, config.print);
  const deepMap: DeepMap = [];
  for (let r = 0; r < rows; r++) {
    const line = new Array<number>(cols);
    for (let c = 0; c < cols; c++) {
      const z = heights[labels[r * cols + c]] ?? 0;
      line[c] = Math.round(z * 100); // DeepMap 单元 = mm × 100（与 relief 一致）
    }
    deepMap.push(line);
  }
  const hf = buildHeightfield(deepMap, quality);
  return { positions: hf.positions, size: hf.size, triangles: hf.triangles };
}

self.onmessage = (e: MessageEvent<ColorRequest>) => {
  try {
    if (e.data.type === 'geometry') {
      if (!cache) return; // 图已移除或 worker 重建：静默忽略（主线程有守卫）
      progress(40, '重建几何');
      const g = buildGeometry(e.data.config)!;
      progress(100, '完成');
      post({ type: 'done', ...g }, [g.positions.buffer]);
      return;
    }

    const { bitmap, autoExtract, autoN, config } = e.data;
    progress(10, '解码并缩放图像');
    const imageData = bitmapToImageData(bitmap, config.maxLength, config.quality);
    bitmap.close();
    const { width, height, data } = imageData;

    let bands = config.bands;
    if (autoExtract) {
      progress(30, '提取主色');
      const palette = extractPalette(data, autoN);
      bands = palette.map((color, i) => ({ label: i, color, layers: DEFAULT_BAND_LAYERS }));
    }
    // 调色板按 label 下标索引（bands 的 label 恒为 0..n-1 的一个排列）
    const palette: string[] = [];
    for (const b of bands) palette[b.label] = b.color;

    progress(50, '最近色量化');
    const { labels, counts } = quantizeToLabels(data, palette);
    cache = { labels, cols: width, rows: height, quality: config.quality };

    progress(70, '生成量化预览');
    const preview = new Uint8ClampedArray(width * height * 4);
    const rgb = palette.map(hexToRgb);
    for (let i = 0; i < labels.length; i++) {
      const [r, g, b] = rgb[labels[i]];
      const o = i * 4;
      preview[o] = r;
      preview[o + 1] = g;
      preview[o + 2] = b;
      preview[o + 3] = 255;
    }

    progress(85, '构建网格');
    const g = buildGeometry({ ...config, bands })!;

    progress(100, '完成');
    post(
      {
        type: 'done',
        ...g,
        bands: autoExtract ? bands : undefined,
        counts,
        preview,
        previewWidth: width,
        previewHeight: height,
      },
      [g.positions.buffer, preview.buffer]
    );
  } catch (err: any) {
    post({ type: 'error', message: err?.message || String(err) });
  }
};

export {};
```

- [ ] **Step 5: 验证 + 提交**

```powershell
npx tsc --noEmit
npx react-scripts test --watchAll=false --testPathPattern=colorPositive
git add src/dataProcess/bitmapToImageData.ts src/relief/worker/relief.worker.ts src/colorPositive/worker/color.worker.ts
git commit -m "feat(colorPositive): 两级计算 Worker；提取共享 bitmapToImageData"
```

---

### Task 4: 按高度分带着色材质 heightShader.ts

**Files:**
- Create: `src/colorPositive/heightShader.ts`

**Interfaces:**
- Consumes: three（ShaderMaterial / Color）。几何为非索引 BufferGeometry + `computeVertexNormals()`（非索引 → 逐面法线，天然平面着色）。
- Produces:
  - `MAX_BANDS = 16`
  - `createBandMaterial(): THREE.ShaderMaterial`
  - `updateBandMaterial(mat: THREE.ShaderMaterial, tops: number[], colors: string[]): void`（tops/colors 底→顶一一对应）

- [ ] **Step 1: 实现 heightShader.ts**

```ts
import * as THREE from 'three';

/** 支持的最大色带数（shader 数组上限；UI 限 8，留裕量） */
export const MAX_BANDS = 16;

const VERT = `
varying vec3 vNormal;
varying float vY;
void main() {
  vNormal = normalMatrix * normal;
  vY = position.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = `
uniform float uBandTop[${MAX_BANDS}];
uniform vec3 uBandColor[${MAX_BANDS}];
uniform int uBandCount;
varying vec3 vNormal;
varying float vY;
void main() {
  vec3 c = uBandColor[0];
  for (int i = 0; i < ${MAX_BANDS}; i++) {
    if (i >= uBandCount) break;
    if (vY <= uBandTop[i] + 1e-4) {
      c = uBandColor[i];
      break;
    }
  }
  vec3 n = normalize(vNormal);
  // 相机侧固定方向光 + 环境项：配色所见即所得，明暗只用来读出台阶结构
  float diff = max(dot(n, normalize(vec3(0.35, 0.75, 0.55))), 0.0);
  vec3 col = c * (0.5 + 0.55 * diff);
  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * 按局部 y 高度分带着色的预览材质：片元落在哪个色带区间就取哪带的纯色，
 * 顶面与台阶侧壁都严格由高度决定 —— 预览语义 = 打印语义。
 */
export function createBandMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uBandTop: { value: new Float32Array(MAX_BANDS).fill(1e9) },
      uBandColor: { value: Array.from({ length: MAX_BANDS }, () => new THREE.Color(1, 1, 1)) },
      uBandCount: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.DoubleSide,
  });
}

/** 更新色带边界与颜色（tops/colors 底→顶，一一对应）。 */
export function updateBandMaterial(mat: THREE.ShaderMaterial, tops: number[], colors: string[]): void {
  const t = mat.uniforms.uBandTop.value as Float32Array;
  const c = mat.uniforms.uBandColor.value as THREE.Color[];
  const n = Math.min(tops.length, MAX_BANDS);
  for (let i = 0; i < MAX_BANDS; i++) {
    t[i] = i < n ? tops[i] : 1e9;
    if (i < n) {
      const v = parseInt(colors[i].replace('#', ''), 16);
      // setRGB 默认不做色彩空间转换（three r160）：sRGB 数值直出，
      // 与色板色块 / 2D 量化预览的颜色一致
      c[i].setRGB(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
    }
  }
  mat.uniforms.uBandCount.value = n;
}
```

- [ ] **Step 2: 类型检查 + 提交**

```powershell
npx tsc --noEmit
git add src/colorPositive/heightShader.ts
git commit -m "feat(colorPositive): 按高度分带着色的预览材质"
```

---

### Task 5: 色带图例编辑器 PaletteBands

**Files:**
- Create: `src/colorPositive/PaletteBands.tsx`
- Create: `src/colorPositive/PaletteBands.css`

**Interfaces:**
- Consumes: Task 2 的 `Band`、`BandZ`。
- Produces: 默认导出 `PaletteBands: React.FC<Props>`，Props =
  ```ts
  {
    bands: Band[];                 // 底→顶（组件内部反转为顶→底渲染）
    zTable: BandZ[];               // 与 bands 对齐
    counts: number[] | null;       // 按 label 索引的像素数
    onColorChange: (label: number, color: string) => void;
    onLayersChange: (label: number, layers: number) => void;
    onReorder: (from: number, to: number) => void;  // bands 数组下标
  }
  ```

- [ ] **Step 1: 实现 PaletteBands.tsx**

```tsx
import React, { useRef, useState } from 'react';
// @ts-ignore arco 类型偶尔解析不到
import { InputNumber } from '@arco-design/web-react';
import { Band, BandZ } from './bands';
import './PaletteBands.css';

interface Props {
  /** 色带（底→顶）；渲染时反转为顶→底，与模型上下方向一致 */
  bands: Band[];
  /** 与 bands 对齐的高度/层号区间 */
  zTable: BandZ[];
  /** 每个 label 的像素数（来自量化），未量化时为 null */
  counts: number[] | null;
  onColorChange: (label: number, color: string) => void;
  onLayersChange: (label: number, layers: number) => void;
  /** 把 bands[from] 移到 bands[to]（数组下标，底→顶方向） */
  onReorder: (from: number, to: number) => void;
}

/**
 * 高度-颜色图例编辑器：每行一个色带，从上到下 = 模型从顶到底。
 * 行内改颜色（原生取色器）与层数；拖拽整行重排顺序。
 */
const PaletteBands: React.FC<Props> = ({
  bands,
  zTable,
  counts,
  onColorChange,
  onLayersChange,
  onReorder,
}) => {
  const [dragFrom, setDragFrom] = useState<number | null>(null); // bands 数组下标
  const [dragOver, setDragOver] = useState<number | null>(null);
  const colorInputs = useRef<Record<number, HTMLInputElement | null>>({});

  const total = counts ? counts.reduce((s, c) => s + c, 0) : 0;
  // 顶→底渲染：显示第 d 行 ↔ bands 下标 bands.length - 1 - d
  const order = bands.map((_, d) => bands.length - 1 - d);

  return (
    <div className="cp-bands">
      {order.map((i) => {
        const band = bands[i];
        const z = zTable[i];
        const pct = counts && total ? ((counts[band.label] || 0) / total) * 100 : null;
        return (
          <div
            key={band.label}
            className={
              'cp-band' +
              (dragOver === i && dragFrom !== null && dragFrom !== i ? ' cp-band-over' : '') +
              (dragFrom === i ? ' cp-band-dragging' : '')
            }
            draggable
            onDragStart={(e) => {
              setDragFrom(i);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(i);
            }}
            onDragLeave={() => setDragOver((o) => (o === i ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom !== null && dragFrom !== i) onReorder(dragFrom, i);
              setDragFrom(null);
              setDragOver(null);
            }}
            onDragEnd={() => {
              setDragFrom(null);
              setDragOver(null);
            }}
          >
            <span className="cp-band-grip" aria-hidden="true">
              ⋮⋮
            </span>
            <button
              type="button"
              className="cp-band-swatch"
              style={{ background: band.color }}
              title="点击修改颜色"
              onClick={() => colorInputs.current[band.label]?.click()}
            />
            <input
              ref={(el) => {
                colorInputs.current[band.label] = el;
              }}
              className="cp-band-color-input"
              type="color"
              value={band.color}
              onChange={(e) => onColorChange(band.label, e.target.value.toUpperCase())}
            />
            <span className="cp-band-hex lx-data">{band.color}</span>
            <span className="cp-band-pct lx-data">{pct === null ? '—' : `${pct.toFixed(1)}%`}</span>
            <InputNumber
              className="cp-band-layers lx-data"
              style={{ width: 92 }}
              size="mini"
              mode="button"
              min={1}
              max={50}
              step={1}
              precision={0}
              value={band.layers}
              onChange={(v: number) => onLayersChange(band.label, v)}
            />
            <span className="cp-band-z lx-data">
              {z ? `${z.zBottom.toFixed(2)}–${z.zTop.toFixed(2)}` : '—'}
              <span className="cp-band-z-unit">mm</span>
            </span>
          </div>
        );
      })}
      <div className="cp-bands-hint">
        上 = 模型顶部 · 拖拽整行调整顺序 · 「层数」是该色厚度（最底色带的区间已含底板层）
      </div>
    </div>
  );
};

export default PaletteBands;
```

- [ ] **Step 2: 实现 PaletteBands.css**

```css
/* 色带图例编辑器：行序 = 模型高度（上=顶）。方角小控件，符合 LUMEN 工程感。 */
.cp-bands {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cp-band {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: var(--lx-bg-1);
  border: 1px solid var(--lx-line);
  border-radius: 4px;
  cursor: grab;
}

.cp-band-dragging {
  opacity: 0.45;
}

.cp-band-over {
  border-color: var(--lx-cyan);
}

.cp-band-grip {
  color: var(--lx-text-3);
  font-size: 12px;
  letter-spacing: -2px;
  user-select: none;
}

.cp-band-swatch {
  width: 28px;
  height: 20px;
  border-radius: 2px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  cursor: pointer;
  padding: 0;
  flex: none;
}

/* 原生取色器触发器：隐藏但保持可聚焦（由色块代理点击） */
.cp-band-color-input {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}

.cp-band-hex {
  width: 68px;
  font-size: 12px;
  color: var(--lx-text-2);
}

.cp-band-pct {
  width: 48px;
  font-size: 12px;
  color: var(--lx-text-3);
  text-align: right;
}

.cp-band-layers {
  flex: none;
}

.cp-band-z {
  margin-left: auto;
  font-size: 12px;
  color: var(--lx-text-2);
  white-space: nowrap;
}

.cp-band-z-unit {
  color: var(--lx-text-3);
  margin-left: 2px;
}

.cp-bands-hint {
  font-size: 12px;
  color: var(--lx-text-3);
  margin-top: 2px;
}
```

- [ ] **Step 3: 类型检查 + 提交**

```powershell
npx tsc --noEmit
git add src/colorPositive/PaletteBands.tsx src/colorPositive/PaletteBands.css
git commit -m "feat(colorPositive): 高度-颜色图例编辑器（取色/层数/拖拽排序）"
```

---

### Task 6: 页面组装 + 路由 + 首页卡片 + 切片模板

**Files:**
- Create: `public/bambu/color/`（复制自 `public/bambu/relief/default/`）
- Create: `src/colorPositive/ColorPositive.css`
- Create: `src/colorPositive/ColorPositive.tsx`
- Modify: `src/App.tsx`（+import +1 路由）
- Modify: `src/Home.tsx`（+icon +1 卡片）

**Interfaces:**
- Consumes: Task 1–5 的全部导出；共享组件 `PageNav`（props `title/code`）、`ModelViewer`（props `object/className/revision`）、`CropEditor`（props `src/naturalWidth/naturalHeight/value/onChange/longEdgeMm/onLongEdgeChange`）、`renderEdited(img, natW, natH, crop, colorAdjust, [], 4096)`、`PhotoSizeMap`（`{name,width,height}[]`）、`pack3mf('color', objects, undefined, options)`、`makeThumbnails(dataUrl)`。
- Produces: 路由 `/#/photo2color` 可用的完整工作台页。

- [ ] **Step 1: 复制切片模板**

```powershell
Copy-Item -Recurse "public/bambu/relief/default" "public/bambu/color"
Get-ChildItem "public/bambu/color"
```
Expected: 列出 `metadata.xml`、`project_settings.config`。层高与料表在导出时由 `projectSettingsOverrides`/`filaments` 动态覆盖，模板文件本身不改。

- [ ] **Step 2: 实现 ColorPositive.css**

```css
.cp {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100%;
  box-sizing: border-box;
}

.cp-body {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
}

.cp-panel {
  width: 460px;
  max-width: 46%;
  overflow-y: auto;
  padding: var(--lx-space-4);
  box-sizing: border-box;
  border-right: 1px solid var(--lx-line);
  display: flex;
  flex-direction: column;
  gap: var(--lx-space-4);
}

.cp-section > .lx-eyebrow {
  margin-bottom: var(--lx-space-3);
}

.cp-viewer {
  flex: 1 1 auto;
  position: relative;
  min-width: 0;
}

.cp-canvas {
  width: 100%;
  height: 100%;
}

.cp-hud {
  right: var(--lx-space-4);
  bottom: var(--lx-space-3);
}

/* 视口左下角的量化 2D 预览缩略图（与 3D 模型对照） */
.cp-thumb {
  position: absolute;
  left: var(--lx-space-4);
  bottom: var(--lx-space-3);
  width: 160px;
  max-height: 160px;
  object-fit: contain;
  border: 1px solid var(--lx-line);
  border-radius: 4px;
  background: var(--lx-bg-1);
  image-rendering: pixelated;
  opacity: 0.95;
  pointer-events: none;
}

.cp-empty {
  width: 100%;
  height: 100%;
}
.cp-empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--lx-text-2);
}
.cp-empty-hint {
  font-size: 13px;
  color: var(--lx-text-3);
}

.cp-field-label {
  font-weight: 600;
  color: var(--lx-text-1);
  margin-bottom: 4px;
}

.cp .describe {
  color: var(--lx-text-3);
  font-size: 13px;
  margin-bottom: 10px;
}

.cp-readout {
  color: var(--lx-text-2);
}

.cp-warn {
  color: var(--lx-warn, #e8b339);
}

.cp-size-tag {
  margin: 4px;
  cursor: pointer;
}

.cp-palette-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

@media (max-width: 900px) {
  .cp-body {
    flex-direction: column;
  }
  .cp-panel {
    width: 100%;
    max-width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--lx-line);
  }
  .cp-viewer {
    min-height: 360px;
  }
}
```

注意：`--lx-warn` 若在 `src/theme/tokens.css` 中已有定义则去掉回退值直接用 `var(--lx-warn)`（实现时 grep 确认一次）。

- [ ] **Step 3: 实现 ColorPositive.tsx**

```tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Radio,
  InputNumber,
  Upload,
  Button,
  Progress,
  Tag,
  Message,
  // @ts-ignore arco 类型偶尔解析不到
} from '@arco-design/web-react';
import { debounce } from 'lodash-es';
import * as THREE from 'three';
import './ColorPositive.css';

import { PhotoSizeMap } from '../constants';
import { useDocumentTitle } from '../useDocumentTitle';
import PageNav from '../components/PageNav';
import ModelViewer from '../laser/viewer/ModelViewer';
import CropEditor from '../imageEdit/CropEditor';
import { renderEdited, NO_CROP, defaultColorAdjust, CropRect } from '../imageEdit/imageEdit';
import { pack3mf, Pack3mfOptions, makeThumbnails } from 'bambu-3mf';
import {
  Band,
  PrintParams,
  ChangeMode,
  bandZTable,
  layerTopZ,
  buildExportOptions,
  DEFAULT_BASE_LAYERS,
  DEFAULT_LAYER_HEIGHT,
  FIRST_LAYER_HEIGHT,
  LAYER_HEIGHT_OPTIONS,
  MIN_COLORS,
  MAX_COLORS,
} from './bands';
import { createBandMaterial, updateBandMaterial } from './heightShader';
import type { QuantizeRequest, GeometryRequest, ColorResponse } from './worker/color.worker';
import PaletteBands from './PaletteBands';

const RadioGroup = Radio.Group;

/** 只用共享编辑器的裁剪（不调色——量化本身就是本模块的色彩处理） */
const CP_NO_COLOR = defaultColorAdjust([]);

function safeBaseName(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, '')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .trim() || 'color'
  );
}

function saveBlob(data: BlobPart, filename: string) {
  const blob = new Blob([data]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 几何请求的等价键：顺序/层数/层高/底板一致则几何不必重建 */
const makeGeomKey = (b: Band[], p: PrintParams) =>
  `${b.map((x) => `${x.label}:${x.layers}`).join('>')}|${p.layerHeight}|${p.baseLayers}`;

const ColorPositive: React.FC = () => {
  useDocumentTitle('照片转多色正片');

  // —— 输入 ——
  const [imageUrl, setImageUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const imgElRef = useRef<HTMLImageElement | null>(null);
  const [natSize, setNatSize] = useState({ w: 0, h: 0 });
  const [crop, setCrop] = useState<CropRect>(NO_CROP);

  // —— 色板 ——
  const [bands, setBands] = useState<Band[] | null>(null); // 底→顶；null = 等待自动提取
  const bandsRef = useRef<Band[] | null>(null);
  bandsRef.current = bands;
  const [customized, setCustomized] = useState(false); // 用户改过颜色/顺序 → 不再自动覆盖
  const [colorCount, setColorCount] = useState(4);
  const [extractSeq, setExtractSeq] = useState(0); // 「重新提取」手动触发计数
  const [counts, setCounts] = useState<number[] | null>(null);

  // —— 模型 ——
  const [layerHeight, setLayerHeight] = useState<number>(DEFAULT_LAYER_HEIGHT);
  const [baseLayers, setBaseLayers] = useState(DEFAULT_BASE_LAYERS);
  const [quality, setQuality] = useState(5);
  const [maxLength, setMaxLength] = useState(127);

  // —— 打印 ——
  const [changeMode, setChangeMode] = useState<ChangeMode>('ams');

  // —— 运行状态 ——
  const [progress, setProgress] = useState(0);
  const [progressInfo, setProgressInfo] = useState('');
  const [building, setBuilding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [quantPreviewUrl, setQuantPreviewUrl] = useState('');
  const [viewObject, setViewObject] = useState<THREE.Object3D | null>(null);
  const [revision, setRevision] = useState(0);
  const [stats, setStats] = useState<{
    triangles: number;
    size: { x: number; y: number; z: number };
  } | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const geomRef = useRef<THREE.BufferGeometry | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  /** 最近一次已发给 worker 的几何键（防止量化通道刚建完几何又被几何 effect 重复重建） */
  const builtKeyRef = useRef('');

  const print: PrintParams = useMemo(
    () => ({ layerHeight, firstLayerHeight: FIRST_LAYER_HEIGHT, baseLayers }),
    [layerHeight, baseLayers]
  );
  const printRef = useRef(print);
  printRef.current = print;

  const zTable = useMemo(() => (bands ? bandZTable(bands, print) : []), [bands, print]);
  const totalLayerCount = useMemo(
    () => (bands ? baseLayers + bands.reduce((s, b) => s + b.layers, 0) : 0),
    [bands, baseLayers]
  );
  const totalHeight = bands ? layerTopZ(totalLayerCount, print) : 0;

  // 成像区物理尺寸（随裁剪/长边实时换算）
  const printSize = useMemo(() => {
    const w = natSize.w * crop.w;
    const h = natSize.h * crop.h;
    if (!w || !h) return { width: '0', height: '0' };
    const scala = Math.min(maxLength / h, maxLength / w);
    return { width: (w * scala).toFixed(2), height: (h * scala).toFixed(2) };
  }, [natSize, crop, maxLength]);

  const disposeView = useCallback(() => {
    if (materialRef.current) {
      materialRef.current.dispose();
      materialRef.current = null;
    }
    if (geomRef.current) {
      geomRef.current.dispose();
      geomRef.current = null;
    }
    meshRef.current = null;
  }, []);

  // 量化预览（RGBA）→ dataURL；同时是 3MF 缩略图来源
  const renderPreview = useCallback((preview: Uint8ClampedArray, width: number, height: number) => {
    if (!width || !height) {
      setQuantPreviewUrl('');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(preview, width, height), 0, 0);
    setQuantPreviewUrl(canvas.toDataURL());
  }, []);

  // —— worker 两个通道（量化 350ms / 仅几何 150ms 防抖） ——
  const runQuantize = useMemo(
    () =>
      debounce((canvas: HTMLCanvasElement, req: Omit<QuantizeRequest, 'bitmap'>) => {
        if (!workerRef.current) return;
        setBuilding(true);
        setProgress(1);
        setProgressInfo('准备数据');
        createImageBitmap(canvas)
          .then((bitmap) => {
            workerRef.current!.postMessage({ ...req, bitmap }, [bitmap]);
          })
          .catch((err) => {
            setBuilding(false);
            Message.error(`图片解码失败：${err?.message || err}`);
          });
      }, 350),
    []
  );
  const runGeometry = useMemo(
    () =>
      debounce((req: GeometryRequest) => {
        if (!workerRef.current) return;
        setBuilding(true);
        setProgress(1);
        setProgressInfo('重建几何');
        workerRef.current.postMessage(req);
      }, 150),
    []
  );

  /** 发起量化（bandsForReq=null → 自动提取 colorCount 色） */
  const kickQuantize = useCallback(
    (bandsForReq: Band[] | null) => {
      const img = imgElRef.current;
      if (!img || !img.naturalWidth) return;
      const edited = renderEdited(img, img.naturalWidth, img.naturalHeight, crop, CP_NO_COLOR, [], 4096);
      builtKeyRef.current = bandsForReq ? makeGeomKey(bandsForReq, printRef.current) : '';
      runQuantize(edited, {
        type: 'quantize',
        autoExtract: !bandsForReq,
        autoN: colorCount,
        config: { maxLength, quality, bands: bandsForReq ?? [], print: printRef.current },
      });
    },
    [crop, colorCount, maxLength, quality, runQuantize]
  );

  // init worker once
  useEffect(() => {
    const worker = new Worker(new URL('./worker/color.worker.ts', import.meta.url));
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<ColorResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        setProgress(msg.percent);
        setProgressInfo(msg.info);
        return;
      }
      if (msg.type === 'error') {
        setBuilding(false);
        Message.error(`生成失败：${msg.message}`);
        return;
      }
      // done —— 图已删除/更换时丢弃陈旧结果（与 relief 同一机制）
      if (!imgElRef.current) return;
      const nextBands = msg.bands ?? bandsRef.current;
      if (!nextBands) return;
      if (msg.bands) {
        setBands(msg.bands);
        setCustomized(false);
        builtKeyRef.current = makeGeomKey(msg.bands, printRef.current);
      }
      if (msg.counts) setCounts(msg.counts);
      if (msg.preview && msg.previewWidth && msg.previewHeight) {
        renderPreview(msg.preview, msg.previewWidth, msg.previewHeight);
      }
      // 几何：单一 mesh/material，只换 geometry（调参时相机不会被重置）
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(msg.positions, 3));
      geom.computeVertexNormals();
      if (geomRef.current) geomRef.current.dispose();
      geomRef.current = geom;
      if (!materialRef.current) materialRef.current = createBandMaterial();
      const zt = bandZTable(nextBands, printRef.current);
      updateBandMaterial(
        materialRef.current,
        zt.map((z) => z.zTop),
        nextBands.map((b) => b.color)
      );
      if (!meshRef.current) {
        const mesh = new THREE.Mesh(geom, materialRef.current);
        meshRef.current = mesh;
        const group = new THREE.Group();
        group.add(mesh);
        setViewObject(group);
      } else {
        meshRef.current.geometry = geom;
      }
      setRevision((r) => r + 1);
      setStats({ triangles: msg.triangles, size: msg.size });
      setBuilding(false);
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
      disposeView();
    };
  }, [disposeView, renderPreview]);

  // 量化触发：图/裁剪/尺寸/精细度/颜色数/手动重提 变化 → 全量重算
  // （色板颜色编辑不走这里——onBandColor 里显式 kickQuantize，避免 effect 回环）
  useEffect(() => {
    if (!imgElRef.current) return;
    // bands 为 null（新图未提取 / 改颜色数 / 手动重提）→ 自动提取；否则沿用当前色板重量化
    kickQuantize(bandsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, crop, natSize, maxLength, quality, colorCount, extractSeq]);

  // 仅几何触发：顺序/层数/层高/底板层数 变化 → 复用标签图快速重建
  useEffect(() => {
    const b = bandsRef.current;
    if (!b || !meshRef.current) return;
    const key = makeGeomKey(b, print);
    if (key === builtKeyRef.current) return;
    builtKeyRef.current = key;
    runGeometry({
      type: 'geometry',
      config: { maxLength, quality, bands: b, print },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bands, print]);

  // —— 色板交互 ——
  const onBandColor = useCallback(
    (label: number, color: string) => {
      const cur = bandsRef.current;
      if (!cur) return;
      const next = cur.map((b) => (b.label === label ? { ...b, color } : b));
      setBands(next);
      setCustomized(true);
      kickQuantize(next); // 改色 → 最近色重新分配（复用不了标签图）
    },
    [kickQuantize]
  );

  const onBandLayers = useCallback((label: number, layers: number) => {
    const cur = bandsRef.current;
    if (!cur) return;
    const v = Math.max(1, Math.round(layers || 1));
    setBands(cur.map((b) => (b.label === label ? { ...b, layers: v } : b)));
  }, []);

  const onReorder = useCallback((from: number, to: number) => {
    const cur = bandsRef.current;
    if (!cur) return;
    const next = cur.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setBands(next);
    setCustomized(true);
  }, []);

  const onColorCountChange = useCallback((v: number) => {
    setColorCount(v);
    setBands(null); // 触发自动重提取
    setCounts(null);
  }, []);

  const reExtract = useCallback(() => {
    setBands(null);
    setCounts(null);
    setCustomized(false);
    setExtractSeq((s) => s + 1);
  }, []);

  // —— 上传 / 重置 ——
  const onFile = useCallback(
    (file: File) => {
      imgElRef.current = null;
      disposeView();
      setViewObject(null);
      setStats(null);
      setQuantPreviewUrl('');
      setProgress(0);
      setProgressInfo('');
      setBuilding(false);
      setCounts(null);
      builtKeyRef.current = '';
      if (!customized) setBands(null); // 自定义色板跨图保留；自动色板换图重提

      setFileName(file.name);
      setCrop(NO_CROP);
      const reader = new FileReader();
      reader.onload = (ev) => {
        const url = ev.target?.result as string;
        setImageUrl(url);
        const img = new Image();
        img.onload = () => {
          imgElRef.current = img;
          setNatSize({ w: img.naturalWidth, h: img.naturalHeight });
        };
        img.src = url;
      };
      reader.readAsDataURL(file);
    },
    [customized, disposeView]
  );

  const resetAll = useCallback(() => {
    runQuantize.cancel();
    runGeometry.cancel();
    imgElRef.current = null;
    setImageUrl('');
    setFileName('');
    setNatSize({ w: 0, h: 0 });
    setCrop(NO_CROP);
    setBands(null);
    setCounts(null);
    setCustomized(false);
    setProgress(0);
    setProgressInfo('');
    setBuilding(false);
    setQuantPreviewUrl('');
    setViewObject(null);
    setStats(null);
    builtKeyRef.current = '';
    disposeView();
  }, [disposeView, runGeometry, runQuantize]);

  // —— 导出 ——
  const onExport3mf = useCallback(async () => {
    const geom = geomRef.current;
    const b = bandsRef.current;
    if (!geom || !b || !b.length) {
      Message.warning('请先上传图片并生成模型');
      return;
    }
    setExporting(true);
    try {
      const options: Pack3mfOptions = buildExportOptions(b, printRef.current, changeMode);
      try {
        if (quantPreviewUrl) options.thumbnails = await makeThumbnails(quantPreviewUrl);
      } catch {
        // 缩略图失败不阻断导出
      }
      const u8 = await pack3mf('color', [{ name: 'color-positive', geometry: geom }], undefined, options);
      const fname = `${safeBaseName(fileName)}-${b.length}色-${
        changeMode === 'ams' ? 'AMS换色' : '暂停换料'
      }.3mf`;
      saveBlob(u8, fname);
      Message.success(
        changeMode === 'ams'
          ? '3MF 已导出（AMS 自动换色）'
          : '3MF 已导出（每次换色自动暂停，手动换料后继续）'
      );
    } catch (e: any) {
      Message.error(`导出失败：${e?.message || e}`);
    } finally {
      setExporting(false);
    }
  }, [changeMode, fileName, quantPreviewUrl]);

  const sizeText = stats
    ? `${stats.size.x.toFixed(1)} × ${stats.size.z.toFixed(1)} × ${stats.size.y.toFixed(2)} mm`
    : '—';

  return (
    <div className="cp">
      <PageNav title="照片转多色正片" code="COLOR" />

      <div className="cp-body">
        <div className="cp-panel">
          {/* 图片 IMAGE ---------------------------------------------- */}
          <section className="lx-panel cp-section">
            <div className="lx-eyebrow">
              <span>图片</span>
              <span className="lx-eyebrow-code">IMAGE</span>
            </div>
            <div className="cp-field-label">选择图像</div>
            <div className="describe">支持 jpg/png/jpeg。全部处理在本地浏览器完成，不上传服务器。</div>
            <Upload
              drag
              accept="image/*"
              limit={1}
              showUploadList
              autoUpload={false}
              onChange={(list: any[]) => {
                const f = list && list[list.length - 1];
                if (f?.originFile) onFile(f.originFile);
                else if (!list || !list.length) resetAll();
              }}
              tip="仅支持图片"
            />
            {imageUrl && natSize.w ? (
              <>
                <div className="cp-field-label" style={{ marginTop: 12 }}>
                  原图 / 裁剪
                </div>
                <div className="describe">拖动选框移动、八向手柄改尺寸、上方选比例；裁剪直接作用于原图。</div>
                <CropEditor
                  src={imageUrl}
                  naturalWidth={natSize.w}
                  naturalHeight={natSize.h}
                  value={crop}
                  onChange={setCrop}
                  longEdgeMm={maxLength}
                  onLongEdgeChange={(mm) => setMaxLength(Math.min(1000, Math.max(1, Math.round(mm))))}
                />
              </>
            ) : null}
          </section>

          {imageUrl ? (
            <>
              {/* 色板 PALETTE ---------------------------------------- */}
              <section className="lx-panel cp-section">
                <div className="lx-eyebrow">
                  <span>色板</span>
                  <span className="lx-eyebrow-code">PALETTE</span>
                </div>
                <div className="cp-field-label">颜色数量</div>
                <div className="describe">
                  自动从图片提取主色；点色块可改成自己耗材的颜色，改后进入自定义状态。
                </div>
                <div className="cp-palette-head">
                  <InputNumber
                    className="lx-data"
                    style={{ width: 140 }}
                    mode="button"
                    min={MIN_COLORS}
                    max={MAX_COLORS}
                    step={1}
                    precision={0}
                    value={colorCount}
                    disabled={customized}
                    onChange={onColorCountChange}
                  />
                  <Button size="small" onClick={reExtract}>
                    重新提取
                  </Button>
                </div>
                {customized ? (
                  <div className="describe">色板已自定义；调整颜色数量前请先「重新提取」。</div>
                ) : null}
                {bands ? (
                  <PaletteBands
                    bands={bands}
                    zTable={zTable}
                    counts={counts}
                    onColorChange={onBandColor}
                    onLayersChange={onBandLayers}
                    onReorder={onReorder}
                  />
                ) : (
                  <div className="describe">正在提取主色…</div>
                )}
              </section>

              {/* 模型 MODEL ------------------------------------------ */}
              <section className="lx-panel cp-section">
                <div className="lx-eyebrow">
                  <span>模型</span>
                  <span className="lx-eyebrow-code">MODEL</span>
                </div>
                <div className="cp-field-label">层高 (mm)</div>
                <div className="describe">换色只发生在层边界；打印机层高必须与此一致。</div>
                <RadioGroup type="button" value={layerHeight} onChange={(v: number) => setLayerHeight(v)}>
                  {LAYER_HEIGHT_OPTIONS.map((lh) => (
                    <Radio key={lh} value={lh}>
                      {lh.toFixed(2)}
                    </Radio>
                  ))}
                </RadioGroup>

                <div className="cp-field-label" style={{ marginTop: 16 }}>
                  底板层数
                </div>
                <div className="describe">底板与最底部颜色同色连续，保证整体强度。首层层高固定 0.20mm。</div>
                <InputNumber
                  className="lx-data"
                  style={{ width: 140 }}
                  mode="button"
                  min={1}
                  max={50}
                  step={1}
                  precision={0}
                  value={baseLayers}
                  onChange={(v: number) => setBaseLayers(Math.max(1, Math.round(v || 1)))}
                />

                <div className="cp-field-label" style={{ marginTop: 16 }}>
                  成像区长边长度 (mm)
                </div>
                <div className="describe">
                  常见照片尺寸（点击设置长边）：
                  {PhotoSizeMap.map((i) => (
                    <Tag key={i.name} className="cp-size-tag" onClick={() => setMaxLength(Math.max(i.width, i.height))}>
                      {i.name}
                    </Tag>
                  ))}
                </div>
                <InputNumber
                  className="lx-data"
                  style={{ width: 180 }}
                  size="large"
                  mode="button"
                  suffix="mm"
                  min={1}
                  max={1000}
                  step={1}
                  precision={1}
                  value={maxLength}
                  onChange={(v: number) => setMaxLength(v)}
                />
                <div className="describe cp-readout" style={{ marginTop: 8 }}>
                  图像区尺寸：
                  <span className="lx-data">
                    {printSize.width} × {printSize.height}
                  </span>{' '}
                  mm
                </div>

                <div className="cp-field-label" style={{ marginTop: 16 }}>
                  精细度（每 mm 像素数）
                </div>
                <div className="describe">越高越精细，三角面数与切片时间也随之上升；建议 A1/P1/X1 取 4/8/10。</div>
                <InputNumber
                  className="lx-data"
                  style={{ width: 140 }}
                  mode="button"
                  min={1}
                  max={20}
                  step={1}
                  precision={0}
                  value={quality}
                  onChange={(v: number) => setQuality(v)}
                />

                <div className="describe cp-readout" style={{ marginTop: 12 }}>
                  成品总高：<span className="lx-data">{totalHeight.toFixed(2)}</span> mm（
                  <span className="lx-data">{totalLayerCount}</span> 层，其中底板{' '}
                  <span className="lx-data">{baseLayers}</span> 层）
                </div>
              </section>

              {/* 打印 PRINT ------------------------------------------ */}
              <section className="lx-panel cp-section">
                <div className="lx-eyebrow">
                  <span>打印</span>
                  <span className="lx-eyebrow-code">PRINT</span>
                </div>
                <div className="cp-field-label">换色方式</div>
                <RadioGroup type="button" value={changeMode} onChange={(v: ChangeMode) => setChangeMode(v)}>
                  <Radio value="ams">AMS 自动换色</Radio>
                  <Radio value="pause">暂停手动换料</Radio>
                </RadioGroup>
                {changeMode === 'ams' && bands && bands.length > 4 ? (
                  <div className="describe cp-warn" style={{ marginTop: 8 }}>
                    超过 4 色需要多个 AMS；单 AMS 用户建议切换「暂停手动换料」。
                  </div>
                ) : null}
                {changeMode === 'pause' ? (
                  <div className="describe" style={{ marginTop: 8 }}>
                    每到换色层打印机自动暂停（M400 U1），手动换料后点继续即可，无需 AMS。
                  </div>
                ) : null}

                <div className="cp-field-label" style={{ marginTop: 16 }}>
                  生成进度
                </div>
                <Progress percent={progress} formatText={() => progressInfo} />

                <div className="describe cp-readout" style={{ marginTop: 16 }}>
                  成品尺寸（宽×长×厚）：<span className="lx-data">{sizeText}</span>
                  {stats ? (
                    <>
                      ；三角面 <span className="lx-data">{stats.triangles.toLocaleString()}</span>；换色{' '}
                      <span className="lx-data">{bands ? bands.length - 1 : 0}</span> 次
                    </>
                  ) : (
                    ''
                  )}
                </div>
                <Button
                  type="primary"
                  size="large"
                  long
                  loading={exporting}
                  disabled={building || exporting || !stats}
                  onClick={onExport3mf}
                >
                  导出 3MF（含分层换色）
                </Button>
                <div className="describe" style={{ marginTop: 8 }}>
                  已内置拓竹工艺参数与 {bands ? bands.length : 0} 色料表，打开 3mf 文件即可打印。
                </div>
              </section>
            </>
          ) : null}
        </div>

        <div className="cp-viewer lx-viewport">
          {viewObject ? (
            <>
              <ModelViewer object={viewObject} className="cp-canvas" revision={revision} />
              {quantPreviewUrl ? <img className="cp-thumb" src={quantPreviewUrl} alt="量化预览" /> : null}
              {stats ? (
                <div className="lx-viewport-hud cp-hud">
                  {stats.size.x.toFixed(1)} × {stats.size.z.toFixed(1)} × {stats.size.y.toFixed(2)} mm
                  {' · '}
                  {stats.triangles.toLocaleString()} 面{' · '}换色 {bands ? bands.length - 1 : 0} 次
                </div>
              ) : null}
            </>
          ) : (
            <div className="lx-empty cp-empty">
              <div className="cp-empty-title">还没有模型</div>
              <div className="cp-empty-hint">上传一张图片，多色正片会在此实时成形</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ColorPositive;
```

- [ ] **Step 4: 注册路由**

`src/App.tsx` 改为：

```tsx
import React from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import Home from './Home';
import Relief from './relief/Relief';
import LaserCut from './laser/LaserCut';
import ColorPositive from './colorPositive/ColorPositive';
import './App.css';

function App() {
  return (
    <div className="App">
      <HashRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/photo2relief" element={<Relief />} />
          <Route path="/lac2model" element={<LaserCut />} />
          <Route path="/photo2color" element={<ColorPositive />} />
        </Routes>
      </HashRouter>
    </div>
  );
}

export default App;
```

- [ ] **Step 5: 首页卡片**

`src/Home.tsx`：在 `ReliefIcon` 组件之后新增图标组件：

```tsx
/**
 * Colour-positive icon: a stepped terrace pyramid — each level is one colour
 * band (height encodes colour) — with a filament droplet marking the colour
 * change. Line-art (currentColor) so the parent can ignite it on hover.
 */
const ColorPositiveIcon: React.FC = () => (
  <svg
    width="44"
    height="44"
    viewBox="0 0 48 48"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {/* stepped colour terraces (height encodes colour) */}
    <rect x="6" y="34" width="36" height="8" rx="2" />
    <rect x="11" y="26" width="26" height="8" rx="2" opacity="0.9" />
    <rect x="16" y="18" width="16" height="8" rx="2" opacity="0.9" />
    <rect x="21" y="10" width="6" height="8" rx="2" opacity="0.9" />
    {/* filament-change droplet */}
    <path d="M38 10 c2 2.8 3.2 4.5 3.2 6 a3.2 3.2 0 1 1 -6.4 0 c0 -1.5 1.2 -3.2 3.2 -6 z" opacity="0.85" />
  </svg>
);
```

在 `features` 数组末尾新增：

```tsx
  {
    title: '照片转多色正片',
    description:
      '上传图片，量化为 n 个纯色并生成分层换色的一体化 3D 模型，导出 3MF 直接打印，支持 AMS 自动换色或暂停手动换料。',
    path: '/photo2color',
    transform: 'COLOR',
    icon: <ColorPositiveIcon />,
  },
```

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 7: 浏览器验证（dev server）**

启动 dev server（Browser 面板 `preview_start`；若无 `.claude/launch.json` 先创建，`runtimeExecutable: "npm"`, `runtimeArgs: ["start"]`, `port: 3000`），导航到 `http://localhost:3000/#/photo2color`，逐项确认：

1. 首页出现第 3 张卡片「照片转多色正片 · PHOTO→COLOR」，点击进入。
2. 空态显示「还没有模型」邀请文案。
3. 上传一张彩色照片 → 进度条走动 → 3D 视口出现台阶模型，颜色分层显示；左下角出现量化 2D 预览缩略图；HUD 显示尺寸/面数/换色次数。
4. 色板区出现 4 行色带（上=亮色、下=暗色），每行有色块/HEX/占比/层数/高度区间；高度区间首尾相接（底带从 0.00 开始）。
5. 拖拽一行到其他位置 → 3D 模型高度分布立即变化（<1s），相机视角不被重置。
6. 改某行层数 → 高度区间与总高读数更新，3D 同步。
7. 点色块改颜色 → 量化重跑，2D/3D 颜色更新；「颜色数量」变为禁用并显示自定义提示。
8. 点「重新提取」→ 恢复自动色板，颜色数量恢复可用。
9. 改颜色数量为 6 → 色带变 6 行。
10. 层高切 0.12 → 高度区间数值变小，总高变小。
11. 换色方式切「暂停手动换料」→ 显示暂停说明；选 6 色 + AMS 时显示多 AMS 警告。
12. 删除已上传图片 → 页面回到空态（色板/预览/模型全部清空）。
13. `read_console_messages` 无报错（ResizeObserver 提示除外）。

- [ ] **Step 8: 提交**

```powershell
git add public/bambu/color src/colorPositive/ColorPositive.tsx src/colorPositive/ColorPositive.css src/App.tsx src/Home.tsx
git commit -m "feat(colorPositive): 多色正片工作台页（路由/卡片/切片模板）"
```

---

### Task 7: 导出 3MF 端到端验证

**Files:**
- 无新文件（验证 + 必要修复）

**Interfaces:**
- Consumes: Task 6 的完整页面；`bambu-3mf` 打包产物结构（ZIP：`Metadata/custom_gcode_per_layer.xml`、`Metadata/project_settings.config`）。

- [ ] **Step 1: 导出 AMS 模式文件**

在浏览器页面：上传图片（默认 4 色、层高 0.20、底板 3 层），换色方式保持「AMS 自动换色」，点「导出 3MF」。确认出现成功 Message，文件落到下载目录。

- [ ] **Step 2: 解包检查换色 G-code 与料表**

```powershell
$f = Get-ChildItem "$env:USERPROFILE\Downloads" -Filter *.3mf | Sort-Object LastWriteTime | Select-Object -Last 1
$zip = Join-Path $env:TEMP 'cp3mf.zip'
$dst = Join-Path $env:TEMP 'cp3mf'
Copy-Item $f.FullName $zip -Force
Remove-Item -Recurse -Force $dst -ErrorAction SilentlyContinue
Expand-Archive -Path $zip -DestinationPath $dst -Force
Get-Content "$dst\Metadata\custom_gcode_per_layer.xml"
node -e "const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log('colors:',j.filament_colour);console.log('layer_height:',j.layer_height,'first:',j.initial_layer_print_height)" "$dst/Metadata/project_settings.config"
```

Expected:
- `custom_gcode_per_layer.xml` 含 3 条记录，`type="2"`，extruder 依次 2/3/4，z 依次 1.4 / 2.0 / 2.6（默认参数下），颜色与色板一致；
- `filament_colour` 为 4 个色板 hex（底→顶）；`layer_height` = "0.2"、`initial_layer_print_height` = "0.2"；
- ZIP 内有 `Metadata/plate_1.png` 缩略图（量化预览）。

- [ ] **Step 3: 导出暂停模式并复验**

页面切「暂停手动换料」再导出一次，重复 Step 2 的解包命令。
Expected: 3 条记录 `type="1"`、gcode 为 `M400 U1`（XML 转义后形态）、无 extruder 递增要求。

- [ ] **Step 4: （有条件则做）Bambu Studio 人工抽查**

若本机装有 Bambu Studio：双击打开导出的 AMS 版 3mf，确认：模型单体、料表 4 色、切片后换色时间轴在正确高度。此步无法自动化，失败则回到 bands.ts 修 atZ 语义（有单测锁定，不太可能）。

- [ ] **Step 5: 提交（若有修复）**

```powershell
npx tsc --noEmit
npx react-scripts test --watchAll=false --testPathPattern=colorPositive
git add -A
git commit -m "fix(colorPositive): 导出验证修正" # 仅当有改动
```

---

### Task 8: 收尾（全量回归 + 构建 + 合规清单）

- [ ] **Step 1: 全量测试与类型检查**

```powershell
npx react-scripts test --watchAll=false
npx tsc --noEmit
```
Expected: 全部 PASS / 无类型错误。

- [ ] **Step 2: 生产构建**

Run: `npm run build`
Expected: Compiled successfully（css/js 产物含 colorPositive chunk；`build/bambu/color/` 随 public 一起被复制）。

- [ ] **Step 3: DESIGN.md 合规自查**

对照 `src/theme/DESIGN.md` 快速过一遍新页面：深色、无新增光谱渐变、数字均 `.lx-data`、眉标中英成对、≤900px 折叠可用、`prefers-reduced-motion` 不受影响（本模块未新增动画）。

- [ ] **Step 4: 提交收尾**

```powershell
git add -A
git commit -m "chore(colorPositive): 收尾回归与构建验证" # 仅当有改动
```

---

## Self-Review 记录

- **Spec 覆盖**：§2 文件结构 → Task 1–6；§3 两级管线/缓存/防陈旧 → Task 3/6；§4 UI 四分区/图例编辑器/视口缩略图 → Task 5/6；§5 filaments/pauses/层数定义/atZ → Task 2/7；§6 默认参数 → bands.ts 常量 + 页面初值；§7 错误处理（删除清空/AMS>4 警告/worker error/4096 cap）→ Task 6；§8 测试 → Task 1/2/6/7/8；§9 不做清单未越界。
- **占位符**：无 TBD/TODO；所有代码块完整可落盘。
- **类型一致性**：`Band/PrintParams/ChangeMode/BandZ` 定义于 Task 2，Task 3/5/6 的 import 与字段一致；worker 消息类型 Task 3 定义、Task 6 import 名一致（`QuantizeRequest/GeometryRequest/ColorResponse`）；`buildHeightfield(deepMap, quality)` 与现有签名一致。
