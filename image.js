// @ts-nocheck

//此处修改文件名 包括后缀,支持jpg和png
const imageName = 'example.cat.png';

/**
 * config 参数配置
 */

//----------必需设置的参数-------start
// 设置宽 mm 打印成品的尺寸得长边长度 (不含边框)
const MaxLength = 127;
// 最大深度 (mm) 决定最黑的地方有多黑,使用默认值,或者打印测试标定进行测试
const maxDeep = 2.5;
// 单层精度深度 (mm)  与打印机工艺设置中的层高严格一致
const layerDeep = 0.06;
// 首层高度 (mm)   与打印机工艺设置中的首层层高严格一致
const baseDeep = 0.1;
//----------必需设置的参数-------end

// 是否添加边框  边框不会算在最大长边中  true 添加  false 不添加
const addBorder = true;

//-----false的话不用管
// 边框宽度(mm)
const borderWidth = 2;
// 边框比最高高度更高多少（mm）
const borderHeightExtra = 1;

//--------下面的参数都不用管---------
// 色深级数
const imageDeep = 256;
// 层数
const layerNumber = Math.floor(maxDeep / layerDeep);
// 单层近似亮度值
const layerLight = imageDeep / layerNumber;

//--------------------------------不用管,不要动-----------------------------------------

const fs = require('fs');
const PNG = require('pngjs').PNG;
const IMAGES = require('images');

// 图片尺寸调整
const imageFile = IMAGES('./' + imageName);
const fileWidth = imageFile.width();
const fileHeight = imageFile.height();
if (!MaxLength) {
  console.log(
    '没有设置 MaxLength ,会按照像素大小进行打印,过高的像素会导致文件巨大和处理缓慢!'
  );
}
if (fileWidth >= fileHeight) {
  imageFile.resize(MaxLength * 10, 0);
} else {
  imageFile.resize(0, MaxLength * 10);
}
imageFile.save('temp.png');
console.log('图片尺寸调整完成');
// 图片尺寸调整

// 像素数据处理
const imageBinaryData = fs.readFileSync('./temp.png');
// 缓存生成的最大层高
let maxPrintDeep = 0;
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
  const { width, height } = png;
  console.log(`图片尺寸:${width} * ${height}`);
  const DataDeepMap = generateBorder(toDataDeepMap(getLightArray(RGBArray)));
  console.log(`打印尺寸:${DataDeepMap[0].length} * ${DataDeepMap.length}`);
  const dataDeepMapDat = toDatString(DataDeepMap);

  fs.writeFile('./DataDeep.dat', dataDeepMapDat, (err) => {
    if (err) {
      console.error('深度图文件写入错误', err);
    } else {
      console.log('深度图文件写入成功,请打开OpenSCAD进行下一步操作');
    }
    // file written successfully
  });
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
  const deep = (
    (layerNumber - Math.round(light / layerLight)) * layerDeep +
    baseDeep
  )
    .toFixed(2)
    .toString();
  if (Number(deep) > Number(maxPrintDeep)) {
    maxPrintDeep = deep;
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
  return lightArray.map((line) => line.map((i) => getDeep(i))).reverse();
}

//转换为深度图
function toDatString(lightArray) {
  return lightArray.map((line) => line.join(' ')).join('\n');
}

//添加边框
function generateBorder(deepMap) {
  if (!addBorder) {
    return;
  }
  const BorderDeep = (Number(maxPrintDeep) + borderHeightExtra)
    .toFixed(2)
    .toString();
  const boderSize = borderWidth * 10;
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
