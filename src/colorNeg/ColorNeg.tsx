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
  // @ts-ignore arco 类型偶尔解析不到
} from '@arco-design/web-react';
import * as THREE from 'three';
import { useDocumentTitle } from '../useDocumentTitle';
import { PhotoSizeMap } from '../constants';
import ZoomableImage from '../ZoomableImage';
import ModelViewer from '../laser/viewer/ModelViewer';
import { pack3mf } from '../export/bambu/build3mf';
import {
  gridSizeFor,
  ditherToPalette,
  indicesToRGBA,
  paletteCounts,
  RGBK_PALETTE,
  RGBW_PALETTE,
  RGBKW_PALETTE,
  DitherResult,
} from './dither';
import { buildColorField, ColorPart } from './buildColorField';
import './ColorNeg.css';

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

/** Fixed printable dot size (mm) — smallest reliably printable feature. */
const DOT_MM = 0.3;

const ColorNeg: React.FC = () => {
  const navigate = useNavigate();
  useDocumentTitle('彩色照片转正片');

  const [paletteMode, setPaletteMode] = useState<'rgbkw' | 'rgbw' | 'rgbk'>('rgbkw');
  const [maxLength, setMaxLength] = useState(152);
  const [addBorder, setAddBorder] = useState(false);
  const [borderWidth, setBorderWidth] = useState(3);
  const [colorThickness, setColorThickness] = useState(0.2);
  const [baseThickness, setBaseThickness] = useState(0.8);
  const [imageUrl, setImageUrl] = useState('');
  const [ditherUrl, setDitherUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgReady, setImgReady] = useState(0);
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

  // (re)dither whenever image or physical params change
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !img.width) return;
    const grid = gridSizeFor(img.width, img.height, maxLength, DOT_MM);

    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const cx = c.getContext('2d');
    if (!cx) return;
    cx.drawImage(img, 0, 0);
    const src = cx.getImageData(0, 0, img.width, img.height);

    const res = ditherToPalette(src, grid.cols, grid.rows, grid.dotMm, palette);
    ditherResultRef.current = res;

    const oc = document.createElement('canvas');
    oc.width = grid.cols;
    oc.height = grid.rows;
    const ocx = oc.getContext('2d');
    if (!ocx) return;
    ocx.putImageData(new ImageData(indicesToRGBA(res), grid.cols, grid.rows), 0, 0);
    setDitherUrl(oc.toDataURL());

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
  }, [imgReady, maxLength, paletteMode]);

  // auto-(re)build the 3D model whenever the dither or thickness/border changes
  // (debounced; the heavy build runs off the input event so the Spin can show)
  useEffect(() => {
    const res = ditherResultRef.current;
    if (!res) return;
    setGenerating(true);
    const timer = setTimeout(() => {
      try {
        disposeView();
        const parts = buildColorField(res, { colorThickness, baseThickness, addBorder, borderWidth });
        partsRef.current = parts;
        const group = new THREE.Group();
        parts.forEach((p) => {
          const [r, g, b] = p.palette.rgb;
          const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(r / 255, g / 255, b / 255),
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
  }, [ditherVersion, colorThickness, baseThickness, addBorder, borderWidth, disposeView]);

  const palette =
    paletteMode === 'rgbkw' ? RGBKW_PALETTE : paletteMode === 'rgbw' ? RGBW_PALETTE : RGBK_PALETTE;

  const onExport = useCallback(async () => {
    const parts = partsRef.current;
    if (!parts.length) {
      Message.warning('请先生成模型');
      return;
    }
    setExporting(true);
    try {
      const objects = parts.map((p) => ({
        name: p.palette.label,
        geometry: p.geometry,
        extruder: p.extruder,
        plate: 1,
      }));
      const lw = '0.2';
      const overrides: Record<string, unknown> = {
        nozzle_diameter: ['0.4'],
        layer_height: '0.1',
        initial_layer_print_height: '0.1',
        sparse_infill_density: '100%', // 必须 100%
        line_width: lw,
        outer_wall_line_width: lw,
        inner_wall_line_width: lw,
        sparse_infill_line_width: lw,
        internal_solid_infill_line_width: lw,
        top_surface_line_width: lw,
        initial_layer_line_width: lw,
        support_line_width: lw,
      };
      const u8 = await pack3mf('color-positive', objects, { title: baseName }, {
        // 把所有颜色合成一个组合体（单个 build item），各色互不相对位移
        assembleAsOne: true,
        // 按调色板长度重排料表（RGBKW=5 色时模板的 4 根料会被正确扩展到 5），
        // 否则模型引用第 5 槽会让 Bambu 重置料表、丢弃下面这些工艺参数
        filaments: palette.map((p) => toHex(p.rgb)),
        projectSettingsOverrides: overrides,
        markModified: Object.keys(overrides),
      });
      saveBlob(u8, `${baseName}.3mf`);
      Message.success('多色 3MF 已导出');
    } catch (e: any) {
      Message.error(`导出失败：${e?.message || e}`);
    } finally {
      setExporting(false);
    }
  }, [baseName, palette]);

  const totalThickness = colorThickness + baseThickness;
  const thicknessStep = 0.1;

  return (
    <div className="colorneg">
      <div className="page-nav">
        <Button type="text" size="small" onClick={() => navigate('/')}>
          ← 返回首页
        </Button>
        <span className="page-nav-title">
          彩色照片转正片（
          {paletteMode === 'rgbkw' ? 'RGB+黑+白' : paletteMode === 'rgbw' ? 'RGB+白' : 'RGB+黑'} ·
          测试版）
        </span>
      </div>

      <div className="colorneg-body">
        <div className="colorneg-panel">
          <List size="large" header="上传彩色照片，生成多色正片">
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
                    className="colorneg-collapse-head"
                    onClick={() => setPreviewOpen((o) => !o)}
                  >
                    <span className="title">原图 / 预览图</span>
                    <span className="colorneg-collapse-icon">{previewOpen ? '收起 ▲' : '展开 ▼'}</span>
                  </div>
                  {previewOpen ? (
                    <>
                      <ZoomableImage src={imageUrl} alt="原图" className="colorneg-fullimg" />
                      <div className="colorneg-cap">原图</div>
                      {ditherUrl ? (
                        <>
                          <ZoomableImage
                            src={ditherUrl}
                            alt="预览图"
                            pixelated
                            className="colorneg-fullimg colorneg-dither"
                          />
                          <div className="colorneg-cap">预览图</div>
                        </>
                      ) : null}
                    </>
                  ) : null}
                </List.Item>

                <List.Item key="palette">
                  <div className="title">配色方案</div>
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

                <List.Item key="size">
                  <div className="title">成像区长边长度 (mm)</div>
                  <div className="describe">成品图像区长边的物理尺寸，短边按图片比例自动缩放。</div>
                  <div className="describe">
                    常见照片尺寸（点击设置长边）：
                    {PhotoSizeMap.map((i) => (
                      <Tag
                        key={i.name}
                        className="colorneg-size-tag"
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
                  <div className="title">厚度</div>
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
                    总厚度 {totalThickness.toFixed(2)} mm（染色 {colorThickness.toFixed(2)} + 底片{' '}
                    {baseThickness.toFixed(2)}）
                  </div>
                </List.Item>

                <List.Item key="border">
                  <div className="title">边框</div>
                  <div className="colorneg-switch">
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
                    <div className="title">生成信息</div>
                    <div className="colorneg-stats">
                      <Tag color="arcoblue">
                        逻辑像素 {stats.cols} × {stats.rows}
                      </Tag>
                      <Tag color="green">
                        物理尺寸 {stats.widthMm.toFixed(1)} × {stats.heightMm.toFixed(1)} mm
                      </Tag>
                    </div>
                    <div className="colorneg-counts">
                      {palette.map((p, i) => (
                        <span key={p.id} className="colorneg-count">
                          <i
                            className="colorneg-swatch"
                            style={{ background: `rgb(${p.rgb.join(',')})` }}
                          />
                          {p.label} {((stats.counts[i] / stats.total) * 100).toFixed(1)}%
                        </span>
                      ))}
                    </div>
                  </List.Item>
                ) : null}

                <List.Item key="export">
                  <div className="title">导出</div>
                  <div className="describe">
                    模型随参数自动生成，右侧实时预览着色效果。
                  </div>
                  <Button
                    type="primary"
                    size="large"
                    long
                    loading={exporting}
                    disabled={!viewObject || generating}
                    onClick={onExport}
                  >
                    导出多色 3MF
                  </Button>
                </List.Item>
              </>
            ) : null}
          </List>
        </div>

        <div className="colorneg-viewer">
          <Spin loading={generating} tip="生成模型中…" style={{ width: '100%', height: '100%' }}>
            {viewObject ? (
              <ModelViewer object={viewObject} className="colorneg-3d" />
            ) : (
              <div className="colorneg-empty">
                上传图片、设置参数后
                <br />
                点「生成 3D 模型」在此预览着色效果
              </div>
            )}
          </Spin>
        </div>
      </div>
    </div>
  );
};

export default ColorNeg;
