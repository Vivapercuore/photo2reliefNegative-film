# LUMEN「透光」设计语言规范

> 本文档是全站视觉重构的**唯一契约**。所有执行 agent 必须先读完本文档再动手。
> 主题：光穿过材料（Light through matter）。本产品把照片变成"靠厚度与分色控制光"的实体
> （浮雕负片 / 透光画 / 激光模型），界面本身也要像一块被背光点亮的工程面板。

## 0. 硬性约束（违反即失败）

1. **只改表现层**：不得修改任何业务逻辑、算法、state、effect、事件处理的行为；JSX 结构可为布局调整而重排，但功能行为必须一致。
2. **不得触碰自己文件清单之外的文件**（各任务的清单在派发 prompt 里）。
3. 保持 Arco Design 组件库（行为层），视觉通过 `src/theme/` 全局覆盖 + 页面局部 CSS 实现。
4. 禁止：扫描线、glitch 故障风、CRT 噪点、大面积霓虹光晕、无节制的渐变。光谱渐变只允许出现在 §4 列出的位置。
5. 动效必须尊重 `prefers-reduced-motion: reduce`（全局已由 tokens.css 处理，页面内自定义动画也要遵守）。
6. 中文是第一语言，英文/代码眉标只作技术点缀（小号、letterspacing）。
7. 完成后运行 `npx tsc --noEmit` 确保类型通过（不必跑完整 build，集成阶段统一 build）。

## 1. 色板（tokens.css 中以 CSS 变量实现，前缀 `--lx-`）

| Token | 值 | 用途 |
|---|---|---|
| `--lx-bg-0` | `#05070D` | 页面最底（深空蓝黑，非纯黑） |
| `--lx-bg-1` | `#0A0F1A` | 3D 视口 / 画布凹陷区 |
| `--lx-bg-2` | `#101625` | 面板表面 |
| `--lx-bg-3` | `#161D30` | 悬浮 / hover 抬升面 |
| `--lx-line` | `#1E2740` | 发丝分割线 / 边框 |
| `--lx-line-bright` | `#2A3556` | hover 边框 / 强调分割 |
| `--lx-text-1` | `#E6ECF8` | 主文字 |
| `--lx-text-2` | `#9AA4C0` | 次要文字 |
| `--lx-text-3` | `#5D688A` | 弱文字 / 占位 |
| `--lx-cyan` | `#3FD8F0` | 主交互色（Arco primary） |
| `--lx-violet` | `#8B7CFF` | 光谱中段（仅渐变用） |
| `--lx-magenta` | `#E86BFF` | 光谱末端（仅渐变/次强调） |
| `--lx-backlight` | `#FFD9A3` | 暖背光（点睛，见 §4） |
| `--lx-ok` | `#53E29B` | 成功 |
| `--lx-warn` | `#FFC24D` | 警告 |
| `--lx-danger` | `#FF6B7A` | 危险 |

光谱渐变（唯一定义，勿另造）：
`--lx-spectrum: linear-gradient(90deg, #3FD8F0 0%, #8B7CFF 55%, #E86BFF 100%);`

暖背光辉光（唯一定义）：
`--lx-backlight-glow: 0 0 24px rgba(255, 190, 110, 0.22);`

## 2. 字体

- 展示（拉丁）：**Space Grotesk**（`@fontsource/space-grotesk`，权重 500/700）——页面标题、品牌、按钮。
- 数据（等宽）：**JetBrains Mono**（`@fontsource/jetbrains-mono`，权重 400/600）——**一切数字**：毫米尺寸、参数值、表格数字、Tag 里的规格、眉标代码。
- 中文：系统栈 `"PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", sans-serif`。
- 字体栈变量：`--lx-font-display`（Space Grotesk + 中文栈）、`--lx-font-body`（系统 + 中文栈）、`--lx-font-mono`（JetBrains Mono + 中文栈）。
- 基准字号 14px（body），行高 1.6。眉标 11px / letterspacing 0.12em / 大写。页面标题 15–16px / 600。

## 3. 形状 / 空间 / 动效

- 圆角：控件 4px，面板与卡片 8px，Tag 2px。方形滑杆手柄（radius 2px）是刻意的技术签名。
- 间距 4px 网格；面板内边距 16px；分区间距 20–24px。
- 动效缓动 `--lx-ease: cubic-bezier(.22,.61,.36,1)`；时长 token：140ms（hover）/ 220ms（状态）/ 360ms（入场）。
- 滚动条：全局细滚动条（8px，thumb `#232D4A`，hover `#2F3B60`）。**恢复可见**（旧代码全局隐藏了滚动条，属于可用性缺陷）。
- 焦点：`:focus-visible { outline: 1px solid var(--lx-cyan); outline-offset: 2px; }`。

## 4. 签名元素与"光谱预算"（克制是纪律）

光谱渐变 `--lx-spectrum` **只允许**出现在：
1. PageNav 底部 1px 发丝线；
2. Slider 已填充轨道 / Progress 进度条；
3. 主按钮 hover 时的顶部 1px 高光线；
4. 主页 hero 标题下划线 / 一处 hero 装饰;
5. 拖拽文件悬停在 DropZone 上时的边框。

暖背光 `--lx-backlight` **只允许**出现在：
1. 主页卡片 hover 时图标的点亮辉光（"背光打开"）；
2. 空状态插画的微弱径向光晕；
3. 与"光/透光"直接相关的图标细节。

面板"边缘导光"效果（`.lx-panel` 内置）：顶部 1px 亮边 + 从顶部渗入的极淡冷光渐变，像被侧面打光的亚克力板。**不用彩色**，用中性蓝白 `rgba(190,215,255,.05)`。

3D 视口 HUD 括角（`.lx-viewport` 内置）：容器四角出现 12px 细括角（1px，`--lx-line-bright`，hover 变 `--lx-cyan`），像相机取景器。克制、无动画循环。

## 5. 全局工具类契约（T1 在 tokens.css 中实现，所有页面 agent 直接使用）

| 类名 | 效果 |
|---|---|
| `.lx-panel` | 面板表面：bg-2、8px 圆角、发丝边框、边缘导光、柔和投影 |
| `.lx-panel-inset` | 凹陷区：bg-1、内阴影、4px 圆角（放预览图/画布用） |
| `.lx-eyebrow` | 分区眉标容器：11px、大写、letterspacing、text-2；内含中文名 + `.lx-eyebrow-code`（mono、text-3、右侧）|
| `.lx-eyebrow-code` | 眉标英文代码（如 GEOMETRY / INPUT / EXPORT） |
| `.lx-data` | 等宽数字：`font-family: var(--lx-font-mono)`、`font-variant-numeric: tabular-nums` |
| `.lx-divider` | 1px 发丝分割线（margin 上下 16px） |
| `.lx-viewport` | 3D/预览视口容器：bg-1、HUD 四角括角、position:relative |
| `.lx-viewport-hud` | 视口内叠加的角落读数条（mono 11px text-3，pointer-events:none） |
| `.lx-empty` | 空状态：居中、text-3、图标上方极淡暖背光径向光晕 |
| `.lx-rise` | 入场动画：opacity 0→1 + translateY(8px)→0，360ms，可配 `--lx-rise-delay` 变量做 stagger |

用法示例（页面 agent 照此改造分区标题）：
```tsx
<div className="lx-eyebrow"><span>几何参数</span><span className="lx-eyebrow-code">GEOMETRY</span></div>
```

## 6. PageNav 共享组件契约（T1 实现于 `src/components/PageNav.tsx` + `PageNav.css`）

```tsx
export interface PageNavProps {
  title: string;            // 中文工具名
  code?: string;            // 技术代码眉标，如 "RELIEF" / "LAC→3D" / "CMYK"
  backTo?: string;          // 默认 '/'
  actions?: React.ReactNode; // 右侧操作区（页面自带的按钮塞这里）
}
```

渲染：`[← 返回] [◆品牌glyph] 工具名 ·CODE ————(弹性)———— [actions]`，
高度 48px，bg-0 半透明 + backdrop-blur(12px)，底部 1px 光谱发丝线（§4 预算 1）。
品牌 glyph：一个 14px 的 CSS/SVG 菱形叠加体（无需图片）。
所有页面 agent 必须删除自己页面里手写的 `page-nav` 标记与样式，改用 `<PageNav …/>`。

## 7. Arco 覆盖要点（T1 实现于 arco-overrides.css，加载顺序在 arco.css 之后）

- `body[arco-theme='dark']` 上重设变量：`--primary-1..10`（以 `--lx-cyan` 为 primary-6，注意 Arco 变量是 `R,G,B` 数字三元组格式）、`--color-bg-1..5`、`--color-text-1..4`、`--color-border-*`、`--color-fill-*`、成功/警告/危险色。
- 组件级精修（类选择器覆盖）：
  - Button：primary 用 cyan 底 + `#041014` 深色文字；secondary 用发丝描边幽灵按钮；hover 顶部 1px 光谱高光（§4 预算 3）。
  - Slider：2px 轨道、光谱填充、12px 方形手柄。
  - InputNumber/Input/Select：bg-1 凹陷、发丝边、focus 时 cyan 边。数字输入内容用 mono 字体。
  - Switch/Radio/Tag/Table/Collapse/Modal/Message/Progress/Spin/Upload(拖拽区)/Popconfirm/Alert：统一到本色板与圆角体系；Upload 拖拽悬停用光谱边框（§4 预算 5）。
- Message/Modal 等 portal 组件务必覆盖到（它们挂在 body 下，不在 .App 内）。

## 8. 各页面要点

- **Home**：本站门面，唯一允许"放开做"的页面。品牌区（保留中文名「viva的3D打印小工具」，可加技术副题如 `PHOTO → MATTER · 浏览器内 3D 制造`）+ 4 张"透光瓷板"卡片：默认熄灯（冷、暗），hover 背光点亮（图标暖光辉光 + 面板顶部渗光 + 2px 上浮）。入场一次性 stagger（每张 +50ms）。可加固定的、极淡的背景光晕氛围（静态或超慢速，无 JS 循环）。
- **工作台页（Relief / LaserCut / ColorCmyk / ColorPositive）**：保持"左参数面板 + 右视口"骨架；左面板分区全部换 `.lx-eyebrow` 眉标制；右视口套 `.lx-viewport`（+可选 `.lx-viewport-hud` 显示模型尺寸等既有信息）；数字一律 `.lx-data`。空状态用 `.lx-empty` 改写成"邀请动作"文案。
- **校准页（RgbCalibrate / CmykCalibrate）**：偏"实验室记录"气质：表格数字 mono、色块样本呈现为"样片"（小圆角+发丝边），步骤说明用眉标分区。
- **ModelViewer（Three.js）**：场景清屏色改 `#0A0F1A`，网格线用 `#1E2740`/`#2A3556` 系，保持按需渲染（不得引入常驻 RAF 循环）。

## 9. 验收标准

1. `npx tsc --noEmit` 通过；集成阶段 `npm run build` 通过。
2. 深色对比度：正文对面板 ≥ 7:1，弱文字 ≥ 4.5:1（本色板已满足，勿私自调淡）。
3. 键盘 Tab 可见焦点；`prefers-reduced-motion` 下无位移动画。
4. 移动端（≤900px）：沿用现有"面板上、视口下"的折叠逻辑并保持可用。
5. 页面内不残留旧的 `page-nav` 手写导航、不残留与新色板冲突的硬编码颜色（如 `#282c34`、`#333`、`#999`）。
