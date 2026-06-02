/* eslint-disable no-restricted-globals */
import type { Config, DeepMap } from '../../dataProcess/type';
import {
  transImageDataList2Map,
  getLightArray,
  toDataDeepMap,
  generateBorder,
} from '../reliefAlgo';
import { buildHeightfield } from '../buildHeightfield';

export interface ReliefRequest {
  bitmap: ImageBitmap;
  config: Config;
}

export interface ReliefProgress {
  type: 'progress';
  percent: number;
  info: string;
}

export interface ReliefDone {
  type: 'done';
  positions: Float32Array;
  size: { x: number; y: number; z: number };
  triangles: number;
  cols: number;
  rows: number;
}

export interface ReliefError {
  type: 'error';
  message: string;
}

export type ReliefResponse = ReliefProgress | ReliefDone | ReliefError;

const post = (msg: ReliefResponse, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer || []);

const progress = (percent: number, info: string) =>
  post({ type: 'progress', percent, info });

/**
 * Decode an ImageBitmap into scaled ImageData using OffscreenCanvas, matching
 * the legacy getImageRGBList sizing: final = zoom*side*Quality + Quality, where
 * zoom fits the longest edge to MaxLength.
 */
function bitmapToImageData(bitmap: ImageBitmap, maxLength: number, quality: number): ImageData {
  const w = bitmap.width;
  const h = bitmap.height;
  const zoom = w >= h ? maxLength / w : maxLength / h;
  const finalW = Math.max(2, Math.round(zoom * w * quality + quality));
  const finalH = Math.max(2, Math.round(zoom * h * quality + quality));
  const canvas = new OffscreenCanvas(finalW, finalH);
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('无法创建 OffscreenCanvas 2D 上下文');
  ctx.drawImage(bitmap, 0, 0, w, h, 0, 0, finalW, finalH);
  return ctx.getImageData(0, 0, finalW, finalH);
}

self.onmessage = (e: MessageEvent<ReliefRequest>) => {
  const { bitmap, config } = e.data;
  try {
    const {
      MaxDeep,
      LayerDeep,
      BaseDeep,
      MaxLength,
      Quality,
      AddBorder,
      PreventWhiteHollow,
      BorderWidth,
      BorderHeight,
    } = config;

    progress(5, '参数设置');
    const imageDeep = 256;
    let layerNumber = Math.floor((MaxDeep - BaseDeep) / LayerDeep) + 1;
    if (PreventWhiteHollow) layerNumber -= 1;
    const layerLight = imageDeep / layerNumber;
    const maxPrintDeep = { value: 0 };

    progress(15, '解码并缩放图像');
    const imageData = bitmapToImageData(bitmap, MaxLength, Quality);
    bitmap.close();

    progress(35, '解析像素数据');
    const rgbMap = transImageDataList2Map(imageData);

    progress(50, '生成明度图');
    const lightMap = getLightArray(rgbMap);

    progress(65, '生成深度图');
    const deepMap: DeepMap = toDataDeepMap(
      lightMap,
      imageDeep,
      layerNumber,
      layerLight,
      LayerDeep,
      BaseDeep,
      maxPrintDeep,
      PreventWhiteHollow
    );

    progress(78, '添加边框');
    const withBorder = generateBorder(deepMap, AddBorder, BorderWidth, BorderHeight, Quality);

    progress(88, '构建网格');
    const hf = buildHeightfield(withBorder, Quality);

    progress(100, '完成');
    post(
      {
        type: 'done',
        positions: hf.positions,
        size: hf.size,
        triangles: hf.triangles,
        cols: hf.cols,
        rows: hf.rows,
      },
      [hf.positions.buffer]
    );
  } catch (err: any) {
    post({ type: 'error', message: err?.message || String(err) });
  }
};

export {};
