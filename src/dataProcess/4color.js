import Jimp from 'jimp';
import kMeans from 'kmeans-js';
import ColorThief from 'colorthief';

const INPUT_IMAGE = 'imagePath';

(async function main() {
  await genByKmeans();
  await genByColorThief();
})();

async function genByKmeans() {
  const image = await Jimp.read(INPUT_IMAGE);
  const colors = await getColorsByKmeans(image);

  // 遍历图片的所有像素
  image
    .pixelate(0.4)
    .scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
      const red = this.bitmap.data[idx + 0];
      const green = this.bitmap.data[idx + 1];
      const blue = this.bitmap.data[idx + 2];

      // 找到与当前像素颜色最接近的主色调颜色
      let closestColor = colors[0];
      let closestDistance = Infinity;

      colors.forEach((color) => {
        const distance = Math.sqrt(
          Math.pow(color[0] - red, 2) +
            Math.pow(color[1] - green, 2) +
            Math.pow(color[2] - blue, 2)
        );
        if (distance < closestDistance) {
          closestDistance = distance;
          closestColor = color;
        }
      });

      // 替换像素颜色
      this.bitmap.data[idx + 0] = closestColor[0];
      this.bitmap.data[idx + 1] = closestColor[1];
      this.bitmap.data[idx + 2] = closestColor[2];
    });
  // 保存新的图片
  image.write('output-kmeans.png');
}
async function genByColorThief() {
  const image = await Jimp.read(INPUT_IMAGE);
  const colors = await ColorThief.getPalette('input.png', 4);
  // 遍历图片的所有像素
  image
    .pixelate(0.4)
    .scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
      const red = this.bitmap.data[idx + 0];
      const green = this.bitmap.data[idx + 1];
      const blue = this.bitmap.data[idx + 2];

      // 找到与当前像素颜色最接近的主色调颜色
      let closestColor = colors[0];
      let closestDistance = Infinity;

      colors.forEach((color) => {
        const distance = Math.sqrt(
          Math.pow(color[0] - red, 2) +
            Math.pow(color[1] - green, 2) +
            Math.pow(color[2] - blue, 2)
        );
        if (distance < closestDistance) {
          closestDistance = distance;
          closestColor = color;
        }
      });

      // 替换像素颜色
      this.bitmap.data[idx + 0] = closestColor[0];
      this.bitmap.data[idx + 1] = closestColor[1];
      this.bitmap.data[idx + 2] = closestColor[2];
    });
  // 保存新的图片
  image.write('output-thief.png');
}

const getColorsByKmeans = async (image) => {
  const pixels = [];
  // 获取图像的像素点
  image.scan(
    0,
    0,
    image.bitmap.width,
    image.bitmap.height,
    function (x, y, idx) {
      const red = this.bitmap.data[idx + 0];
      const green = this.bitmap.data[idx + 1];
      const blue = this.bitmap.data[idx + 2];
      pixels.push([red, green, blue]);
    }
  );
  // 使用kmeans聚类算法将像素点分成4类
  var km = new kMeans({
    K: 4,
  });
  km.cluster(pixels);
  while (km.step()) {
    km.findClosestCentroids();
    km.moveCentroids();
    if (km.hasConverged()) break;
  }

  // 获取4个中心点的颜色
  // const colors = km.centroids.map((centroid) => {
  //   return Jimp.rgbaToInt(centroid[0], centroid[1], centroid[2], 255)
  // })
  return km.centroids;
};
