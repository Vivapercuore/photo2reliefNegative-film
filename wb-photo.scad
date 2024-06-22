// /* [printer Variables] */
// 层高 (mm)
// Floorheight = 0.08;
// 首层高度 (mm)
// FirstFloorheight = 0.16;
// /* [photo Material transparency] */
// 最大深度 (mm) - 请进行测试获得
// maxDeep=50;
/* [photo Variables] */
// 最大长边 (mm) 
maxLength=127;
// 照片宽度 (mm) 
photoWidth=1080;
// 照片高度 (mm) 
photoHeight=1570;

// 文件名
// fileName="DSCF1468-wb-min.png";
longline =photoWidth<photoHeight? photoHeight :photoWidth;

scaleMultiple = maxLength / longline;
/* [Global] */
// test();
// module test(){
// 生成深度
echo(str("scaleMultiple = ", scaleMultiple));
scale([scaleMultiple, scaleMultiple, 1])
  surface(file = "DataDeep.dat", center = true, invert = false);
// }