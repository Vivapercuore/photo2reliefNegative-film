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
