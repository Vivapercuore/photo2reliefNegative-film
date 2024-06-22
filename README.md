从hueforge得到灵感，但并不是所有人都想要购买这个软件

官方使用的 lithophanemaker 生成分辨率太低


为生成透光浮雕负片提供免费方案，为大家节约18美元



由于makerworld lab中的参数化生成不支持读取文件，所以以这种形式提供

需要安装软件

openScad:  下载地址    https://openscad.org/
nodejs    下载地址    https://nodejs.org/zh-cn
初步处理图片

程序可以处理彩色照片，但生成的负片实物只会是负片，所以推荐转换为黑白查看预览效果，程序不提供预览功能
处理照片尺寸，过大的像素尺寸可能会导致node内存超过限制而失败，建议长边不要超过4000像素
处理照片格式，暂时只支持png格式,保存为png，你可以在 https://jpg2png.com/zh/ 进行格式转换（或其他方式）
下载zip附件包 或从github获取  https://github.com/Vivapercuore/photo2reliefNegative-film/blob/main/README.md 

将你自己的照片放置在目录中，与示例图片同级
在编辑器中打开 image.js

修改 imageName = 'DSCF9622.png'; 中的 DSCF9622.png 为你自己的图片文件名
调整部分参数（或使用默认值）

修改 maxDeep 这会影响负片成品中最深的黑色
修改 layerDeep 设置为你的层高工艺值，请和你的打印机支持的层高严格匹配

更高的 maxDeep 和更低的 layerDeep 将生成更细腻的过渡颜色
修改 addBorder 启用或关闭边框 设置为true启用，设置为false关闭
修改 borderWidth 这会影响边框宽度
修改 borderHeightExtra 这会影响边框高度
请不要调整maxLength，这个参数暂时不能正确生效
其他参数不必太在意，请在bambu studio 中调整实物尺寸
保存文件
在 控制台/cmd/powershell 对应目录中执行 node image.js
在OpenSCAD中，ctrl+O 打开wb-phtot.scad

按键 F5 进行预览（这一步可以完全跳过）
按键 F6 生成模型

等待控制台出现  Rendering finished.  提示  （可能比较慢，中途可能出现软件未响应，请耐心等待）
按键 F7 导出STL文件，并选择目录保存

等待控制台出现 STL export finished. 提示  （可能比较慢，中途可能出现软件未响应，请耐心等待）

在bambu studio中导入stl

bambu studio 可能会提示三角形面片数过多，你可以忽略这个提示，简化模型可能导致生成的照片模糊
修改对应打印工艺
使用白色或其他高透明耗材
必须使用100%充填
无需支撑
打印，等待成品

希望你能喜欢



示例照片是我的猫，他叫寿司，他非常可爱！



彩色方案还在研究中，色阶和色差问题还未解决
