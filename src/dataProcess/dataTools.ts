/*
 * @Author: error: error: git config user.name & please set dead value or install git && error: git config user.email & please set dead value or install git & please set dead value or install git
 * @Date: 2024-06-26 01:13:50
 * @LastEditors: chenguofeng chenguofeng@bytedance.com
 * @LastEditTime: 2024-07-20 21:59:06
 * @FilePath: \photo2reliefNegativeFilm\src\image2DataDeep\image2DataDeep.ts
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import { Message } from "@arco-design/web-react";
import fileDownload from "js-file-download";
import { cloneDeep } from "lodash-es";
import {
  RGBMap,
  // RGBLines,
  RGBPixel,
  CMYKPixel,
  DeepMap,
  // DeepLines,
  CmkydeepMap,
} from "./type";

export const transImageDataList2Map = function (imageData: any) {
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

// 获取图像数据
export const getImageRGBList = async function (
  base64: string,
  MaxLength: number,
  Quality: number,
  setImagePreview: (n: string) => void
): Promise<Uint8ClampedArray> {
  return new Promise<Uint8ClampedArray>((resolve, reject) => {
    const canvas = document.createElement("canvas") as any;
    if (!canvas) {
      Message.error("大爷,换个新款浏览器吧,chrome啥的,这浏览器弄不了");
      reject();
    }
    const ctx = canvas!.getContext("2d");
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

      const finalWidth = zoom * fileWidth * Quality + Quality;
      const finalHeight = zoom * fileHeight * Quality + Quality;

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

//添加边框
export function generateBorder(
  deepMap: DeepMap,
  AddBorder: boolean,
  BorderWidth: number,
  BorderHeight: number,
  Quality: number
) {
  if (!AddBorder) {
    return deepMap;
  }
  const BorderDeep = (BorderHeight * 100).toFixed(2).toString();
  const boderSize = Math.round(BorderWidth * Quality);
  const Linelength = deepMap[0].length + boderSize * 2;
  deepMap.map((line) => {
    line.push(...Array(boderSize).fill(BorderDeep));
    line.unshift(...Array(boderSize).fill(BorderDeep));
    return line;
  });
  const boderLine = Array(Linelength).fill(BorderDeep);
  deepMap.push(...Array(boderSize).fill(boderLine));
  deepMap.unshift(...Array(boderSize).fill(boderLine));
  return deepMap;
}

// 根据rgb值获取亮度值
export function getLightArray(RGBArray: RGBMap): DeepMap {
  return RGBArray.map((line) => {
    return line.map((pix) => {
      return getLight(pix);
    });
  });
}

//转换为像素亮度
export function getLight(pixel: RGBPixel) {
  const [r, g, b] = pixel;
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

//转换为深度图
export function toDataDeepMap(
  lightArray: DeepMap,
  imageDeep: number,
  layerNumber: number,
  layerLight: number,
  LayerDeep: number,
  BaseDeep: number,
  maxPrintDeep: { value: number },
  cmyk: boolean = false,
  deepK = false
) {
  return (
    lightArray
      .map((line) =>
        line.map((i) =>
          getDeep(
            i,
            imageDeep,
            layerNumber,
            layerLight,
            LayerDeep,
            BaseDeep,
            maxPrintDeep,
            cmyk,
            deepK
          )
        )
      )
      //深度图生成会是倒着的，在这里正回来
      .reverse()
  );
}

// 转换为层深度
export const getDeep = function (
  light: number,
  imageDeep: number,
  layerNumber: number,
  layerLight: number,
  LayerDeep: number,
  BaseDeep: number,
  maxPrintDeep: { value: number },
  cmyk: boolean = false,
  deepK = false // addTopAndBottomFace
) {
  if (light > imageDeep - 1) {
    light = imageDeep - 1;
  }
  if (light < 0) {
    light = 0;
  }
  let deep;
  // console.error("getDeep", {layerNumber,LayerDeep,lightdeep:Math.round(light / layerLight)});
  if (cmyk) {
    if (deepK) {
      // 需要根据明度得到负向的深度
      deep = ((layerNumber - Math.round(light / layerLight)) * LayerDeep)
        .toFixed(2)
        .toString();
    } else {
      // 不用管明度，只需要根据自己的颜色深度叠加颜色
      deep = (Math.round(light / layerLight) * LayerDeep).toFixed(2).toString();
    }
  } else {
    deep = (
      (layerNumber - Math.round(light / layerLight)) * LayerDeep +
      BaseDeep -
      LayerDeep
    )
      .toFixed(2)
      .toString();
  }
  if (deepK) {
    // 添加顶面和底面
    deep = (Number(deep) + Number(BaseDeep) + Number(LayerDeep))
      .toFixed(2)
      .toString();
  }
  if (Number(deep) > Number(maxPrintDeep.value)) {
    maxPrintDeep.value = Number(deep);
  }
  // console.error("getDeep", {light, deep,addTopAndBottomFace});
  return Number((Number(deep) * 100).toFixed(2)); // 防止精度问题，放大一百倍，在scad中还原
};

//转换为深度图
export function toDatString(lightArray: DeepMap) {
  return lightArray.map((line) => line.join(" ")).join("\n");
}

export function getCmykList(pixellist: RGBMap, toCmy: boolean = false) {
  return pixellist.map((pixelLine) =>
    pixelLine.map((pixel: [R: number, G: number, B: number]) =>
      RgbaToCmyk(...pixel, toCmy as any)
    )
  );
}
// rgba 转换成cmyk
export function RgbaToCmyk(
  R: number,
  G: number,
  B: number,
  A: number = 1,
  toCmy: boolean = false
): CMYKPixel {
  if (R == 0 && G == 0 && B == 0) {
    return [0, 0, 0, 1];
  } else {
    var calcR = 1 - R / 255,
      calcG = 1 - G / 255,
      calcB = 1 - B / 255;

    var K = Math.min(calcR, Math.min(calcG, calcB)),
      C = (calcR - K) / (1 - K),
      M = (calcG - K) / (1 - K),
      Y = (calcB - K) / (1 - K);
    if (toCmy) {
      return [...CmykToCmy(C, M, Y, K), 0];
    } else {
      return [C, M, Y, K];
    }
  }
}

// cmky 转换成 cmy
export function CmykToCmy(
  C: number,
  M: number,
  Y: number,
  K: number
): RGBPixel {
  return [C + K, M + K, Y + K];
}

export function getCMYKHeightArray(
  cmykMap: Array<Array<CMYKPixel>>,
  gray: { c: number; m: number; y: number; k: number }
): CmkydeepMap {
  const width = cmykMap[0].length;
  const height = cmykMap.length;
  const cmykHeightMap = {
    c: new Array(height).fill(0).map((i) => new Array(width).fill(0)),
    m: new Array(height).fill(0).map((i) => new Array(width).fill(0)),
    y: new Array(height).fill(0).map((i) => new Array(width).fill(0)),
    k: new Array(height).fill(0).map((i) => new Array(width).fill(0)),
  } as CmkydeepMap;
  let grayC = gray.c;
  let grayM = gray.m;
  let grayY = gray.y;
  // const maxGray = Math.max(grayC,grayM,grayY)
  // if(maxGray>1){
  //   const grayCoefficient = 1/maxGray
  //   grayC = grayC*grayCoefficient
  //   grayM = grayM*grayCoefficient
  //   grayY = grayY*grayCoefficient
  // }  // 确保最终每个light的height系数值低于k

  // // 此处得到的k值是cmy叠加得到的明度厚度，需要用全局明度得到真正的K高度
  // for (let line = 0; line < cmykMap.length; line++) {
  //   const cmykline = cmykMap[line];
  //   for (let index = 0; index < cmykline.length; index++) {
  //     const cmykpixel = cmykline[index];
  //     cmykHeightMap.c[line][index] = cmykpixel[0] * 100;
  //     cmykHeightMap.m[line][index] = (cmykpixel[1] + cmykpixel[0]) * 100;
  //     cmykHeightMap.y[line][index] =
  //       (cmykpixel[2] + cmykpixel[1] + cmykpixel[0]) * 100;
  //     cmykHeightMap.k[line][index] =
  //       ( cmykpixel[2]*grayY + cmykpixel[1]*grayM + cmykpixel[0]*grayC) * 100;
  //   }
  // }

  // 使用gray明度系数对色值高度进行修正
  for (let line = 0; line < cmykMap.length; line++) {
    const cmykline = cmykMap[line];
    for (let index = 0; index < cmykline.length; index++) {
      const cmykpixel = cmykline[index];
      cmykHeightMap.c[line][index] = cmykpixel[0] * 100 * grayC;
      cmykHeightMap.m[line][index] =
        (cmykpixel[1] + cmykpixel[0]) * 100 * grayM;
      cmykHeightMap.y[line][index] =
        (cmykpixel[2] + cmykpixel[1] + cmykpixel[0]) * 100 * grayY;
      cmykHeightMap.k[line][index] =
        (cmykpixel[2] * grayY + cmykpixel[1] * grayM + cmykpixel[0] * grayC) *
        100;
    }
  }

  return cmykHeightMap;
  //逐级叠加厚度，然后对模型进行布尔运算
}

export function getfinalHeightArray(cmykMap: CmkydeepMap, lightmap: DeepMap) {
  const cmy = cloneDeep(cmykMap.k);
  // 合成最终k层高度
  cmykMap.k = lightmap.map((line, lineIndex) => {
    return line.map((pix, index) => {
      const cmydeep = cmy[lineIndex][index]; // cmy 的掩蔽高度
      const yheight = cmykMap.y[lineIndex][index]; // cmy层的物理叠加高度
      //yheight一定高于cmydeep
      //获得明度差值
      const kdeep = pix - cmydeep;
      // console.log({pix,cmydeep,yheight,kdeep})
      // 物理叠加k
      return kdeep + yheight;
    });
  });
  return cmykMap;
}

export function getScad(Quality: number): string {
  return `
scale([${1 / Quality}, ${1 / Quality}, 0.01])
  surface(file = "DataDeep.dat", center = true, invert = false);
`;
}

export function downloadFile(file: string | Blob, fileName: string): void {
  console.log("downloadFile", fileName);
  fileDownload(file, fileName);
}
