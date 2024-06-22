// @ts-nocheck

const fs = require('fs');
const PNG = require('pngjs').PNG;
const imageName = 'DSCF9207.png';
const imageBinaryData = fs.readFileSync('./' + imageName);

/**
 * config
 */

// 最大长边长度 mm
const maxLength = 127; // 该设置在scad中也需要
// 色深级数
const imageDeep = 256;
// 最大深度 (mm)
const maxDeep = 2.5;
// 单层精度深度 (mm)
const layerDeep = 0.08;
// 首层高度
const baseDeep = layerDeep * 2;
// 层数
const layerNumber = Math.floor(maxDeep / layerDeep);
// 单层近似亮度值
const layerLight = imageDeep / layerNumber;
// 是否添加边框  边框不会算在最大长边中
const addBorder = true
// 边框宽度(mm)
const borderWidth = 2
// 边框比最高高度更高多少（mm）
const borderHeightExtra = 1


let maxPrintDeep = 0

let png = new PNG({
  filterType: -1,
}).parse(imageBinaryData);


png.on('parsed', function () {
  let RGBArray = [];
  for (let y = 0; y < png.height; y++) {
    const line = [];
    for (let x = 0; x < png.width; x++) {
      let idx = (this.width * y + x) << 2;

      const r = this.data[idx];
      const g = this.data[idx + 1];
      const b = this.data[idx + 2];
      line.push([r, g, b]);
    }
    RGBArray.push(line);
  }
  const {
    width,
    height,
    // depth,
    // interlace,
    // palette,
    // color,
    // alpha,
    // bpp,
    // colorType, // 输出颜色类型 - 参见常量。0 = 灰度，无 alpha，2 = 彩色，无 alpha，4 = 灰度 & alpha，6 = 彩色 & alpha。默认当前为 6
  } = png;

  // 获取长边
  const longline =width<height? height :width;
  // 获取缩放尺寸
  const scaleMultiple = maxLength / longline;

    const accuracy = longline/layerDeep
  // 尺寸*mm
  console.log({ width, height });
  if (longline>maxLength*20) {
    console.log("分辨率过高，可能会导致生成缓慢或失败");
  }
  // console.log(getLightArray(RGBArray));
  // console.log(getLightArray(RGBArray).length);

  fs.writeFile(
    './DataDeep.dat',
    toDatString(addWidth(toDataDeepMap(getLightArray(RGBArray)),scaleMultiple)),
    (err) => {
      if (err) {
        console.error(err);
      }
      // file written successfully
    }
  );
});

// 根据rgb值获取亮度值
function getLightArray(RGBArray) {
  const lightArray = [];
  for (let index = 0; index < RGBArray.length; index++) {
    const line = RGBArray[index];
    const lineLight = [];
    for (let index = 0; index < line.length; index++) {
      const pixel = line[index];
      lineLight.push(getLight(pixel));
    }
    lightArray.push(lineLight);
  }
  return lightArray;
}

// 转换为层深度
const getDeep = function (light) {
  if (light > imageDeep - 1) {
    light = imageDeep - 1;
  }
  if (light < 0) {
    light = 0;
  }
  const deep = ((layerNumber - Math.round(light / layerLight)) * layerDeep + baseDeep)
  .toFixed(2)
  .toString()
  if (Number(deep)>Number(maxPrintDeep)) {
    maxPrintDeep = deep
  }
  return deep;
};

//转换为像素亮度
function getLight(pixel) {
  const [r, g, b] = pixel;
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

//转换为深度图
function toDataDeepMap(lightArray) {
  return lightArray
    .map((line) => line.map((i) => getDeep(i))).reverse()
}

//转换为深度图
function toDatString(lightArray) {
  return lightArray.map(line => line.join(' ')).join('\n');
}

//添加边框
function addWidth(deepMap,scaleMultiple){
  if (!addBorder) {
    return
  }
  const BorderDeep = (Number(maxPrintDeep)+borderHeightExtra).toFixed(2).toString()
  const boderSize = Math.round(borderWidth/scaleMultiple)
  const Linelength = deepMap[0].length + boderSize*2
  deepMap.map((line) => {
    line.push( ...Array(boderSize).fill(BorderDeep) )
    line.unshift( ...Array(boderSize).fill(BorderDeep) )
  })
  const boderLine = Array(Linelength).fill(BorderDeep)
  deepMap.push( ...Array(boderSize).fill(boderLine) )
  deepMap.unshift( ...Array(boderSize).fill(boderLine) )
  return deepMap
}
