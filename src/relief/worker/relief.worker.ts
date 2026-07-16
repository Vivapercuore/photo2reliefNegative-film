/* eslint-disable no-restricted-globals */
import type { Config, DeepMap } from '../../dataProcess/type';
import { bitmapToImageData } from '../../dataProcess/bitmapToImageData';
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
  /** Grayscale preview of the image area by actual depth levels (1 byte/pixel). */
  preview: Uint8Array;
  previewWidth: number;
  previewHeight: number;
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

    // Grayscale preview from the actual quantized depth levels (before border):
    // normalize by the configured max thickness; thick = dark, thin = light.
    const previewHeight = deepMap.length;
    const previewWidth = previewHeight > 0 ? deepMap[0].length : 0;
    const preview = new Uint8Array(previewWidth * previewHeight);
    const maxDeepValue = MaxDeep * 100;
    for (let y = 0; y < previewHeight; y++) {
      const row = deepMap[y];
      for (let x = 0; x < previewWidth; x++) {
        const normalized = Math.round((row[x] / maxDeepValue) * 255);
        preview[y * previewWidth + x] = 255 - Math.max(0, Math.min(255, normalized));
      }
    }

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
        preview,
        previewWidth,
        previewHeight,
      },
      [hf.positions.buffer, preview.buffer]
    );
  } catch (err: any) {
    post({ type: 'error', message: err?.message || String(err) });
  }
};

export {};
