import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  List,
  Upload,
  Button,
  Radio,
  InputNumber,
  Switch,
  Message,
  Tag,
  Spin,
  Alert,
  Modal,
  // @ts-ignore arco 类型偶尔解析不到
} from '@arco-design/web-react';
import PageNav from '../components/PageNav';
import * as THREE from 'three';
import { useDocumentTitle } from '../useDocumentTitle';
import { PhotoSizeMap } from '../constants';
import ZoomableImage from '../ZoomableImage';
import ModelViewer from '../laser/viewer/ModelViewer';
import { pack3mf, PauseLayer, makeThumbnails } from 'bambu-3mf';
import {
  gridSizeFor,
  ditherToPalette,
  indicesToRGBA,
  simulateRGBA,
  paletteCounts,
  RGBK_PALETTE,
  RGBW_PALETTE,
  RGBKW_PALETTE,
  DitherResult,
} from './dither';
import { buildColorField, partSolids, ColorPart } from './buildColorField';
import CropEditor from '../imageEdit/CropEditor';
import ColorEditor from '../imageEdit/ColorEditor';
import { renderEdited, NO_CROP, defaultColorAdjust, CropRect, ColorAdjust } from '../imageEdit/imageEdit';
import {
  loadCalibration,
  saveCalibration,
  loadSavedCalibrations,
  primaryLin,
  lin2srgb,
  RgbCalibration,
} from './calibration';
import RgbCalibrationPicker from './RgbCalibrationPicker';
import RgbCalibrationTable from './RgbCalibrationTable';
import './ColorPositive.css';

const RadioGroup = Radio.Group;

interface Stats {
  cols: number;
  rows: number;
  dotMm: number;
  widthMm: number;
  heightMm: number;
  counts: number[];
  total: number;
}

function saveBlob(data: BlobPart, filename: string) {
  const blob = new Blob([data]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const toHex = (rgb: [number, number, number]) =>
  '#' + rgb.map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('');

/** Smallest reliably printable dot size (mm) — lower bound of the UI option. */
const DOT_MM_MIN = 0.2;

/** Fixed slicing layer height (mm) — pause-layer Z must land on this grid. */
const LAYER_MM = 0.1;

/** localStorage key remembering the user's "≥5-slot AMS?" answer ('1'/'0'). */
const AMS_LS_KEY = 'colorPositive.hasWideAms';

const ColorPositive: React.FC = () => {
  const navigate = useNavigate();
  useDocumentTitle('彩色照片转正片');

  const [paletteMode, setPaletteMode] = useState<'rgbkw' | 'rgbw' | 'rgbk'>('rgbkw');
  const [maxLength, setMaxLength] = useState(152);
  const [dotMm, setDotMm] = useState(DOT_MM_MIN);
  const [addBorder, setAddBorder] = useState(false);
  const [borderWidth, setBorderWidth] = useState(3);
  const [colorThickness, setColorThickness] = useState(0.2);
  const [baseThickness, setBaseThickness] = useState(0.8);
  // 是否有 4 色以上（≥5 槽）AMS：必选项，无默认值；选过后记入 localStorage 自动恢复
  const [hasWideAms, setHasWideAms] = useState<boolean | null>(() => {
    const v = window.localStorage.getItem(AMS_LS_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  });
  // 抹平顶部（仅 ≥5 槽 AMS 可选）：黑色填充至顶面高度，使顶面平整
  const [flattenTop, setFlattenTop] = useState(true);
  const [imageUrl, setImageUrl] = useState('');
  const [ditherUrl, setDitherUrl] = useState('');
  const [simUrl, setSimUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgReady, setImgReady] = useState(0);
  const [natSize, setNatSize] = useState({ w: 0, h: 0 });
  // 编辑：裁剪（归一化）与色彩调整（RGB 原色），作为抖动/分色的输入
  const [crop, setCrop] = useState<CropRect>(NO_CROP);
  const [color, setColor] = useState<ColorAdjust>(() => defaultColorAdjust(['R', 'G', 'B']));
  const [previewOpen, setPreviewOpen] = useState(true);
  const [stats, setStats] = useState<Stats | null>(null);
  const ditherResultRef = useRef<DitherResult | null>(null);

  // 3D
  const viewGroupRef = useRef<THREE.Group | null>(null);
  const partsRef = useRef<ColorPart[]>([]);
  const [viewObject, setViewObject] = useState<THREE.Object3D | null>(null);
  const [ditherVersion, setDitherVersion] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState(false);

  // 耗材校准：返回此页时重新读取，保证刚校准完即生效
  const [cal, setCal] = useState(() => loadCalibration());
  const [savedCals, setSavedCals] = useState(() => loadSavedCalibrations());
  const [calParamsOpen, setCalParamsOpen] = useState(false);
  useEffect(() => {
    const reload = () => {
      setCal(loadCalibration());
      setSavedCals(loadSavedCalibrations());
    };
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, []);
  const applyCal = useCallback((c: RgbCalibration) => {
    const copy: RgbCalibration = JSON.parse(JSON.stringify(c));
    saveCalibration(copy);
    setCal(copy);
    Message.success(copy.label ? `已应用：${copy.label}` : '已应用校准');
  }, []);

  const baseName = useMemo(
    () => (fileName || 'color').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_') || 'color',
    [fileName]
  );

  const disposeView = useCallback(() => {
    const g = viewGroupRef.current;
    if (g) {
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else if (mat) mat.dispose();
      });
      viewGroupRef.current = null;
    }
  }, []);

  useEffect(() => () => disposeView(), [disposeView]);

  const onFile = useCallback((file: File) => {
    setFileName(file.name);
    setCrop(NO_CROP); // 新图重置裁剪与色彩
    setColor(defaultColorAdjust(['R', 'G', 'B']));
    const reader = new FileReader();
    reader.onload = (e) => {
      const url = e.target?.result as string;
      setImageUrl(url);
      const img = new Image();
      img.onload = () => {
        imgRef.current = img;
        setNatSize({ w: img.naturalWidth, h: img.naturalHeight });
        setImgReady((n) => n + 1);
      };
      img.onerror = () => Message.error('图片加载失败');
      img.src = url;
    };
    reader.readAsDataURL(file);
  }, []);

  // (re)dither whenever image or physical params change
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;
    // 裁剪后的有效尺寸决定点阵长宽比
    const effW = Math.max(1, Math.round(crop.w * natW));
    const effH = Math.max(1, Math.round(crop.h * natH));
    const grid = gridSizeFor(effW, effH, maxLength, dotMm);

    // 编辑后的画布（裁剪 + 色彩），长边略高于点阵即可，省内存/耗时
    const cap = Math.min(4096, Math.max(512, 2 * Math.max(grid.cols, grid.rows)));
    const edited = renderEdited(img, natW, natH, crop, color, ['R', 'G', 'B'], cap);
    const ecx = edited.getContext('2d');
    if (!ecx) return;
    const src = ecx.getImageData(0, 0, edited.width, edited.height);

    // 始终把校准对象传下去：Yule-Nielsen 叠色补偿按推荐默认值生效（与是否实测原色
    // 无关）；实测原色 + 色域投影仍只在已校准时启用（逻辑在 dither 内按 calibrated 判断）。
    const activeCal = cal;
    const res = ditherToPalette(src, grid.cols, grid.rows, grid.dotMm, palette, activeCal);
    ditherResultRef.current = res;

    const oc = document.createElement('canvas');
    oc.width = grid.cols;
    oc.height = grid.rows;
    const ocx = oc.getContext('2d');
    if (!ocx) return;
    ocx.putImageData(new ImageData(indicesToRGBA(res, activeCal), grid.cols, grid.rows), 0, 0);
    setDitherUrl(oc.toDataURL());

    // 透光混色模拟：按线性光块平均，接近成品实际观感（点阵图被浏览器按
    // sRGB 缩放，观感会比实物更艳更硬）
    const sim = simulateRGBA(res, Math.max(2, Math.round(grid.cols / 380)), activeCal);
    const sc = document.createElement('canvas');
    sc.width = sim.width;
    sc.height = sim.height;
    const scx = sc.getContext('2d');
    if (scx) {
      scx.putImageData(new ImageData(sim.data, sim.width, sim.height), 0, 0);
      setSimUrl(sc.toDataURL());
    }

    setStats({
      cols: grid.cols,
      rows: grid.rows,
      dotMm: grid.dotMm,
      widthMm: grid.widthMm,
      heightMm: grid.heightMm,
      counts: paletteCounts(res),
      total: grid.cols * grid.rows,
    });
    setDitherVersion((v) => v + 1);
    // palette 由 paletteMode 派生（paletteMode 已在依赖内）；依赖刻意精简，无需重复列入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imgReady, maxLength, paletteMode, dotMm, cal, crop, color]);

  // auto-(re)build the 3D model whenever the dither or thickness/border changes
  // (debounced; the heavy build runs off the input event so the Spin can show)
  useEffect(() => {
    const res = ditherResultRef.current;
    if (!res) return;
    setGenerating(true);
    const timer = setTimeout(() => {
      try {
        disposeView();
        const parts = buildColorField(res, {
          colorThickness,
          baseThickness,
          addBorder,
          borderWidth,
          // 抹平顶部只在 5 色方案 + ≥5 色 AMS 下可用（4 色方案该选项隐藏）
          flattenTop: palette.length > 4 && hasWideAms === true && flattenTop,
        });
        partsRef.current = parts;
        const group = new THREE.Group();
        parts.forEach((p) => {
          // 已校准时用实测原色着色，3D 预览同样贴近成品
          const lin = cal.calibrated ? primaryLin(cal, p.palette.id) : null;
          const [r, g, b] = lin
            ? [lin2srgb(lin[0]), lin2srgb(lin[1]), lin2srgb(lin[2])]
            : [p.palette.rgb[0] / 255, p.palette.rgb[1] / 255, p.palette.rgb[2] / 255];
          const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(r, g, b),
            roughness: 0.85,
            metalness: 0,
            side: THREE.DoubleSide,
          });
          group.add(new THREE.Mesh(p.geometry, mat));
        });
        const W = res.cols * res.dotMm;
        const D = res.rows * res.dotMm;
        group.position.set(-W / 2, -(baseThickness + colorThickness) / 2, -D / 2);
        viewGroupRef.current = group;
        setViewObject(group);
      } catch (e: any) {
        Message.error(`生成失败：${e?.message || e}`);
      } finally {
        setGenerating(false);
      }
    }, 300);
    return () => clearTimeout(timer);
    // cal 变化经 ditherVersion 链路触发重建，palette 由 paletteMode 派生；
    // 依赖刻意精简，避免对同一次校准重复重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ditherVersion, colorThickness, baseThickness, addBorder, borderWidth, hasWideAms, flattenTop, disposeView]);

  const palette =
    paletteMode === 'rgbkw' ? RGBKW_PALETTE : paletteMode === 'rgbw' ? RGBW_PALETTE : RGBK_PALETTE;

  const onAmsChange = useCallback((v: 'yes' | 'no') => {
    const b = v === 'yes';
    setHasWideAms(b);
    window.localStorage.setItem(AMS_LS_KEY, b ? '1' : '0');
  }, []);

  // 仅 4 色 AMS 时 5 色方案的换料方案：白色共用黑色槽位。黑色只存在于
  // 0..底片厚度，白色只在底片之上，两者不同层 —— 黑色底片打完后暂停换白即可。
  const kSlot = palette.findIndex((p) => p.id === 'K') + 1; // 黑色槽位（1-based），0=调色板无黑
  const needsPause = hasWideAms === false && palette.length > 4 && kSlot > 0 && baseThickness > 0;
  // Bambu 在「顶面到达 top_z 的那一层」开打之前插入暂停，所以要填第一层白色
  // 的 top_z = 底片顶面（向上对齐层高网格）+ 一层——即黑色刚好全部打完的时刻。
  const baseTopZ = Math.ceil(baseThickness / LAYER_MM - 1e-6) * LAYER_MM;
  const pauseZ = Number((baseTopZ + LAYER_MM).toFixed(2));

  const doExport = useCallback(async () => {
    const parts = partsRef.current;
    if (!parts.length) {
      Message.warning('请先生成模型');
      return;
    }
    setExporting(true);
    try {
      // 无宽 AMS：白色部件映射到黑色槽位（两色不同层，靠暂停层换料），
      // 料表也只写 4 色；有宽 AMS：料表完全按调色板写入，用几色写几色。
      const remap = needsPause;
      const objects = parts.map((p) => ({
        name: p.palette.label,
        // 每个盒子作为独立实体（独立焊接顶点），避免相邻盒子共享面被
        // 切片器报成非流形边
        geometry: partSolids(p),
        extruder: remap && p.palette.id === 'W' ? kSlot : p.extruder,
        plate: 1,
      }));
      const filaments = (remap ? palette.filter((p) => p.id !== 'W') : palette).map((p) =>
        toHex(p.rgb)
      );
      const pauses: PauseLayer[] | undefined = remap
        ? [{ atZ: pauseZ, extruder: kSlot }]
        : undefined;
      // 缩略图：资源管理器（OPC thumbnail）与 Bambu 项目浏览都靠它显示预览
      // （优先用透光混色模拟图，比原始点阵更接近成品观感）
      let thumbnails: { middle: Uint8Array; small: Uint8Array } | undefined;
      try {
        const thumbSrc = simUrl || ditherUrl;
        if (thumbSrc) thumbnails = await makeThumbnails(thumbSrc);
      } catch {
        thumbnails = undefined; // 缩略图失败不阻断导出
      }
      const lw = '0.25';
      const overrides: Record<string, unknown> = {
        layer_height: String(LAYER_MM),
        initial_layer_print_height: String(LAYER_MM),
        sparse_infill_density: '100%', // 必须 100%
        wall_generator: 'arachne',
        line_width: lw,
        outer_wall_line_width: lw,
        inner_wall_line_width: lw,
        sparse_infill_line_width: lw,
        internal_solid_infill_line_width: lw,
        top_surface_line_width: lw,
        initial_layer_line_width: lw,
        support_line_width: lw,
        skeleton_infill_line_width: lw,
        skin_infill_line_width: lw,
      };
      const u8 = await pack3mf('color-positive', objects, { title: baseName }, {
        // 把所有颜色合成一个组合体（单个 build item），各色互不相对位移
        assembleAsOne: true,
        // 料表长度由我们自行控制（5 色 RGBKW、将来 CMYK 等都按需写入），
        // 否则模型引用超出模板的槽位会让 Bambu 重置料表、丢弃下面这些工艺参数
        filaments,
        pauses,
        thumbnails,
        projectSettingsOverrides: overrides,
        markModified: Object.keys(overrides),
      });
      saveBlob(u8, `${baseName}.3mf`);
      Message.success(
        remap
          ? `多色 3MF 已导出（黑色打完后暂停，Z=${pauseZ.toFixed(1)}mm 层开始前）`
          : '多色 3MF 已导出'
      );
    } catch (e: any) {
      Message.error(`导出失败：${e?.message || e}`);
    } finally {
      setExporting(false);
    }
  }, [baseName, palette, needsPause, kSlot, pauseZ, ditherUrl, simUrl]);

  const onExport = useCallback(() => {
    if (palette.length > 4 && hasWideAms === null) {
      Message.warning('请先选择是否有 5 色 AMS');
      return;
    }
    if (needsPause) {
      Modal.confirm({
        title: '打印须知：白色与黑色共用料槽',
        content: (
          <div>
            <p>
              4 色 AMS：白色已映射到黑色料槽（第 {kSlot} 槽），导出料表为 4 色。
            </p>
            <p>
              打印开始时第 {kSlot} 槽装<b>黑色</b>耗材；黑色底片打完后（Z=
              {pauseZ.toFixed(1)}mm 层开始前）会自动暂停，请将第 {kSlot} 槽换成
              <b>白色</b>耗材后继续打印。
            </p>
          </div>
        ),
        okText: '我已了解，导出',
        cancelText: '取消',
        onOk: doExport,
      });
      return;
    }
    doExport();
  }, [palette, hasWideAms, needsPause, kSlot, pauseZ, doExport]);

  const totalThickness = colorThickness + baseThickness;
  const thicknessStep = 0.1;

  return (
    <div className="colorpos">
      <PageNav
        title="彩色照片转正片"
        code="RGB+"
        actions={
          <Tag className="lx-data" color="arcoblue">
            {paletteMode === 'rgbkw' ? 'RGB+黑+白' : paletteMode === 'rgbw' ? 'RGB+白' : 'RGB+黑'}
          </Tag>
        }
      />

      <div className="colorpos-body">
        <div className="colorpos-panel lx-rise">
          <List size="large" header="上传彩色照片，生成多色正片">
            <List.Item key="calibration">
              <div className="lx-eyebrow colorpos-eyebrow">
                <span>耗材校准</span>
                <span className="lx-eyebrow-code">CALIBRATION</span>
              </div>
              <div className="describe">
                每卷耗材打印出的实际颜色都偏离理想原色，校准后预览和成品才一致。
                {cal.calibrated
                  ? cal.label
                    ? `当前使用预设「${cal.label}」。`
                    : '当前已使用自定义校准。'
                  : '当前未校准，按理想原色出图（偏色明显）——点下面预设可一键套用，或去打印校准片实测。'}
              </div>
              <div className="colorpos-switch">
                {cal.calibrated ? (
                  <Tag color="green">
                    {cal.label
                      ? `预设：${cal.label}`
                      : `已校准（${cal.condition === 'reflective' ? '反射' : '背光'}）`}
                  </Tag>
                ) : (
                  <Tag color="gray">未校准</Tag>
                )}
                <Button size="small" onClick={() => navigate('/color-positive/calibrate')}>
                  {cal.calibrated ? '重新校准 / 查看' : '去校准耗材'}
                </Button>
              </div>
              <div className="colorpos-cal-sub">
                <RgbCalibrationPicker
                  activeLabel={cal.label}
                  saved={savedCals}
                  onApply={applyCal}
                />
                <div
                  className="colorpos-collapse-head colorpos-cal-collapse"
                  onClick={() => setCalParamsOpen((o) => !o)}
                >
                  <span>查看当前耗材参数</span>
                  <span className="colorpos-collapse-icon">
                    {calParamsOpen ? '收起 ▲' : '展开 ▼'}
                  </span>
                </div>
                {calParamsOpen ? <RgbCalibrationTable cal={cal} /> : null}
              </div>
            </List.Item>

            <List.Item key="upload">
              <div className="lx-eyebrow colorpos-eyebrow">
                <span>选择图像</span>
                <span className="lx-eyebrow-code">INPUT</span>
              </div>
              <div className="describe">支持 jpg/png，全部在本地浏览器处理，不上传服务器。</div>
              <Upload
                drag
                accept="image/*"
                limit={1}
                autoUpload={false}
                showUploadList
                onChange={(list: any[]) => {
                  const f = list && list[list.length - 1];
                  if (f?.originFile) onFile(f.originFile);
                }}
                tip="仅支持图片"
              />
            </List.Item>

            {fileName ? (
              <>
                <List.Item key="preview">
                  <div
                    className="colorpos-collapse-head"
                    onClick={() => setPreviewOpen((o) => !o)}
                  >
                    <div className="lx-eyebrow colorpos-eyebrow" style={{ marginBottom: 0 }}>
                      <span>原图 / 预览图</span>
                      <span className="lx-eyebrow-code">PREVIEW</span>
                    </div>
                    <span className="colorpos-collapse-icon">{previewOpen ? '收起 ▲' : '展开 ▼'}</span>
                  </div>
                  {previewOpen ? (
                    <>
                      <div className="colorpos-cap" style={{ marginTop: 0 }}>
                        裁剪（直接作用于原图）：拖动选框移动、八向手柄改尺寸、上方选比例或输入尺寸
                      </div>
                      {imageUrl && natSize.w ? (
                        <CropEditor
                          src={imageUrl}
                          naturalWidth={natSize.w}
                          naturalHeight={natSize.h}
                          value={crop}
                          onChange={setCrop}
                          longEdgeMm={maxLength}
                          onLongEdgeChange={(mm) => setMaxLength(Math.min(500, Math.max(10, Math.round(mm))))}
                        />
                      ) : (
                        <ZoomableImage src={imageUrl} alt="原图" className="colorpos-fullimg" />
                      )}

                      <div className="colorpos-cap" style={{ marginTop: 14 }}>
                        色彩调整：整体曝光 / 对比 / 色调，按 红·绿·蓝 分别调饱和度与亮度
                      </div>
                      <ColorEditor value={color} onChange={setColor} primaries={RGBKW_PALETTE.slice(0, 3)} />

                      {ditherUrl ? (
                        <>
                          {/* 缩略显示用线性光正确缩放的小图（浏览器按 sRGB 缩放
                              点阵会发暗发脏且有摩尔纹）；点开放大看原始点阵 */}
                          <div className="colorpos-cap" style={{ marginTop: 14 }}>预览图（编辑后效果）</div>
                          <ZoomableImage
                            src={simUrl || ditherUrl}
                            alt="预览图"
                            zoomSrc={ditherUrl}
                            zoomPixelated
                            className="colorpos-fullimg colorpos-dither"
                          />
                        </>
                      ) : null}
                    </>
                  ) : null}
                </List.Item>

                <List.Item key="palette">
                  <div className="lx-eyebrow colorpos-eyebrow">
                    <span>配色方案</span>
                    <span className="lx-eyebrow-code">PALETTE</span>
                  </div>
                  <div className="describe">
                    黑+白：黑压暗部、白补高光、RGB 管彩色，明暗都有锚点，最稳；白：仅亮部填白，暗图易出噪点；黑：暗部用黑，更适合背光透射。
                  </div>
                  <RadioGroup
                    type="button"
                    value={paletteMode}
                    onChange={(v: 'rgbkw' | 'rgbw' | 'rgbk') => setPaletteMode(v)}
                  >
                    <Radio value="rgbkw">RGB + 黑 + 白</Radio>
                    <Radio value="rgbw">RGB + 白</Radio>
                    <Radio value="rgbk">RGB + 黑</Radio>
                  </RadioGroup>
                </List.Item>

                {palette.length > 4 ? (
                  <List.Item key="ams">
                    <div className="lx-eyebrow colorpos-eyebrow">
                      <span>
                        是否有 5 色 AMS<span className="colorpos-required">*必选</span>
                      </span>
                      <span className="lx-eyebrow-code">AMS</span>
                    </div>
                    <div className="describe">
                      5 色方案需要 5 个料槽；只有 4 色 AMS 时通过暂停换料完成。选择会被记住，下次自动恢复。
                    </div>
                    <RadioGroup
                      type="button"
                      value={hasWideAms === null ? undefined : hasWideAms ? 'yes' : 'no'}
                      onChange={onAmsChange}
                    >
                      <Radio value="yes">有 5 色及以上 AMS</Radio>
                      <Radio value="no">有四色 AMS</Radio>
                    </RadioGroup>
                    {hasWideAms === null ? (
                      <div className="colorpos-ams-unset">请先选择，才能导出 3MF。</div>
                    ) : null}
                    {needsPause ? (
                      <Alert
                        style={{ marginTop: 10 }}
                        type="warning"
                        title="将生成暂停层：白色与黑色共用料槽"
                        content={`白色将映射到黑色料槽（第 ${kSlot} 槽），导出料表为 4 色。打印开始时第 ${kSlot} 槽装黑色；黑色底片打完后（Z=${pauseZ.toFixed(
                          1
                        )}mm 层开始前）自动暂停，此时请将该槽换成白色耗材后继续。`}
                      />
                    ) : null}
                    {hasWideAms === true ? (
                      <div className="colorpos-switch" style={{ marginTop: 10 }}>
                        <Switch
                          checked={flattenTop}
                          onChange={(v: boolean | string | number) => setFlattenTop(Boolean(v))}
                        />{' '}
                        <span>抹平顶部（黑色填充至顶面高度，使顶面平整）</span>
                      </div>
                    ) : null}
                  </List.Item>
                ) : null}

                <List.Item key="dot">
                  <div className="lx-eyebrow colorpos-eyebrow">
                    <span>像素点尺寸 (mm)</span>
                    <span className="lx-eyebrow-code">GEOMETRY</span>
                  </div>
                  <div className="describe">
                    单个像素点的物理边长，最小 0.2mm（受喷嘴线宽限制）。越小画面越细腻、像素越多，生成与切片也越慢。
                  </div>
                  <InputNumber
                    style={{ width: 180 }}
                    mode="button"
                    suffix="mm"
                    min={DOT_MM_MIN}
                    max={1}
                    step={0.05}
                    precision={2}
                    value={dotMm}
                    onChange={(v: number) => setDotMm(v)}
                  />
                </List.Item>

                <List.Item key="size">
                  <div className="title">成像区长边长度 (mm)</div>
                  <div className="describe">成品图像区长边的物理尺寸，短边按图片比例自动缩放。</div>
                  <div className="describe">
                    常见照片尺寸（点击设置长边）：
                    {PhotoSizeMap.map((i) => (
                      <Tag
                        key={i.name}
                        className="colorpos-size-tag"
                        onClick={() => setMaxLength(Math.max(i.width, i.height))}
                      >
                        {i.name}
                      </Tag>
                    ))}
                  </div>
                  <InputNumber
                    style={{ width: 180 }}
                    size="large"
                    mode="button"
                    suffix="mm"
                    min={10}
                    max={500}
                    step={5}
                    value={maxLength}
                    onChange={(v: number) => setMaxLength(v)}
                  />
                </List.Item>

                <List.Item key="thickness">
                  <div className="lx-eyebrow colorpos-eyebrow">
                    <span>厚度</span>
                    <span className="lx-eyebrow-code">THICKNESS</span>
                  </div>
                  <div className="describe">染色层厚度（彩色像素），越厚颜色越实，最低 0.2mm。</div>
                  <InputNumber
                    style={{ width: 180 }}
                    mode="button"
                    suffix="mm"
                    min={0.2}
                    max={5}
                    step={thicknessStep}
                    precision={2}
                    value={colorThickness}
                    onChange={(v: number) => setColorThickness(v)}
                  />
                  <div className="describe" style={{ marginTop: 10 }}>
                    底片厚度（纯黑衬底，挡光让颜色更饱和）。
                  </div>
                  <InputNumber
                    style={{ width: 180 }}
                    mode="button"
                    suffix="mm"
                    min={0}
                    max={5}
                    step={thicknessStep}
                    precision={2}
                    value={baseThickness}
                    onChange={(v: number) => setBaseThickness(v)}
                  />
                  <div className="describe" style={{ marginTop: 8 }}>
                    总厚度{' '}
                    <span className="lx-data">
                      {totalThickness.toFixed(2)} mm（染色 {colorThickness.toFixed(2)} + 底片{' '}
                      {baseThickness.toFixed(2)}）
                    </span>
                  </div>
                </List.Item>

                <List.Item key="border">
                  <div className="lx-eyebrow colorpos-eyebrow">
                    <span>边框</span>
                    <span className="lx-eyebrow-code">BORDER</span>
                  </div>
                  <div className="colorpos-switch">
                    <Switch
                      checked={addBorder}
                      onChange={(v: boolean | string | number) => setAddBorder(Boolean(v))}
                    />{' '}
                    <span>在四周加一圈边框</span>
                  </div>
                  {addBorder ? (
                    <div style={{ marginTop: 10 }}>
                      <span style={{ marginRight: 8 }}>边框宽度</span>
                      <InputNumber
                        style={{ width: 150 }}
                        mode="button"
                        suffix="mm"
                        min={0.5}
                        max={20}
                        step={0.5}
                        precision={1}
                        value={borderWidth}
                        onChange={(v: number) => setBorderWidth(v)}
                      />
                    </div>
                  ) : null}
                </List.Item>

                {stats ? (
                  <List.Item key="stats">
                    <div className="lx-eyebrow colorpos-eyebrow">
                      <span>生成信息</span>
                      <span className="lx-eyebrow-code">STATS</span>
                    </div>
                    <div className="colorpos-stats">
                      <Tag color="arcoblue" className="lx-data">
                        逻辑像素 {stats.cols} × {stats.rows}
                      </Tag>
                      <Tag color="green" className="lx-data">
                        物理尺寸 {stats.widthMm.toFixed(1)} × {stats.heightMm.toFixed(1)} mm
                      </Tag>
                    </div>
                    <div className="colorpos-counts">
                      {palette.map((p, i) => (
                        <span key={p.id} className="colorpos-count">
                          <i
                            className="colorpos-swatch"
                            style={{ background: `rgb(${p.rgb.join(',')})` }}
                          />
                          {p.label}{' '}
                          <span className="lx-data">
                            {((stats.counts[i] / stats.total) * 100).toFixed(1)}%
                          </span>
                        </span>
                      ))}
                    </div>
                  </List.Item>
                ) : null}

                <List.Item key="export">
                  <div className="lx-eyebrow colorpos-eyebrow">
                    <span>导出</span>
                    <span className="lx-eyebrow-code">EXPORT</span>
                  </div>
                  <div className="describe">
                    模型随参数自动生成，右侧实时预览着色效果。
                  </div>
                  <Button
                    type="primary"
                    size="large"
                    long
                    loading={exporting}
                    disabled={!viewObject || generating || (palette.length > 4 && hasWideAms === null)}
                    onClick={onExport}
                  >
                    导出多色 3MF
                  </Button>
                </List.Item>
              </>
            ) : null}
          </List>
        </div>

        <div className="colorpos-viewer">
          <div className="lx-viewport" style={{ width: '100%', height: '100%' }}>
            {viewObject && stats ? (
              <div className="lx-viewport-hud colorpos-viewport-hud">
                {stats.cols}×{stats.rows} · {stats.widthMm.toFixed(0)}×{stats.heightMm.toFixed(0)}mm
              </div>
            ) : null}
            <Spin loading={generating} tip="生成模型中…" style={{ width: '100%', height: '100%' }}>
              {viewObject ? (
                <ModelViewer object={viewObject} className="colorpos-3d" />
              ) : (
                <div className="lx-empty" style={{ width: '100%', height: '100%' }}>
                  <div className="colorpos-empty-title">上传图片、设置参数后</div>
                  <div className="colorpos-empty-sub">在此预览着色效果</div>
                </div>
              )}
            </Spin>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ColorPositive;
