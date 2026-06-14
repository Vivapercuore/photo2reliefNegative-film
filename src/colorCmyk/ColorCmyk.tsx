import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  List,
  Upload,
  Button,
  InputNumber,
  Switch,
  Message,
  Tag,
  Spin,
  // @ts-ignore arco 类型偶尔解析不到
} from '@arco-design/web-react';
import * as THREE from 'three';
import { useDocumentTitle } from '../useDocumentTitle';
import { PhotoSizeMap } from '../constants';
import ZoomableImage from '../ZoomableImage';
import ModelViewer from '../laser/viewer/ModelViewer';
import { pack3mf } from '../export/bambu/build3mf';
import { makeThumbnails } from '../export/bambu/thumbnail';
import { gridSizeFor } from '../colorPositive/dither';
import { splitBoxSolids } from '../colorPositive/buildColorField';
import { quantizeCmyk, cmykToRGBA, cmykStats, CmykField, CMYK_PALETTE } from './cmyk';
import { buildCmykParts, CmykPart } from './buildCmykField';
import { loadCalibration } from './calibration';
import './ColorCmyk.css';

interface Stats {
  cols: number;
  rows: number;
  widthMm: number;
  heightMm: number;
  avgInk: [number, number, number, number];
  minLevels: number;
  maxLevelsTotal: number;
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

/** Smallest reliably printable pixel size (mm) — lower bound of the UI option. */
const DOT_MM_MIN = 0.2;

/** Print layer height (mm) — the thickness quantum each ink level maps to. */
const LAYER_MM = 0.08;

/** Triangle count above which we warn the user to coarsen the pixel size. */
const TRIANGLE_WARN = 1_000_000;

const ColorCmyk: React.FC = () => {
  const navigate = useNavigate();
  useDocumentTitle('彩色照片转CMYK透光画');

  const [maxLength, setMaxLength] = useState(152);
  const [dotMm, setDotMm] = useState(0.6);
  const [maxLevels, setMaxLevels] = useState(10);
  const [baseLayers, setBaseLayers] = useState(2);
  const [addBorder, setAddBorder] = useState(false);
  const [borderWidth, setBorderWidth] = useState(3);
  const [imageUrl, setImageUrl] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgReady, setImgReady] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [stats, setStats] = useState<Stats | null>(null);
  const fieldRef = useRef<CmykField | null>(null);
  // 耗材校准（颜色/透光系数），来自校准页，未校准时为按调色板推算的默认值。
  // 返回此页时重新读取，保证刚校准完即生效。
  const [cal, setCal] = useState(() => loadCalibration());
  useEffect(() => {
    const reload = () => setCal(loadCalibration());
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, []);

  // 3D
  const viewGroupRef = useRef<THREE.Group | null>(null);
  const partsRef = useRef<CmykPart[]>([]);
  const [viewObject, setViewObject] = useState<THREE.Object3D | null>(null);
  const [fieldVersion, setFieldVersion] = useState(0);
  const [triangles, setTriangles] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState(false);

  const baseName = useMemo(
    () => (fileName || 'cmyk').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_') || 'cmyk',
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
    const reader = new FileReader();
    reader.onload = (e) => {
      const url = e.target?.result as string;
      setImageUrl(url);
      const img = new Image();
      img.onload = () => {
        imgRef.current = img;
        setImgReady((n) => n + 1);
      };
      img.onerror = () => Message.error('图片加载失败');
      img.src = url;
    };
    reader.readAsDataURL(file);
  }, []);

  // (re)quantize whenever image or sampling params change
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !img.width) return;
    const grid = gridSizeFor(img.width, img.height, maxLength, dotMm);

    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const cx = c.getContext('2d');
    if (!cx) return;
    cx.drawImage(img, 0, 0);
    const src = cx.getImageData(0, 0, img.width, img.height);

    const field = quantizeCmyk(src, grid.cols, grid.rows, grid.dotMm, {
      cal,
      layerMm: LAYER_MM,
      baseLayers,
      maxLevels,
    });
    fieldRef.current = field;

    const oc = document.createElement('canvas');
    oc.width = grid.cols;
    oc.height = grid.rows;
    const ocx = oc.getContext('2d');
    if (!ocx) return;
    ocx.putImageData(
      new ImageData(cmykToRGBA(field, cal, LAYER_MM, baseLayers), grid.cols, grid.rows),
      0,
      0
    );
    setPreviewUrl(oc.toDataURL());

    const s = cmykStats(field);
    setStats({
      cols: grid.cols,
      rows: grid.rows,
      widthMm: grid.widthMm,
      heightMm: grid.heightMm,
      avgInk: s.avgInk,
      minLevels: s.minLevels,
      maxLevelsTotal: s.maxLevelsTotal,
    });
    setFieldVersion((v) => v + 1);
  }, [imgReady, maxLength, dotMm, maxLevels, baseLayers, cal]);

  // auto-(re)build the 3D model (debounced so the Spin can show)
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    setGenerating(true);
    const timer = setTimeout(() => {
      try {
        disposeView();
        const parts = buildCmykParts(field, {
          layerMm: LAYER_MM,
          baseLayers,
          addBorder,
          borderWidth,
        });
        partsRef.current = parts;
        const group = new THREE.Group();
        let tris = 0;
        parts.forEach((p) => {
          const [r, g, b] = p.palette.rgb;
          // 不透明渲染：相邻通道顶/底面共面，半透明会深度排序混乱（z-fight）；
          // 顶视看到的不透明顶面颜色即实物顶面，足够直观
          const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(r / 255, g / 255, b / 255),
            roughness: 0.85,
            metalness: 0,
            side: THREE.DoubleSide,
          });
          group.add(new THREE.Mesh(p.geometry, mat));
          tris += p.triangles;
        });
        const W = field.cols * field.dotMm;
        const D = field.rows * field.dotMm;
        const H = (baseLayers + field.maxLevels * 4) * LAYER_MM;
        group.position.set(-W / 2, -H / 2, -D / 2);
        viewGroupRef.current = group;
        setTriangles(tris);
        setViewObject(group);
      } catch (e: any) {
        Message.error(`生成失败：${e?.message || e}`);
      } finally {
        setGenerating(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [fieldVersion, baseLayers, addBorder, borderWidth, disposeView]);

  const doExport = useCallback(async () => {
    const parts = partsRef.current;
    if (!parts.length) {
      Message.warning('请先生成模型');
      return;
    }
    setExporting(true);
    try {
      // 每个盒子作为独立实体（独立焊接顶点），避免相邻盒子共享面被切片器
      // 报成非流形边
      const objects = parts.map((p) => ({
        name: p.palette.label,
        geometry: splitBoxSolids(p.geometry),
        extruder: p.extruder,
        plate: 1,
      }));
      const filaments = CMYK_PALETTE.map((p) => toHex(p.rgb));
      // 缩略图：资源管理器（OPC thumbnail）与 Bambu 项目浏览都靠它显示预览
      let thumbnails: { middle: Uint8Array; small: Uint8Array } | undefined;
      try {
        if (previewUrl) thumbnails = await makeThumbnails(previewUrl);
      } catch {
        thumbnails = undefined; // 缩略图失败不阻断导出
      }
      const lw = '0.25';
      const overrides: Record<string, unknown> = {
        // 通道厚度按 0.08mm 层量化，层高（含首层）必须与之一致
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
      const u8 = await pack3mf('color-cmyk', objects, { title: baseName }, {
        // 把所有颜色合成一个组合体（单个 build item），各色互不相对位移
        assembleAsOne: true,
        filaments,
        thumbnails,
        projectSettingsOverrides: overrides,
        markModified: Object.keys(overrides),
      });
      saveBlob(u8, `${baseName}-cmyk.3mf`);
      Message.success('CMYK 多色 3MF 已导出');
    } catch (e: any) {
      Message.error(`导出失败：${e?.message || e}`);
    } finally {
      setExporting(false);
    }
  }, [baseName, previewUrl]);

  const totalMinMm = stats ? (baseLayers + stats.minLevels) * LAYER_MM : 0;
  const totalMaxMm = stats ? (baseLayers + stats.maxLevelsTotal) * LAYER_MM : 0;

  return (
    <div className="colorcmyk">
      <div className="page-nav">
        <Button type="text" size="small" onClick={() => navigate('/')}>
          ← 返回首页
        </Button>
        <span className="page-nav-title">彩色照片转CMYK透光画（厚度控制明度 · 测试版）</span>
      </div>

      <div className="colorcmyk-body">
        <div className="colorcmyk-panel">
          <List size="large" header="上传彩色照片，生成 CMYK 透光彩画">
            <List.Item key="calibration">
              <div className="title">耗材校准</div>
              <div className="describe">
                每种耗材的颜色和透光系数不同，校准后预览和成品才一致。
                {cal.calibrated
                  ? '当前已使用自定义校准。'
                  : '当前为按调色板推算的默认估计，建议打印校准片实测一次。'}
              </div>
              <div className="colorcmyk-switch">
                {cal.calibrated ? (
                  <Tag color="green">已校准</Tag>
                ) : (
                  <Tag color="gray">默认估计</Tag>
                )}
                <Button size="small" onClick={() => navigate('/color-cmyk/calibrate')}>
                  {cal.calibrated ? '重新校准 / 查看' : '去校准耗材'}
                </Button>
              </div>
            </List.Item>

            <List.Item key="upload">
              <div className="title">选择图像</div>
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
                    className="colorcmyk-collapse-head"
                    onClick={() => setPreviewOpen((o) => !o)}
                  >
                    <span className="title">原图 / 预览图</span>
                    <span className="colorcmyk-collapse-icon">
                      {previewOpen ? '收起 ▲' : '展开 ▼'}
                    </span>
                  </div>
                  {previewOpen ? (
                    <>
                      <ZoomableImage src={imageUrl} alt="原图" className="colorcmyk-fullimg" />
                      <div className="colorcmyk-cap">原图</div>
                      {previewUrl ? (
                        <>
                          <ZoomableImage
                            src={previewUrl}
                            alt="预览图"
                            pixelated
                            className="colorcmyk-fullimg colorcmyk-quant"
                          />
                          <div className="colorcmyk-cap">CMYK 量化预览（明度由厚度还原）</div>
                        </>
                      ) : null}
                    </>
                  ) : null}
                </List.Item>

                <List.Item key="howto">
                  <div className="title">成像原理</div>
                  <div className="describe">
                    CMY + 白 透光成像：底层<b>白色</b>是扩散/明度层，厚度控制明暗（越厚越暗，类似光刻画），
                    青/品红/黄叠在上面按厚度减色上色。自下而上 白→黄→品红→青 堆叠，背光透射时混合显色。
                    4 色 AMS 即可打印，无需暂停换料；建议 C/M/Y 用半透明耗材、白色用扩散白。
                  </div>
                  <div className="describe">
                    注意：右侧 3D 预览是不透光时从顶面看到的外观（顶层是青/品红/黄，颜色偏色属正常）；
                    实际透光显色效果以上方「量化预览」为准。
                  </div>
                </List.Item>

                <List.Item key="dot">
                  <div className="title">像素点尺寸 (mm)</div>
                  <div className="describe">
                    单个像素点的物理边长，最小 0.2mm。越小画面越细腻、像素越多，生成与切片也越慢；
                    CMYK 靠厚度表现明暗，对像素尺寸不如抖动方案敏感，建议 0.4~0.8。
                  </div>
                  <InputNumber
                    style={{ width: 180 }}
                    mode="button"
                    suffix="mm"
                    min={DOT_MM_MIN}
                    max={2}
                    step={0.1}
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
                        className="colorcmyk-size-tag"
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

                <List.Item key="levels">
                  <div className="title">明度层数（每通道）</div>
                  <div className="describe">
                    每个通道满墨时的层数，单层 {LAYER_MM}mm。层数越多明度过渡越细腻，模型也越厚：
                    当前每通道最大 {(maxLevels * LAYER_MM).toFixed(2)}mm，四通道叠加最大{' '}
                    {(maxLevels * 4 * LAYER_MM).toFixed(2)}mm。
                  </div>
                  <InputNumber
                    style={{ width: 180 }}
                    mode="button"
                    suffix="层"
                    min={2}
                    max={12}
                    step={1}
                    precision={0}
                    value={maxLevels}
                    onChange={(v: number) => setMaxLevels(v)}
                  />
                </List.Item>

                <List.Item key="base">
                  <div className="title">白色底层（扩散层）层数</div>
                  <div className="describe">
                    白色扩散底层整板，单层 {LAYER_MM}mm。它把背光匀化成白场，并避免纯白像素变成
                    通孔；越厚整体越偏暗。除非刻意想要镂空，否则建议至少 1~2 层。
                  </div>
                  <InputNumber
                    style={{ width: 180 }}
                    mode="button"
                    suffix="层"
                    min={0}
                    max={12}
                    step={1}
                    precision={0}
                    value={baseLayers}
                    onChange={(v: number) => setBaseLayers(v)}
                  />
                  {baseLayers === 0 ? (
                    <div className="colorcmyk-warn">白色底层为 0：纯白区域将成为通孔，且背光不均。</div>
                  ) : null}
                </List.Item>

                <List.Item key="border">
                  <div className="title">边框</div>
                  <div className="colorcmyk-switch">
                    <Switch
                      checked={addBorder}
                      onChange={(v: boolean | string | number) => setAddBorder(Boolean(v))}
                    />{' '}
                    <span>在四周加一圈白色边框（高度与最高像素一致）</span>
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
                    <div className="title">生成信息</div>
                    <div className="colorcmyk-stats">
                      <Tag color="arcoblue">
                        逻辑像素 {stats.cols} × {stats.rows}
                      </Tag>
                      <Tag color="green">
                        物理尺寸 {stats.widthMm.toFixed(1)} × {stats.heightMm.toFixed(1)} mm
                      </Tag>
                      <Tag color="purple">
                        厚度 {totalMinMm.toFixed(2)} ~ {totalMaxMm.toFixed(2)} mm
                      </Tag>
                      <Tag color={triangles > TRIANGLE_WARN ? 'red' : 'gray'}>
                        三角形 {(triangles / 1000).toFixed(0)}k
                      </Tag>
                    </div>
                    {triangles > TRIANGLE_WARN ? (
                      <div className="colorcmyk-warn">
                        三角形数量较大，导出与切片会比较慢——可增大像素点尺寸或减小成像区。
                      </div>
                    ) : null}
                    <div className="colorcmyk-counts">
                      {CMYK_PALETTE.map((p, i) => (
                        <span key={p.id} className="colorcmyk-count">
                          <i
                            className="colorcmyk-swatch"
                            style={{ background: `rgb(${p.rgb.join(',')})` }}
                          />
                          {p.label} 平均墨量 {(stats.avgInk[i] * 100).toFixed(1)}%
                        </span>
                      ))}
                    </div>
                  </List.Item>
                ) : null}

                <List.Item key="export">
                  <div className="title">导出</div>
                  <div className="describe">
                    模型随参数自动生成，右侧实时预览。导出 4 色 3MF，料表为 青/品红/黄/白。
                  </div>
                  <Button
                    type="primary"
                    size="large"
                    long
                    loading={exporting}
                    disabled={!viewObject || generating}
                    onClick={doExport}
                  >
                    导出 CMYK 多色 3MF
                  </Button>
                </List.Item>
              </>
            ) : null}
          </List>
        </div>

        <div className="colorcmyk-viewer">
          <Spin loading={generating} tip="生成模型中…" style={{ width: '100%', height: '100%' }}>
            {viewObject ? (
              <ModelViewer object={viewObject} className="colorcmyk-3d" />
            ) : (
              <div className="colorcmyk-empty">
                上传图片、设置参数后
                <br />
                在此预览四色堆叠效果
              </div>
            )}
          </Spin>
        </div>
      </div>
    </div>
  );
};

export default ColorCmyk;
