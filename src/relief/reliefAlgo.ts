/**
 * DOM-free relief depth algorithm, ported verbatim from
 * src/dataProcess/dataTools.ts so it can run inside a Web Worker.
 *
 * dataTools.ts imports arco `Message` and `js-file-download` at module top
 * level, which touch the DOM and cannot be evaluated in a worker — hence this
 * standalone copy of just the pure numeric functions. Keep the math in sync
 * with dataTools.ts if that ever changes.
 */
import type { RGBMap, RGBPixel, DeepMap } from '../dataProcess/type';

/** ImageData → RGB map (premultiplied alpha, matches dataTools). */
export function transImageDataList2Map(imageData: {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}): RGBMap {
  const { width, height, data } = imageData;
  return new Array(height).fill(undefined).map((_line, lineIndex) =>
    new Array(width).fill(undefined).map((_pixel, index) => {
      const r = data[(width * lineIndex + index) * 4];
      const g = data[(width * lineIndex + index) * 4 + 1];
      const b = data[(width * lineIndex + index) * 4 + 2];
      const a = (data[(width * lineIndex + index) * 4 + 3] + 1) / 256;
      return [r * a, g * a, b * a] as RGBPixel;
    })
  );
}

/** Pixel luminance. */
export function getLight(pixel: RGBPixel): number {
  const [r, g, b] = pixel;
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

export function getLightArray(rgb: RGBMap): DeepMap {
  return rgb.map((line) => line.map((pix) => getLight(pix)));
}

/** Per-pixel layer depth (negative-film logic), matches dataTools.getDeep. */
export function getDeep(
  light: number,
  imageDeep: number,
  layerNumber: number,
  layerLight: number,
  LayerDeep: number,
  BaseDeep: number,
  maxPrintDeep: { value: number },
  PreventWhiteHollow = false
): number {
  if (light > imageDeep - 1) light = imageDeep - 1;
  if (light < 0) light = 0;
  let deep = (
    (layerNumber - Math.round(light / layerLight)) * LayerDeep +
    BaseDeep -
    LayerDeep
  )
    .toFixed(2)
    .toString();
  if (PreventWhiteHollow) {
    deep = (Number(deep) + LayerDeep).toFixed(2).toString();
  }
  if (Number(deep) > Number(maxPrintDeep.value)) {
    maxPrintDeep.value = Number(deep);
  }
  return Number((Number(deep) * 100).toFixed(2)); // ×100 to dodge float error
}

/** Luminance map → depth map (×100), Y-flipped to match dataTools. */
export function toDataDeepMap(
  lightArray: DeepMap,
  imageDeep: number,
  layerNumber: number,
  layerLight: number,
  LayerDeep: number,
  BaseDeep: number,
  maxPrintDeep: { value: number },
  PreventWhiteHollow = false
): DeepMap {
  return lightArray
    .map((line) =>
      line.map((i) =>
        getDeep(i, imageDeep, layerNumber, layerLight, LayerDeep, BaseDeep, maxPrintDeep, PreventWhiteHollow)
      )
    )
    .reverse();
}

/** Add a border frame around the depth map (matches dataTools). */
export function generateBorder(
  deepMap: DeepMap,
  AddBorder: boolean,
  BorderWidth: number,
  BorderHeight: number,
  Quality: number
): DeepMap {
  if (!AddBorder) return deepMap;
  const BorderDeep = Number((BorderHeight * 100).toFixed(2));
  const borderSize = Math.round(BorderWidth * Quality);
  const lineLength = deepMap[0].length + borderSize * 2;
  deepMap.forEach((line) => {
    for (let i = 0; i < borderSize; i++) {
      line.push(BorderDeep);
      line.unshift(BorderDeep);
    }
  });
  const borderLine = () => new Array(lineLength).fill(BorderDeep);
  for (let i = 0; i < borderSize; i++) {
    deepMap.push(borderLine());
    deepMap.unshift(borderLine());
  }
  return deepMap;
}
