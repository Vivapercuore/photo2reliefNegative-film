# 多色正片 ColorPositive — 设计文档

日期：2026-07-16
状态：已与用户确认（色板来源 / 成色原理 / 默认排序 / 实现方案 / 六节设计均已逐项批准）

## 1. 目标

新增工作台页「多色正片 ColorPositive」：将图片量化为 n 个纯色（自动提取为默认、用户可完全自定义），生成 HueForge 风格的分层彩色模型——**不同高度代表不同颜色**——3D 预览中直观展示高度区间与颜色的对应关系，最终导出**单一整体**的 3MF，通过**分层换色**（AMS 自动换色，或暂停手动换料以支持无 AMS 用户）实现多色打印。

已确认的关键决策：

| 决策点 | 结论 |
|---|---|
| 色板来源 | 自动提取（median-cut）为默认 + 用户可增删改色、改 n 值、取色器编辑 |
| 成色原理 | 纯色台阶模型（不透光、不混色），非透光混色 HueForge |
| 默认排序 | 按亮度暗→亮（暗色在底、亮色在顶），用户可拖拽重排 |
| 实现方案 | 方案 A：单体水密高度场 + custom_gcode_per_layer 分层换色 |

## 2. 模块定位与文件结构

- 名称：**多色正片 · ColorPositive**（DESIGN.md §8 规划中的页面，与浮雕「负片」相对）
- 路由：`/photo2color`；目录：`src/colorPositive/`
- 注册三步：`src/App.tsx` 加路由、`src/Home.tsx` 加 feature 卡片（currentColor 线稿 SVG 图标）、页内 `<PageNav>` + `useDocumentTitle('多色正片')`

```
src/colorPositive/
  ColorPositive.tsx      页面组件：参数编排、worker 调度、导出（仿 src/relief/Relief.tsx）
  ColorPositive.css      LUMEN 页面样式
  PaletteBands.tsx       色带图例编辑器（拖拽排序 / 取色 / 层数 / 高度区间显示）
  quantize.ts            纯函数：median-cut 自动提色 + 最近色标签图（DOM-free）
  bands.ts               纯函数：色带高度表、换色层 PauseLayer 计算（DOM-free）
  heightShader.ts        按世界 z 着色的 Three.js 材质
  worker/color.worker.ts 两级计算 Web Worker
public/bambu/color/      新切片模板（从 public/bambu/relief/default 复制调整，多料槽由 filaments 选项动态扩表）
```

**复用（不重写）**：

- `src/imageEdit/CropEditor.tsx` + `renderEdited`（裁剪，不调色，传恒等 ColorAdjust，同 Relief 用法）
- `src/relief/buildHeightfield.ts`（水密高度场：顶面 + 平底 + 四周墙，Y-up；跨模块 import，`laser/viewer` 已有共享先例；继承成品尺寸 0.2mm 修正）
- `src/laser/viewer/ModelViewer.tsx`（共享 WebGLRenderer、按需渲染）
- `bambu-3mf`：`pack3mf` / `makeThumbnails` / `PauseLayer` / `filaments`（现有 0.1.0 API 已满足全部需求，无需改包）

## 3. 计算管线（两级 Worker）

```
上传 → CropEditor 裁剪 → renderEdited → ImageBitmap ──(350ms debounce, lodash-es)──▶ Worker

Worker 量化级（改色板/n/裁剪/质量/换图时重跑）
  1. OffscreenCanvas 缩放到工作分辨率（quality px/mm，长边像素 cap 4096，同 relief）
  2. 自动模式：median-cut 提取 n 色（确定性算法，无随机种子，无抖动）
  3. 逐像素最近色分配（sRGB 欧氏距离，色距函数独立可替换）→ labelMap: Uint8Array
  4. 输出：labelMap（worker 内缓存）、各色占比、量化 2D 预览 ImageData（Transferable）

Worker 几何级（改顺序/各色层数/层高/底板层数时单独重跑，毫秒级）
  5. label → 色带顶面高度（mm×100 DeepMap 单元格式，与 relief 一致）
  6. 复用 buildHeightfield → 水密非索引 Float32Array positions（Transferable）
```

- 消息协议仿 `relief.worker.ts`：`Request / Progress / Done / Error`；几何级请求带 `reuseLabelMap: true` 标志
- 防陈旧结果：沿用 Relief 的 `imgElRef` 置空 + done 时校验丢弃、`runWorker.cancel()` 模式
- 透明像素按白底合成，成品始终为矩形版画
- 用户手动改过色板后进入「自定义」状态：换图/改 n 不再自动覆盖，需点「重新提取」显式覆盖

**3D 预览着色**：单 mesh + 按世界 z 着色的 ShaderMaterial（uniforms：`bandTopZ[n]`、`bandColor[n]`，片元按 z 落入的色带取纯色 + 简单朗伯光照）。顶面与台阶侧壁的颜色都严格由高度决定，**预览语义 = 打印语义**（侧壁在换色边界 z 处颜色突变，与实物一致）。改层数/顺序时几何与 uniforms 同步更新。

## 4. UI 布局与交互（LUMEN 工作台骨架）

左参数面板 + 右 `.lx-viewport`，≤900px 面板上/视口下折叠。遵守 DESIGN.md：`.lx-panel` / `.lx-eyebrow`（中文 + 英文 code 眉标）/ `.lx-data`（一切数字 JetBrains Mono）/ 方形滑杆手柄 / 光谱渐变五处限定 / `prefers-reduced-motion`。

面板分区（自上而下）：

1. **图片 IMAGE**：DropZone 上传（Arco Upload autoUpload=false）、CropEditor、长边尺寸 mm
2. **色板 PALETTE**：颜色数 n stepper（2–8）、「重新提取」按钮；主体为**垂直色带图例编辑器 PaletteBands**——同时就是「高度-颜色对照图例」：
   - 行序从上到下 = 模型从顶到底（默认亮上暗下）
   - 每行：拖拽手柄（重排）｜色块（点击弹取色器）｜HEX（`.lx-data`）｜画面占比 %｜层数 stepper｜高度区间 `a.aa–b.bb mm`（只读实时换算）
3. **模型 MODEL**：层高 select（0.08/0.12/0.16/0.20）、底板层数 stepper、质量 quality
4. **打印 PRINT**：换色方式 Radio「AMS 自动换色 / 暂停手动换料」、「导出 3MF」主按钮

右视口：ModelViewer + `.lx-viewport-hud`（成品 W×D×总高 mm、换色次数、三角面数）；视口左下角小幅量化 2D 预览图供与原图对照。共享编辑控件保持「松手才 commit」惯例，参数变更经 350ms debounce 触发 worker。

空态：`.lx-empty` 邀请动作文案。

## 5. 3MF 导出与换色

单对象导出：`pack3mf('color', [{ name: 'color-positive', geometry }], undefined, options)`。

- `options.filaments`：n 色 hex 数组（底→顶 = 料槽 1..n）；包自动扩展 per-filament 数组并缩放冲刷矩阵
- `options.plates[0].pauses`（或顶层 `pauses`）：每个色带边界一条 `PauseLayer`，共 **n−1** 条
  - AMS 模式：`{ type: 2, extruder: 槽号(2..n), color }` → 切片器自动换色
  - 暂停模式：`{ type: 1, gcode: 'M400 U1', color }` → 停机等待手动换料（`color` 字段供 Studio 时间轴显示目标色）
- **「每色高度」以层数为单位**（非 mm）：`z = 首层层高 + (累计层数 − 1) × 层高` 推导，换色精确落在层边界（规避 mm 不对齐层高的坑）；UI 同步显示换算 mm。`atZ` 的确切语义（README：在高度 H 之上换须传 H+layer_height）在 `bands.ts` 实现并以单测锁定
- 最底色带 = 料槽 1（开机装载，无第 0 次换色）；底板层数并入最底色带（同色连续）
- `projectSettingsOverrides { layer_height, initial_layer_print_height }` + `markModified`；缩略图 `makeThumbnails(量化预览 dataURL)`；盘 1

## 6. 默认参数

| 参数 | 默认 | 范围/选项 |
|---|---|---|
| 颜色数 n | 4 | 2–8 |
| 层高 | 0.20 mm | 0.08 / 0.12 / 0.16 / 0.20 |
| 首层层高 | 0.20 mm | 随模板 |
| 每色带层数 | 3 | 1–50 |
| 底板层数 | 3（与最底色同色） | 1–50 |
| 长边尺寸 | 127 mm | 同 relief |
| 质量 | 5 px/mm | 同 relief |
| 颜色排序 | 亮度暗→亮（底→顶） | 拖拽任意重排 |
| 换色方式 | AMS 自动换色 | 可切「暂停手动」 |

默认成品：3 + 4×3 = 15 层 ≈ 3.0 mm 总高。

## 7. 错误处理

- **删除图片必须清空全部派生状态与 worker 缓存**（labelMap、色板自动值、几何、预览）——吸取 relief upload-reset bug（commit f4f27e3）教训；换新图重新自动提色
- n>4 且 AMS 模式：提示「需多个 AMS 或切换暂停模式」（不阻断导出）；AMS 模式 extruder 上限 16
- worker 异常 → 主线程 Arco `Message.error`；陈旧结果按 §3 机制丢弃
- 大图：长边像素 cap 4096（OffscreenCanvas 缩放）

## 8. 测试

- **jest 单测**（纯函数，DOM-free）：
  - `quantize.ts`：median-cut 确定性（同输入同输出）、最近色分配正确性、占比统计
  - `bands.ts`：层边界 z 计算（含首层层高特例）、PauseLayer 数组（数量 n−1、type/extruder/atZ、两种模式）
- `npx tsc --noEmit` 提交前必过（DESIGN.md 铁律）
- 人工验收：上传→调参（改色/重排/改层数实时响应）→导出 3MF→Bambu Studio 打开确认换色时间轴、颜色、暂停行为、成品尺寸

## 9. 明确不做（YAGNI）

- 透光混色（真 HueForge TD 模拟）——数据结构上「颜色↔层区间」已抽象，留将来扩展
- 每色一实体 + assembleAsOne 导出模式（方案 B）
- 抖动（dithering）——用户明确要求确定性量化
- STL 导出、i18n、全局状态管理
