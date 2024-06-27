/*
 * @Author: error: error: git config user.name & please set dead value or install git && error: git config user.email & please set dead value or install git & please set dead value or install git
 * @Date: 2024-06-26 01:13:50
 * @LastEditors: chenguofeng chenguofeng@bytedance.com
 * @LastEditTime: 2024-06-26 21:41:45
 * @FilePath: \photo2reliefNegativeFilm\src\image2DataDeep\image2DataDeep.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { Message } from '@arco-design/web-react';
import fileDownload from 'js-file-download';

interface Config {
  BaseDeep: number;
  LayerDeep: number;
  MaxLength: number;
  MaxDeep: number;
  Quality: number;
  AddBorder: boolean;
  BorderWidth: number;
  BorderHeight: number;
}

export async function getDataDeep(
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
  setProgressInfo('参数设置');
  setProgress(1);
  // 色深级数
  const imageDeep = 256;
  // 层数
  const layerNumber = Math.floor((MaxDeep - BaseDeep) / LayerDeep) + 1;
  // 单层近似亮度值
  const layerLight = imageDeep / layerNumber;
  // 缓存生成的最大层高
  let maxPrintDeep = 0;
  setProgress(5);

  // 获取图像数据
  const getImageRGBList = async function (
    base64: string
  ): Promise<Uint8ClampedArray> {
    return new Promise<Uint8ClampedArray>((resolve, reject) => {
      const canvas = document.createElement('canvas') as any;
      if (!canvas) {
        Message.error('大爷,换个新款浏览器吧,chrome啥的,这浏览器弄不了');
        reject();
      }
      const ctx = canvas!.getContext('2d');
      const img = new Image();
      img.onload = function () {
        const fileWidth = img.width;
        const fileHeight = img.height;

        let zoom = 1;
        if (fileWidth >= fileHeight) {
          zoom = MaxLength / fileWidth;
        } else {
          zoom = MaxLength / fileHeight;
        }

        const finalWidth = zoom * fileWidth * Quality;
        const finalHeight = zoom * fileHeight * Quality;

        canvas.width = finalWidth;
        canvas.height = finalHeight;

        ctx.drawImage(
          img,
          0,
          0,
          fileWidth,
          fileHeight,
          0,
          0,
          canvas.width,
          canvas.height
        );
        setImagePreview(canvas.toDataURL());

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        resolve(imageData);
      };
      img.src = base64;
    });
  };

  // 转换为层深度
  const getDeep = function (light: number) {
    if (light > imageDeep - 1) {
      light = imageDeep - 1;
    }
    if (light < 0) {
      light = 0;
    }
    const deep = (
      (layerNumber - Math.round(light / layerLight)) * LayerDeep +
      BaseDeep
    )
      .toFixed(2)
      .toString();
    if (Number(deep) > Number(maxPrintDeep)) {
      maxPrintDeep = Number(deep);
    }
    return Number(deep);
  };

  //添加边框
  function generateBorder(deepMap: DeepMap) {
    if (!AddBorder) {
      return deepMap;
    }
    const BorderDeep = BorderHeight.toFixed(2).toString();
    const boderSize = BorderWidth * 10;
    const Linelength = deepMap[0].length + boderSize * 2;
    deepMap.map((line) => {
      line.push(...Array(boderSize).fill(BorderDeep));
      line.unshift(...Array(boderSize).fill(BorderDeep));
    });
    const boderLine = Array(Linelength).fill(BorderDeep);
    deepMap.push(...Array(boderSize).fill(boderLine));
    deepMap.unshift(...Array(boderSize).fill(boderLine));
    return deepMap;
  }

  type RGBMap = Array<RGBLines>;
  type RGBLines = Array<RGBPixel>;
  type RGBPixel = [r: number, g: number, b: number];

  type DeepMap = Array<DeepLines>;
  type DeepLines = Array<number>;
  // 根据rgb值获取亮度值
  function getLightArray(RGBArray: RGBMap): DeepMap {
    return RGBArray.map((line) => {
      return line.map((pix) => {
        return getLight(pix);
      });
    });
  }

  //转换为像素亮度
  function getLight(pixel: RGBPixel) {
    const [r, g, b] = pixel;
    return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }

  //转换为深度图
  function toDataDeepMap(lightArray: DeepMap) {
    return (
      lightArray
        .map((line) => line.map((i) => getDeep(i)))
        //深度图生成会是倒着的，在这里正回来
        .reverse()
    );
  }

  //转换为深度图
  function toDatString(lightArray: DeepMap) {
    return lightArray.map((line) => line.join(' ')).join('\n');
  }

  // rgb 转换成cmyk
  //   function RgbToCmyk(R: number, G: number, B: number) {
  //     if (R == 0 && G == 0 && B == 0) {
  //       return [0, 0, 0, 1];
  //     } else {
  //       var calcR = 1 - R / 255,
  //         calcG = 1 - G / 255,
  //         calcB = 1 - B / 255;

  //       var K = Math.min(calcR, Math.min(calcG, calcB)),
  //         C = (calcR - K) / (1 - K),
  //         M = (calcG - K) / (1 - K),
  //         Y = (calcB - K) / (1 - K);

  //       return [C, M, Y, K];
  //     }
  //   }

  const transImageDataList2Map = function (imageData: any) {
    const { width, height, data } = imageData;
    return new Array(height).fill(undefined).map((line, lineIndex) => {
      return new Array(width).fill(undefined).map((pixel, index) => {
        const r = data[(width * lineIndex + index) * 4];
        const g = data[(width * lineIndex + index) * 4 + 1];
        const b = data[(width * lineIndex + index) * 4 + 2];
        const a = (data[(width * lineIndex + index) * 4 + 3] + 1) / 256;
        return [r * a, g * a, b * a] as RGBPixel;
      });
    });
  };
  setProgressInfo('获取图像数据');
  setProgress(10);
  const imageData = await getImageRGBList(base64);
  //   const imageData = {
  //     data: [
  //       255, 255, 255, 255, 117, 117, 117, 255, 40, 40, 40, 255, 12, 12, 55, 255,
  //     ],
  //     height: 4,
  //     width: 1,
  //   };

  setProgressInfo('解析像素数据');
  setProgress(20);
  const pixelRGBMap = transImageDataList2Map(imageData);
  //   console.error(pixelRGBMap);

  setProgressInfo('生成明度图');
  setProgress(40);
  const lightMap = getLightArray(pixelRGBMap);

  setProgressInfo('生成深度图');
  setProgress(60);
  const deepMap = toDataDeepMap(lightMap);

  setProgressInfo('添加边框');
  setProgress(70);
  const deepMapWithBorder = generateBorder(deepMap);
  //   console.error({ deepMapWithBorder });

  setProgressInfo('生成DateDeep');
  setProgress(80);
  const dataDeepMapDat = toDatString(deepMapWithBorder);
  //   console.error(dataDeepMapDat);
  return dataDeepMapDat;
  //   return '';
}

export function getScad(Quality: number): string {
  return `
scale([${1 / Quality}, ${1 / Quality}, 1])
  surface(file = "DataDeep.dat", center = true, invert = false);
`;
}

export function downloadFile(file: string, fileName: string): void {
  console.log('downloadFile', fileName);
  fileDownload(file, fileName);
  //   const blob = new Blob([file]);
  // const downloadFile = new File([file], fileName, { type: 'text/plain' });

  // // 定义触发事件的DOM
  // var aLink = document.createElement('a');
  // // 判定平台
  // var isMac = navigator.userAgent.indexOf('Mac OS') > -1;
  // // 定义事件对象
  // var evt = document.createEvent(isMac ? 'MouseEvents' : 'HTMLEvents');
  // // 初始化事件
  // // evt.initEvent("click", false, false);
  // ((evt as any)[isMac ? 'initMouseEvent' : 'initEvent'] as any)(
  //   'click',
  //   false,
  //   false
  // );
  // // 定义下载文件名称
  // aLink.download = fileName;
  // // 根据上面定义的 BLOB 对象创建文件 dataURL
  // aLink.href = URL.createObjectURL(downloadFile);
  // // 触发事件下载
  // aLink.dispatchEvent(evt);
}
