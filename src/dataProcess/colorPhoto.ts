
import { Config } from "./type";

import {
  getImageRGBList,
  transImageDataList2Map,
  getLightArray,
  toDataDeepMap,
  generateBorder,
  toDatString,
  getCmykList,
  getCMYKHeightArray,
  getfinalHeightArray,
} from "./dataTools";

// 材料系数
//cmy 必须比k 小
const banbuGray = {
  c: 0.2,
  m: 0.45,
  y: 0.95,
  k: 1,
};

const r3dGray = {
  c: 0.2,
  m: 0.25,
  y: 0.45,
  k: 1,
};

export async function getColorPhoto(
  base64: string,
  config: Config,
  setProgress: (n: number) => void,
  setProgressInfo: (n: string) => void,
  setImagePreview: (n: string) => void
) {
  console.log("cmyk");

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

  //  材料系数
  const gray = r3dGray;

  setProgressInfo("参数设置");
  setProgress(1);
  // 色深级数
  const imageDeep = 200; //   0-1 扩张到0-100 cmy&cmyk 叠加后 最多产生200个层级
  // 可用分层高度，需要在底面和顶面各留一层，合成时抬升并附加
  const useableDeep = MaxDeep - BaseDeep - LayerDeep;
  // 层数，
  const layerNumber = Math.floor(useableDeep / LayerDeep);
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
  //     255, 255, 255, 255,  //
  //     128, 64, 32, 255, //
  //      117, 13, 255, 255, //
  //      0, 0, 0, 255, //
  //   ],
  //   height: 4,
  //   width: 1,
  // };

  setProgressInfo("解析像素数据");
  setProgress(20);
  const pixelRGBMap = transImageDataList2Map(imageData);

  //获取rgb明度图
  setProgressInfo("生成明度图");
  setProgress(25);
  const lightMap = getLightArray(pixelRGBMap);

  setProgressInfo("转换彩色像素");
  setProgress(30);
  const pixelCMYKMap = getCmykList(pixelRGBMap, true); // 是否使用cmy方案

  // console.error({pixelCMYKMap})

  setProgressInfo("生成分色明度图");
  setProgress(40);
  const CMYKHeightMap = getCMYKHeightArray(pixelCMYKMap, gray);
  //减去k值得到白色覆盖值
  const finalCMYKHeightMap = getfinalHeightArray(CMYKHeightMap, lightMap);
  //预留底面

  // console.error("finalCMYKHeightMap", finalCMYKHeightMap.k);

  setProgressInfo("生成深度图");
  setProgress(60);
  const deepMapC = toDataDeepMap(
    finalCMYKHeightMap.c,
    imageDeep / 2, //单色只有 100的色深层级
    layerNumber,
    layerLight,
    LayerDeep,
    BaseDeep,
    maxPrintDeep,
    true,
    false
  );
  const deepMapM = toDataDeepMap(
    finalCMYKHeightMap.m,
    imageDeep / 2, //单色只有 100的色深层级
    layerNumber,
    layerLight,
    LayerDeep,
    BaseDeep,
    maxPrintDeep,
    true,
    false
  );
  const deepMapY = toDataDeepMap(
    finalCMYKHeightMap.y,
    imageDeep / 2, //单色只有 100的色深层级
    layerNumber,
    layerLight,
    LayerDeep,
    BaseDeep,
    maxPrintDeep,
    true,
    false
  );
  const deepMapK = toDataDeepMap(
    finalCMYKHeightMap.k,
    imageDeep / 2, //单色只有 100的色深层级
    layerNumber,
    layerLight,
    LayerDeep,
    BaseDeep,
    maxPrintDeep,
    true,
    true
  );

  // console.error("deepMapK", deepMapK);
  // console.error("deepMapK", deepMapK.flat(2).sort());

  setProgressInfo("添加边框");
  setProgress(70);
  const deepMapWithBorderC = generateBorder(
    deepMapC,
    AddBorder,
    BorderWidth,
    0,
    Quality
  );
  const deepMapWithBorderM = generateBorder(
    deepMapM,
    AddBorder,
    BorderWidth,
    0,
    Quality
  );
  const deepMapWithBorderY = generateBorder(
    deepMapY,
    AddBorder,
    BorderWidth,
    0,
    Quality
  );
  const deepMapWithBorderK = generateBorder(
    deepMapK,
    AddBorder,
    BorderWidth,
    BorderHeight,
    Quality
  );

  // console.error(deepMapWithBorderK);

  setProgressInfo("生成DateDeep");
  setProgress(80);
  const dataDeepMapDatC = toDatString(deepMapWithBorderC);
  const dataDeepMapDatM = toDatString(deepMapWithBorderM);
  const dataDeepMapDatY = toDatString(deepMapWithBorderY);
  const dataDeepMapDatK = toDatString(deepMapWithBorderK);
  return {
    dataDeepMapDatC,
    dataDeepMapDatM,
    dataDeepMapDatY,
    dataDeepMapDatK,
  };
}
