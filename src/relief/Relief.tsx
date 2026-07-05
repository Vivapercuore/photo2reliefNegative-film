import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Radio,
  InputNumber,
  Switch,
  Upload,
  Button,
  Progress,
  Tag,
  Message,
  // @ts-ignore arco 类型偶尔解析不到
} from '@arco-design/web-react';
import { debounce } from 'lodash-es';
import * as THREE from 'three';
import './Relief.css';

import { Config } from '../dataProcess/type';
import { PhotoSizeMap } from '../constants';
import { useDocumentTitle } from '../useDocumentTitle';
import PageNav from '../components/PageNav';
import ModelViewer from '../laser/viewer/ModelViewer';
import ZoomableImage from '../ZoomableImage';
import CropEditor from '../imageEdit/CropEditor';
import { renderEdited, NO_CROP, defaultColorAdjust, CropRect } from '../imageEdit/imageEdit';
import { pack3mf, BambuTemplate, Pack3mfOptions, makeThumbnails } from 'bambu-3mf';
import type { ReliefRequest, ReliefResponse } from './worker/relief.worker';

/** Relief uses the shared editor for CROP only (it's grayscale) — a fixed
 *  identity colour adjust so renderEdited just crops + scales. */
const RELIEF_NO_COLOR = defaultColorAdjust([]);

const RadioGroup = Radio.Group;

enum PresetMode {
  default = 'default',
  precision = 'precision',
  speed = 'speed',
  custom = 'custom',
}

/** Base print preset → its template folder, short label, and nozzle diameter. */
const PRESET_INFO = {
  precision: { template: 'relief/precision' as BambuTemplate, label: '细腻', nozzle: '0.2' },
  default: { template: 'relief/default' as BambuTemplate, label: '标准', nozzle: '0.4' },
  speed: { template: 'relief/speed' as BambuTemplate, label: '快速', nozzle: '0.4' },
};

/** Sanitize an uploaded file name for use as a download base name. */
function safeBaseName(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, '') // drop extension
      .replace(/[\\/:*?"<>|]+/g, '_')
      .trim() || 'relief'
  );
}

const PRESET_LABEL: Record<PresetMode, string> = {
  [PresetMode.precision]: '细腻配置',
  [PresetMode.default]: '标准设置',
  [PresetMode.speed]: '快速模式',
  [PresetMode.custom]: '自定义（层高已同步到工艺）',
};

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

const Relief: React.FC = () => {
  useDocumentTitle('照片转浮雕负片');

  // parameters (same semantics as the legacy tool)
  const [preset, setPreset] = useState(PresetMode.default);
  const [BaseDeep, setBaseDeep] = useState(0.16);
  const [LayerDeep, setLayerDeep] = useState(0.08);
  const [MaxLength, setMaxLength] = useState(127);
  const [MaxDeep, setMaxDeep] = useState(2.6);
  const [Quality, setQuality] = useState(5);
  const [AddBorder, setAddBorder] = useState(true);
  const [PreventWhiteHollow, setPreventWhiteHollow] = useState(true);
  const [BorderWidth, setBorderWidth] = useState(2);
  const [BorderHeight, setBorderHeight] = useState(3);

  useEffect(() => {
    if (preset === PresetMode.default) {
      setBaseDeep(0.16);
      setLayerDeep(0.08);
    } else if (preset === PresetMode.precision) {
      setBaseDeep(0.08);
      setLayerDeep(0.04);
    } else if (preset === PresetMode.speed) {
      setBaseDeep(0.2);
      setLayerDeep(0.2);
    }
  }, [preset]);

  const [imageUrl, setImageUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const [previewOpen, setPreviewOpen] = useState(true);
  const imgElRef = useRef<HTMLImageElement | null>(null);
  const [natSize, setNatSize] = useState({ w: 0, h: 0 });
  const [crop, setCrop] = useState<CropRect>(NO_CROP);

  const [progress, setProgress] = useState(0);
  const [progressInfo, setProgressInfo] = useState('');
  const [building, setBuilding] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const geomRef = useRef<THREE.BufferGeometry | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [viewObject, setViewObject] = useState<THREE.Object3D | null>(null);
  const [stats, setStats] = useState<{ triangles: number; size: { x: number; y: number; z: number } } | null>(
    null
  );

  // print size (image area, before border) for display
  const printSize = useMemo(() => {
    const w = natSize.w * crop.w;
    const h = natSize.h * crop.h;
    if (!w || !h) return { width: '0', height: '0' };
    const scala = Math.min(MaxLength / h, MaxLength / w);
    return { width: (w * scala).toFixed(2), height: (h * scala).toFixed(2) };
  }, [natSize, crop, MaxLength]);

  const disposeView = useCallback(() => {
    if (meshRef.current) {
      const m = meshRef.current.material as THREE.Material | THREE.Material[];
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m.dispose();
      meshRef.current = null;
    }
    if (geomRef.current) {
      geomRef.current.dispose();
      geomRef.current = null;
    }
  }, []);

  // Paint the worker's grayscale depth-level preview onto the panel canvas.
  const renderPreview = useCallback((preview: Uint8Array, width: number, height: number) => {
    if (!width || !height) {
      setPreviewUrl('');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(width, height);
    for (let i = 0; i < preview.length; i++) {
      const g = preview[i];
      const idx = i * 4;
      img.data[idx] = g;
      img.data[idx + 1] = g;
      img.data[idx + 2] = g;
      img.data[idx + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    setPreviewUrl(canvas.toDataURL());
  }, []);

  // file upload → data URL + intrinsic size
  const onFile = useCallback((file: File) => {
    setFileName(file.name);
    setCrop(NO_CROP); // 新图重置裁剪
    const reader = new FileReader();
    reader.onload = (ev) => {
      const url = ev.target?.result as string;
      setImageUrl(url);
      const img = new Image();
      img.onload = () => {
        imgElRef.current = img;
        setNatSize({ w: img.naturalWidth, h: img.naturalHeight });
      };
      img.src = url;
    };
    reader.readAsDataURL(file);
  }, []);

  // run the worker (debounced) whenever inputs change
  const runWorker = useMemo(
    () =>
      debounce((canvas: HTMLCanvasElement, config: Config) => {
        if (!workerRef.current) return;
        setBuilding(true);
        setProgress(1);
        setProgressInfo('准备数据');
        createImageBitmap(canvas)
          .then((bitmap) => {
            const req: ReliefRequest = { bitmap, config };
            workerRef.current!.postMessage(req, [bitmap]);
          })
          .catch((err) => {
            setBuilding(false);
            Message.error(`图片解码失败：${err?.message || err}`);
          });
      }, 350),
    []
  );

  // init worker once
  useEffect(() => {
    const worker = new Worker(new URL('./worker/relief.worker.ts', import.meta.url));
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<ReliefResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        setProgress(msg.percent);
        setProgressInfo(msg.info);
      } else if (msg.type === 'error') {
        setBuilding(false);
        Message.error(`生成失败：${msg.message}`);
      } else if (msg.type === 'done') {
        disposeView();
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(msg.positions, 3));
        geom.computeVertexNormals();
        geomRef.current = geom;
        const material = new THREE.MeshStandardMaterial({
          color: new THREE.Color(0.78, 0.74, 0.7),
          roughness: 0.9,
          metalness: 0,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geom, material);
        // centre on Y so it rests nicely in the viewer
        mesh.position.y = -msg.size.y / 2;
        meshRef.current = mesh;
        const group = new THREE.Group();
        group.add(mesh);
        setViewObject(group);
        setStats({ triangles: msg.triangles, size: msg.size });
        renderPreview(msg.preview, msg.previewWidth, msg.previewHeight);
        setBuilding(false);
      }
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
      disposeView();
    };
  }, [disposeView, renderPreview]);

  // trigger recompute when image or params change
  useEffect(() => {
    const img = imgElRef.current;
    if (!img || !img.naturalWidth) return;
    const config: Config = {
      BaseDeep,
      LayerDeep,
      MaxLength,
      MaxDeep,
      Quality,
      AddBorder,
      PreventWhiteHollow,
      BorderWidth,
      BorderHeight,
    };
    // 裁剪后的图作为输入（灰度，无色彩调整）；长边封顶 4096 足够浮雕网格
    const edited = renderEdited(img, img.naturalWidth, img.naturalHeight, crop, RELIEF_NO_COLOR, [], 4096);
    runWorker(edited, config);
  }, [
    imageUrl,
    crop,
    BaseDeep,
    LayerDeep,
    MaxLength,
    MaxDeep,
    Quality,
    AddBorder,
    PreventWhiteHollow,
    BorderWidth,
    BorderHeight,
    runWorker,
  ]);

  const [exporting, setExporting] = useState(false);

  // Export a Bambu .3mf carrying the selected preset's 工艺参数 + 项目信息.
  const onExport3mf = useCallback(async () => {
    const geom = geomRef.current;
    if (!geom) {
      Message.warning('请先上传图片并生成模型');
      return;
    }
    const isCustom = preset === PresetMode.custom;
    // Pick the base preset. Custom chooses by single-layer height: a fine layer
    // (≤0.06) belongs to the 0.2-nozzle 细腻 base, otherwise the 0.4-nozzle 标准.
    const base =
      preset === PresetMode.precision
        ? PRESET_INFO.precision
        : preset === PresetMode.speed
        ? PRESET_INFO.speed
        : preset === PresetMode.default
        ? PRESET_INFO.default
        : LayerDeep <= 0.06
        ? PRESET_INFO.precision
        : PRESET_INFO.default;

    setExporting(true);
    try {
      // Custom: force print layer height to the geometry's layers, mark it as
      // modified, and neutralise the profile-level identity (keep model-level).
      const options: Pack3mfOptions = isCustom
        ? {
            projectSettingsOverrides: {
              layer_height: String(LayerDeep),
              initial_layer_print_height: String(BaseDeep),
            },
            markModified: ['layer_height', 'initial_layer_print_height'],
            metadataOverrides: {
              ProfileTitle: `自定义（基于${base.label}配置）`,
              // Keep the base preset's DesignProfileId (link to the nearest
              // published profile), but regenerate ProfileDescription so it
              // matches the actual custom parameters instead of the base's.
              // Values are single-escaped HTML; escapeXml double-escapes them
              // to match how Bambu stores ProfileDescription.
              ProfileDescription:
                `&lt;p&gt;${LayerDeep}mm 层高&lt;/p&gt;` +
                `&lt;p&gt;${BaseDeep}mm 首层&lt;/p&gt;` +
                `&lt;p&gt;100%充填&lt;/p&gt;` +
                `&lt;p&gt;自定义参数（基于${base.label}配置）&lt;/p&gt;`,
            },
          }
        : {};

      // 缩略图：用深度预览图生成，资源管理器与 Bambu 项目浏览器显示文件预览
      try {
        if (previewUrl) options.thumbnails = await makeThumbnails(previewUrl);
      } catch {
        // 缩略图失败不阻断导出
      }

      const u8 = await pack3mf(
        base.template,
        [{ name: 'photo-relief', geometry: geom }],
        undefined,
        options
      );

      // 原图名-喷嘴直径-基准预设-是否自定义.3mf
      const fname = `${safeBaseName(fileName)}-${base.nozzle}mm-${base.label}-${
        isCustom ? '自定义' : '预设'
      }.3mf`;
      saveBlob(u8, fname);
      Message.success('3MF 已导出（含拓竹工艺参数与项目信息）');
    } catch (e: any) {
      Message.error(`导出失败：${e?.message || e}`);
    } finally {
      setExporting(false);
    }
  }, [preset, LayerDeep, BaseDeep, fileName, previewUrl]);

  const sizeText = stats
    ? `${stats.size.x.toFixed(1)} × ${stats.size.z.toFixed(1)} × ${stats.size.y.toFixed(2)} mm`
    : '—';

  return (
    <div className="relief">
      <PageNav title="照片转浮雕负片" code="RELIEF" />

      <div className="relief-body">
        <div className="relief-panel">
          {/* 输入 INPUT ------------------------------------------------- */}
          <section className="lx-panel relief-section">
            <div className="lx-eyebrow">
              <span>输入</span>
              <span className="lx-eyebrow-code">INPUT</span>
            </div>
            <div className="relief-field-label">选择图像</div>
            <div className="describe">支持 jpg/png/jpeg。全部处理在本地浏览器完成，不上传服务器。</div>
            <Upload
              drag
              accept="image/*"
              limit={1}
              showUploadList
              autoUpload={false}
              onChange={(list: any[]) => {
                const f = list && list[list.length - 1];
                if (f?.originFile) onFile(f.originFile);
              }}
              tip="仅支持图片"
            />
            {imageUrl ? (
              <>
                <div
                  className="relief-collapse-head"
                  onClick={() => setPreviewOpen((o) => !o)}
                >
                  <span className="relief-field-label">原图 / 黑白预览</span>
                  <span className="relief-collapse-icon">{previewOpen ? '收起 ▲' : '展开 ▼'}</span>
                </div>
                {previewOpen ? (
                  <>
                    <div className="relief-field-label" style={{ marginTop: 12 }}>
                      原图 / 裁剪
                    </div>
                    <div className="describe">拖动选框移动、八向手柄改尺寸、上方选比例；裁剪直接作用于原图。</div>
                    {imageUrl && natSize.w ? (
                      <CropEditor
                        src={imageUrl}
                        naturalWidth={natSize.w}
                        naturalHeight={natSize.h}
                        value={crop}
                        onChange={setCrop}
                        longEdgeMm={MaxLength}
                        onLongEdgeChange={(mm) => setMaxLength(Math.min(1000, Math.max(1, Math.round(mm))))}
                      />
                    ) : (
                      <ZoomableImage src={imageUrl} alt="原图" className="relief-input-img lx-panel-inset" />
                    )}
                    <div className="relief-field-label" style={{ marginTop: 12 }}>
                      黑白预览（按实际色阶）
                    </div>
                    <div className="describe">
                      依据量化后的实际打印深度生成：越厚越暗、越薄越亮，用于预估成片明暗效果。
                    </div>
                    {previewUrl ? (
                      <ZoomableImage
                        src={previewUrl}
                        alt="黑白预览"
                        pixelated
                        className="relief-preview-canvas lx-panel-inset"
                      />
                    ) : (
                      <div className="describe">生成模型后将在此显示黑白预览。</div>
                    )}
                  </>
                ) : null}
              </>
            ) : null}
          </section>

          {imageUrl ? (
            <>
              {/* 预设 PRESET -------------------------------------------- */}
              <section className="lx-panel relief-section">
                <div className="lx-eyebrow">
                  <span>预设</span>
                  <span className="lx-eyebrow-code">PRESET</span>
                </div>
                <div className="relief-field-label">使用哪种预设</div>
                <div className="describe">
                  预设决定层高组合（喷嘴/打印质量相关）。选“自定义”可手动调层高。
                </div>
                <RadioGroup
                  type="button"
                  value={preset}
                  onChange={(v: PresetMode) => setPreset(v)}
                >
                  <Radio value={PresetMode.precision}>0.2 喷嘴高细腻</Radio>
                  <Radio value={PresetMode.default}>0.4 喷嘴标准</Radio>
                  <Radio value={PresetMode.speed}>0.4 喷嘴快速</Radio>
                  <Radio value={PresetMode.custom}>自定义</Radio>
                </RadioGroup>
              </section>

              {/* 层高 LAYERS -------------------------------------------- */}
              <section className="lx-panel relief-section">
                <div className="lx-eyebrow">
                  <span>层高</span>
                  <span className="lx-eyebrow-code">LAYERS</span>
                </div>
                <div className="relief-field-label">单层层高 (mm)</div>
                <div className="describe">打印机里的层高必须与此一致。非自定义时由预设决定。</div>
                <InputNumber
                  className="relief-num lx-data"
                  style={{ width: 180 }}
                  size="large"
                  mode="button"
                  suffix="mm"
                  disabled={preset !== PresetMode.custom}
                  min={0.04}
                  max={1}
                  step={0.02}
                  precision={2}
                  value={LayerDeep}
                  onChange={(v: number) => setLayerDeep(v)}
                />

                <div className="relief-field-label" style={{ marginTop: 16 }}>
                  首层层高 (mm)
                </div>
                <div className="describe">第一层的厚度（底板），打印机设置需一致。非自定义时由预设决定。</div>
                <InputNumber
                  className="relief-num lx-data"
                  style={{ width: 180 }}
                  size="large"
                  mode="button"
                  suffix="mm"
                  disabled={preset !== PresetMode.custom}
                  min={0.04}
                  max={2}
                  step={0.04}
                  precision={2}
                  value={BaseDeep}
                  onChange={(v: number) => setBaseDeep(v)}
                />
              </section>

              {/* 尺寸 DIMENSIONS ---------------------------------------- */}
              <section className="lx-panel relief-section">
                <div className="lx-eyebrow">
                  <span>尺寸</span>
                  <span className="lx-eyebrow-code">DIMENSIONS</span>
                </div>
                <div className="relief-field-label">成像区长边长度 (mm)</div>
                <div className="describe">不含边框，短边自动等比缩放。注意自己打印机的最大幅面。</div>
                <div className="describe">
                  常见照片尺寸（点击设置长边）：
                  {PhotoSizeMap.map((i) => (
                    <Tag
                      key={i.name}
                      className="relief-size-tag"
                      onClick={() => setMaxLength(Math.max(i.width, i.height))}
                    >
                      {i.name}
                    </Tag>
                  ))}
                </div>
                <InputNumber
                  className="relief-num lx-data"
                  style={{ width: 180 }}
                  size="large"
                  mode="button"
                  suffix="mm"
                  min={1}
                  max={1000}
                  step={1}
                  precision={1}
                  value={MaxLength}
                  onChange={(v: number) => setMaxLength(v)}
                />
                <div className="describe relief-readout" style={{ marginTop: 8 }}>
                  图像区尺寸：<span className="lx-data">{printSize.width} × {printSize.height}</span> mm
                  {AddBorder ? (
                    <>
                      ；含边框约{' '}
                      <span className="lx-data">
                        {(Number(printSize.width) + BorderWidth * 2).toFixed(1)} ×{' '}
                        {(Number(printSize.height) + BorderWidth * 2).toFixed(1)}
                      </span>{' '}
                      mm
                    </>
                  ) : (
                    ''
                  )}
                </div>

                <div className="relief-field-label" style={{ marginTop: 16 }}>
                  成像区最大厚度 (mm)
                </div>
                <div className="describe">含首层，不含边框。按材料透光性设置：越厚明暗对比越强。</div>
                <InputNumber
                  className="relief-num lx-data"
                  style={{ width: 180 }}
                  size="large"
                  mode="button"
                  suffix="mm"
                  min={1}
                  max={20}
                  step={0.5}
                  precision={1}
                  value={MaxDeep}
                  onChange={(v: number) => setMaxDeep(v)}
                />

                <div className="relief-field-label" style={{ marginTop: 16 }}>
                  精细度（每 mm 像素数）
                </div>
                <div className="describe">与打印机 XY 分辨率相关，建议 A1/P1/X1 取 4/8/10。</div>
                <div className="describe">越高模型越精细，但三角面数与切片时间会大幅上升。</div>
                <InputNumber
                  className="relief-num lx-data"
                  style={{ width: 180 }}
                  size="large"
                  mode="button"
                  min={1}
                  max={20}
                  step={1}
                  precision={0}
                  value={Quality}
                  onChange={(v: number) => setQuality(v)}
                />
              </section>

              {/* 边框 BORDER -------------------------------------------- */}
              <section className="lx-panel relief-section">
                <div className="lx-eyebrow">
                  <span>边框</span>
                  <span className="lx-eyebrow-code">BORDER</span>
                </div>
                <div className="relief-switch">
                  <Switch checked={AddBorder} onChange={(v: boolean | string | number) => setAddBorder(Boolean(v))} />{' '}
                  <span>在四周生成一圈边框</span>
                </div>
                {AddBorder ? (
                  <div className="relief-border-params">
                    <div className="relief-param">
                      <span>边框宽度</span>
                      <InputNumber
                        className="relief-num lx-data"
                        style={{ width: 150 }}
                        mode="button"
                        suffix="mm"
                        min={0.1}
                        max={10}
                        step={Number((1 / Quality).toFixed(2))}
                        precision={2}
                        value={BorderWidth}
                        onChange={(v: number) =>
                          setBorderWidth(Number((Math.round(v * Quality) / Quality).toFixed(2)))
                        }
                      />
                    </div>
                    <div className="relief-param">
                      <span>边框高度</span>
                      <InputNumber
                        className="relief-num lx-data"
                        style={{ width: 150 }}
                        mode="button"
                        suffix="mm"
                        min={0}
                        max={20}
                        step={0.5}
                        precision={1}
                        value={BorderHeight}
                        onChange={(v: number) => setBorderHeight(v)}
                      />
                      <span className="relief-param-hint">
                        建议比最大厚度 <span className="lx-data">{MaxDeep}mm</span> 高
                      </span>
                    </div>
                  </div>
                ) : null}
              </section>

              {/* 选项 OPTIONS ------------------------------------------- */}
              <section className="lx-panel relief-section">
                <div className="lx-eyebrow">
                  <span>选项</span>
                  <span className="lx-eyebrow-code">OPTIONS</span>
                </div>
                <div className="relief-field-label">防止纯白镂空</div>
                <div className="describe">关闭后，纯白区域可能被镂空（厚度为 0）。建议保持开启。</div>
                <div className="relief-switch">
                  <Switch
                    checked={PreventWhiteHollow}
                    onChange={(v: boolean | string | number) => setPreventWhiteHollow(Boolean(v))}
                  />{' '}
                  <span>开启</span>
                </div>
              </section>

              {/* 导出 EXPORT -------------------------------------------- */}
              <section className="lx-panel relief-section">
                <div className="lx-eyebrow">
                  <span>导出</span>
                  <span className="lx-eyebrow-code">EXPORT</span>
                </div>
                <div className="relief-field-label">生成进度</div>
                <Progress percent={progress} formatText={() => progressInfo} />

                <div className="describe relief-readout" style={{ marginTop: 16 }}>
                  成品尺寸（宽×长×厚）：<span className="lx-data">{sizeText}</span>
                  {stats ? (
                    <>
                      ；三角面 <span className="lx-data">{stats.triangles.toLocaleString()}</span>
                    </>
                  ) : (
                    ''
                  )}
                </div>
                <Button
                  type="primary"
                  size="large"
                  long
                  loading={exporting}
                  disabled={building || exporting || !stats}
                  onClick={onExport3mf}
                >
                  导出 3MF（含拓竹工艺参数）
                </Button>
                <div className="describe" style={{ marginTop: 8 }}>
                  已内置「{PRESET_LABEL[preset]}」打印工艺，打开3mf文件即可打印。
                </div>
              </section>
            </>
          ) : null}
        </div>

        <div className="relief-viewer lx-viewport">
          {viewObject ? (
            <>
              <ModelViewer object={viewObject} className="relief-canvas" />
              {stats ? (
                <div className="lx-viewport-hud relief-hud">
                  {stats.size.x.toFixed(1)} × {stats.size.z.toFixed(1)} × {stats.size.y.toFixed(2)} mm
                  {' · '}
                  {stats.triangles.toLocaleString()} 面
                </div>
              ) : null}
            </>
          ) : (
            <div className="lx-empty relief-empty">
              <div className="relief-empty-title">还没有模型</div>
              <div className="relief-empty-hint">上传一张照片，浮雕负片会在此实时成形</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Relief;
