/*
 * @Author: chenguofeng chenguofeng@bytedance.com
 * @Date: 2024-07-20 01:47:08
 * @LastEditors: chenguofeng chenguofeng@bytedance.com
 * @LastEditTime: 2024-07-21 01:57:06
 * @FilePath: \photo2reliefNegativeFilm\src\dataProcess\grayPhoto.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { Config } from "./type";
import {
  getImageRGBList,
  transImageDataList2Map,
  getLightArray,
  toDataDeepMap,
  generateBorder,
  toDatString,
} from "./dataTools";

export async function getgrayPhoto(
  base64: string,
  config: Config,
  setProgress: (n: number) => void,
  setProgressInfo: (n: string) => void,
  setImagePreview: (n: string) => void
): Promise<string> {
  const {
    MaxDeep,
    LayerDeep,
    BaseDeep,
    MaxLength,
    Quality,
    AddBorder,
    BorderWidth,
    BorderHeight,
  } = config;
  setProgressInfo("参数设置");
  setProgress(1);
  // 色深级数
  const imageDeep = 256;
  // 层数
  const layerNumber = Math.floor((MaxDeep - BaseDeep) / LayerDeep) + 1;
  // 单层近似亮度值
  const layerLight = imageDeep / layerNumber;
  // 缓存生成的最大层高
  let maxPrintDeep = { value: 0 };
  setProgress(5);

  setProgressInfo("获取图像数据");
  setProgress(10);
  const imageData = await getImageRGBList(
    base64,
    MaxLength,
    Quality,
    setImagePreview
  );
  // const imageData = {
  //   data: [
  //     255, 255, 255, 255, 117, 117, 117, 255, 40, 40, 40, 255, 12, 12, 55, 255,
  //   ],
  //   height: 4,
  //   width: 1,
  // };

  setProgressInfo("解析像素数据");
  setProgress(20);
  const pixelRGBMap = transImageDataList2Map(imageData);
  //   console.error(pixelRGBMap);

  setProgressInfo("生成明度图");
  setProgress(40);
  const lightMap = getLightArray(pixelRGBMap);

  setProgressInfo("生成深度图");
  setProgress(60);
  const deepMap = toDataDeepMap(
    lightMap,
    imageDeep,
    layerNumber,
    layerLight,
    LayerDeep,
    BaseDeep,
    maxPrintDeep
  );

  setProgressInfo("添加边框");
  setProgress(70);
  const deepMapWithBorder = generateBorder(
    deepMap,
    AddBorder,
    BorderWidth,
    BorderHeight,
    Quality
  );
  //   console.error({ deepMaany as BlobthBorder });

  setProgressInfo("生成DateDeep");
  setProgress(80);
  const dataDeepMapDat = toDatString(deepMapWithBorder);
  //   console.error(dataDeepMapDat);
  return dataDeepMapDat;
  //   return '';
}
