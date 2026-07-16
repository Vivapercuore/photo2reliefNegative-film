import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Radio,
  InputNumber,
  Upload,
  Button,
  Progress,
  Tag,
  Message,
  // @ts-ignore arco 类型偶尔解析不到
} from '@arco-design/web-react';
import { debounce } from 'lodash-es';
import * as THREE from 'three';
import './ColorPositive.css';

import { PhotoSizeMap } from '../constants';
import { useDocumentTitle } from '../useDocumentTitle';
import PageNav from '../components/PageNav';
import ModelViewer from '../laser/viewer/ModelViewer';
import CropEditor from '../imageEdit/CropEditor';
import { renderEdited, NO_CROP, defaultColorAdjust, CropRect } from '../imageEdit/imageEdit';
import { pack3mf, Pack3mfOptions, makeThumbnails } from 'bambu-3mf';
import {
  Band,
  PrintParams,
  ChangeMode,
  bandZTable,
  layerTopZ,
  buildExportOptions,
  DEFAULT_BASE_LAYERS,
  DEFAULT_LAYER_HEIGHT,
  FIRST_LAYER_HEIGHT,
  LAYER_HEIGHT_OPTIONS,
  MIN_COLORS,
  MAX_COLORS,
} from './bands';
import { createBandMaterial, updateBandMaterial } from './heightShader';
import type { QuantizeRequest, GeometryRequest, ColorResponse } from './worker/color.worker';
import PaletteBands from './PaletteBands';

const RadioGroup = Radio.Group;

/** 只用共享编辑器的裁剪（不调色——量化本身就是本模块的色彩处理） */
const CP_NO_COLOR = defaultColorAdjust([]);

function safeBaseName(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, '')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .trim() || 'color'
  );
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

/** 几何请求的等价键：顺序/层数/层高/底板一致则几何不必重建 */
const makeGeomKey = (b: Band[], p: PrintParams) =>
  `${b.map((x) => `${x.label}:${x.layers}`).join('>')}|${p.layerHeight}|${p.baseLayers}`;

const ColorPositive: React.FC = () => {
  useDocumentTitle('照片转多色正片');

  // —— 输入 ——
  const [imageUrl, setImageUrl] = useState('');
  const [fileName, setFileName] = useState('');
  const imgElRef = useRef<HTMLImageElement | null>(null);
  const [natSize, setNatSize] = useState({ w: 0, h: 0 });
  const [crop, setCrop] = useState<CropRect>(NO_CROP);

  // —— 色板 ——
  const [bands, setBands] = useState<Band[] | null>(null); // 底→顶；null = 等待自动提取
  const bandsRef = useRef<Band[] | null>(null);
  bandsRef.current = bands;
  const [customized, setCustomized] = useState(false); // 用户改过颜色/顺序 → 不再自动覆盖
  const [colorCount, setColorCount] = useState(4);
  const [extractSeq, setExtractSeq] = useState(0); // 「重新提取」手动触发计数
  const [counts, setCounts] = useState<number[] | null>(null);

  // —— 模型 ——
  const [layerHeight, setLayerHeight] = useState<number>(DEFAULT_LAYER_HEIGHT);
  const [baseLayers, setBaseLayers] = useState(DEFAULT_BASE_LAYERS);
  const [quality, setQuality] = useState(5);
  const [maxLength, setMaxLength] = useState(127);

  // —— 打印 ——
  const [changeMode, setChangeMode] = useState<ChangeMode>('ams');

  // —— 运行状态 ——
  const [progress, setProgress] = useState(0);
  const [progressInfo, setProgressInfo] = useState('');
  const [building, setBuilding] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [quantPreviewUrl, setQuantPreviewUrl] = useState('');
  const [viewObject, setViewObject] = useState<THREE.Object3D | null>(null);
  const [revision, setRevision] = useState(0);
  const [stats, setStats] = useState<{
    triangles: number;
    size: { x: number; y: number; z: number };
  } | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const geomRef = useRef<THREE.BufferGeometry | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const materialRef = useRef<THREE.ShaderMaterial | null>(null);
  /** 最近一次已发给 worker 的几何键（防止量化通道刚建完几何又被几何 effect 重复重建） */
  const builtKeyRef = useRef('');

  const print: PrintParams = useMemo(
    () => ({ layerHeight, firstLayerHeight: FIRST_LAYER_HEIGHT, baseLayers }),
    [layerHeight, baseLayers]
  );
  const printRef = useRef(print);
  printRef.current = print;
  const maxLengthRef = useRef(maxLength);
  maxLengthRef.current = maxLength;
  const qualityRef = useRef(quality);
  qualityRef.current = quality;

  const zTable = useMemo(() => (bands ? bandZTable(bands, print) : []), [bands, print]);
  const totalLayerCount = useMemo(
    () => (bands ? baseLayers + bands.reduce((s, b) => s + b.layers, 0) : 0),
    [bands, baseLayers]
  );
  const totalHeight = bands ? layerTopZ(totalLayerCount, print) : 0;

  // 成像区物理尺寸（随裁剪/长边实时换算）
  const printSize = useMemo(() => {
    const w = natSize.w * crop.w;
    const h = natSize.h * crop.h;
    if (!w || !h) return { width: '0', height: '0' };
    const scala = Math.min(maxLength / h, maxLength / w);
    return { width: (w * scala).toFixed(2), height: (h * scala).toFixed(2) };
  }, [natSize, crop, maxLength]);

  const disposeView = useCallback(() => {
    if (materialRef.current) {
      materialRef.current.dispose();
      materialRef.current = null;
    }
    if (geomRef.current) {
      geomRef.current.dispose();
      geomRef.current = null;
    }
    meshRef.current = null;
  }, []);

  // 量化预览（RGBA）→ dataURL；同时是 3MF 缩略图来源
  const renderPreview = useCallback((preview: Uint8ClampedArray, width: number, height: number) => {
    if (!width || !height) {
      setQuantPreviewUrl('');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(preview, width, height), 0, 0);
    setQuantPreviewUrl(canvas.toDataURL());
  }, []);

  // —— worker 两个通道（量化 350ms / 仅几何 150ms 防抖） ——
  const runQuantize = useMemo(
    () =>
      debounce((canvas: HTMLCanvasElement, req: Omit<QuantizeRequest, 'bitmap'>) => {
        if (!workerRef.current) return;
        setBuilding(true);
        setProgress(1);
        setProgressInfo('准备数据');
        createImageBitmap(canvas)
          .then((bitmap) => {
            workerRef.current!.postMessage({ ...req, bitmap }, [bitmap]);
          })
          .catch((err) => {
            setBuilding(false);
            Message.error(`图片解码失败：${err?.message || err}`);
          });
      }, 350),
    []
  );
  const runGeometry = useMemo(
    () =>
      debounce((req: GeometryRequest) => {
        if (!workerRef.current) return;
        setBuilding(true);
        setProgress(1);
        setProgressInfo('重建几何');
        workerRef.current.postMessage(req);
      }, 150),
    []
  );

  /** 发起量化（bandsForReq=null → 自动提取 colorCount 色） */
  const kickQuantize = useCallback(
    (bandsForReq: Band[] | null) => {
      const img = imgElRef.current;
      if (!img || !img.naturalWidth) return;
      const edited = renderEdited(img, img.naturalWidth, img.naturalHeight, crop, CP_NO_COLOR, [], 4096);
      builtKeyRef.current = bandsForReq ? makeGeomKey(bandsForReq, printRef.current) : '';
      runQuantize(edited, {
        type: 'quantize',
        autoExtract: !bandsForReq,
        autoN: colorCount,
        config: { maxLength, quality, bands: bandsForReq ?? [], print: printRef.current },
      });
    },
    [crop, colorCount, maxLength, quality, runQuantize]
  );

  // init worker once
  useEffect(() => {
    const worker = new Worker(new URL('./worker/color.worker.ts', import.meta.url));
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<ColorResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        setProgress(msg.percent);
        setProgressInfo(msg.info);
        return;
      }
      if (msg.type === 'error') {
        setBuilding(false);
        Message.error(`生成失败：${msg.message}`);
        return;
      }
      // done —— 图已删除/更换时丢弃陈旧结果（与 relief 同一机制）
      if (!imgElRef.current) return;
      const nextBands = msg.bands ?? bandsRef.current;
      if (!nextBands) return;
      if (msg.bands) {
        setBands(msg.bands);
        setCustomized(false);
      }
      if (msg.counts) setCounts(msg.counts);
      if (msg.preview && msg.previewWidth && msg.previewHeight) {
        renderPreview(msg.preview, msg.previewWidth, msg.previewHeight);
      }
      // 几何：单一 mesh/material，只换 geometry（调参时相机不会被重置）
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(msg.positions, 3));
      geom.computeVertexNormals();
      if (geomRef.current) geomRef.current.dispose();
      geomRef.current = geom;
      if (!materialRef.current) materialRef.current = createBandMaterial();
      // 用回显配置（本次网格实际构建时所用）算色带高度，而非实时 state——
      // 避免用户在防抖/计算期间改了层高/底板时，材质与几何脱节
      const zt = bandZTable(msg.config.bands, msg.config.print);
      updateBandMaterial(
        materialRef.current,
        zt.map((z) => z.zTop),
        msg.config.bands.map((b) => b.color)
      );
      if (!meshRef.current) {
        const mesh = new THREE.Mesh(geom, materialRef.current);
        meshRef.current = mesh;
        const group = new THREE.Group();
        group.add(mesh);
        setViewObject(group);
      } else {
        meshRef.current.geometry = geom;
      }
      setRevision((r) => r + 1);
      setStats({ triangles: msg.triangles, size: msg.size });
      setBuilding(false);
      // 以回显配置为准登记已建几何；若用户在途中改了顺序/层数/层高/底板，
      // 回显键与实时键不一致 —— 立即补发一次几何重建，保证最终一致
      builtKeyRef.current = makeGeomKey(msg.config.bands, msg.config.print);
      const liveBands = msg.bands ?? bandsRef.current;
      if (liveBands) {
        const liveKey = makeGeomKey(liveBands, printRef.current);
        if (liveKey !== builtKeyRef.current) {
          builtKeyRef.current = liveKey;
          runGeometry({
            type: 'geometry',
            config: {
              maxLength: maxLengthRef.current,
              quality: qualityRef.current,
              bands: liveBands,
              print: printRef.current,
            },
          });
        }
      }
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
      disposeView();
    };
  }, [disposeView, renderPreview, runGeometry]);

  // 量化触发：图/裁剪/尺寸/精细度/颜色数/手动重提 变化 → 全量重算
  // （色板颜色编辑不走这里——onBandColor 里显式 kickQuantize，避免 effect 回环）
  useEffect(() => {
    if (!imgElRef.current) return;
    // bands 为 null（新图未提取 / 改颜色数 / 手动重提）→ 自动提取；否则沿用当前色板重量化
    kickQuantize(bandsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, crop, natSize, maxLength, quality, colorCount, extractSeq]);

  // 仅几何触发：顺序/层数/层高/底板层数 变化 → 复用标签图快速重建
  useEffect(() => {
    const b = bandsRef.current;
    if (!b || !meshRef.current) return;
    const key = makeGeomKey(b, print);
    if (key === builtKeyRef.current) return;
    builtKeyRef.current = key;
    runGeometry({
      type: 'geometry',
      config: { maxLength, quality, bands: b, print },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bands, print]);

  // —— 色板交互 ——
  const onBandColor = useCallback(
    (label: number, color: string) => {
      const cur = bandsRef.current;
      if (!cur) return;
      const next = cur.map((b) => (b.label === label ? { ...b, color } : b));
      setBands(next);
      setCustomized(true);
      kickQuantize(next); // 改色 → 最近色重新分配（复用不了标签图）
    },
    [kickQuantize]
  );

  const onBandLayers = useCallback((label: number, layers: number) => {
    const cur = bandsRef.current;
    if (!cur) return;
    const v = Math.max(1, Math.round(layers || 1));
    setBands(cur.map((b) => (b.label === label ? { ...b, layers: v } : b)));
  }, []);

  const onReorder = useCallback((from: number, to: number) => {
    const cur = bandsRef.current;
    if (!cur) return;
    const next = cur.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setBands(next);
    setCustomized(true);
  }, []);

  const onColorCountChange = useCallback((v: number) => {
    setColorCount(v);
    setBands(null); // 触发自动重提取
    setCounts(null);
  }, []);

  const reExtract = useCallback(() => {
    setBands(null);
    setCounts(null);
    setCustomized(false);
    setExtractSeq((s) => s + 1);
  }, []);

  // —— 上传 / 重置 ——
  const onFile = useCallback(
    (file: File) => {
      runQuantize.cancel();
      runGeometry.cancel();
      imgElRef.current = null;
      disposeView();
      setViewObject(null);
      setStats(null);
      setQuantPreviewUrl('');
      setProgress(0);
      setProgressInfo('');
      setBuilding(false);
      setCounts(null);
      builtKeyRef.current = '';
      if (!customized) setBands(null); // 自定义色板跨图保留；自动色板换图重提

      setFileName(file.name);
      setCrop(NO_CROP);
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
    },
    [customized, disposeView, runGeometry, runQuantize]
  );

  const resetAll = useCallback(() => {
    runQuantize.cancel();
    runGeometry.cancel();
    imgElRef.current = null;
    setImageUrl('');
    setFileName('');
    setNatSize({ w: 0, h: 0 });
    setCrop(NO_CROP);
    setBands(null);
    setCounts(null);
    setCustomized(false);
    setProgress(0);
    setProgressInfo('');
    setBuilding(false);
    setQuantPreviewUrl('');
    setViewObject(null);
    setStats(null);
    builtKeyRef.current = '';
    disposeView();
  }, [disposeView, runGeometry, runQuantize]);

  // —— 导出 ——
  const onExport3mf = useCallback(async () => {
    const geom = geomRef.current;
    const b = bandsRef.current;
    if (!geom || !b || !b.length) {
      Message.warning('请先上传图片并生成模型');
      return;
    }
    setExporting(true);
    try {
      const options: Pack3mfOptions = buildExportOptions(b, printRef.current, changeMode);
      try {
        if (quantPreviewUrl) options.thumbnails = await makeThumbnails(quantPreviewUrl);
      } catch {
        // 缩略图失败不阻断导出
      }
      const u8 = await pack3mf('color', [{ name: 'color-positive', geometry: geom }], undefined, options);
      const fname = `${safeBaseName(fileName)}-${b.length}色-${
        changeMode === 'ams' ? 'AMS换色' : '暂停换料'
      }.3mf`;
      saveBlob(u8, fname);
      Message.success(
        changeMode === 'ams'
          ? '3MF 已导出（AMS 自动换色）'
          : '3MF 已导出（每次换色自动暂停，手动换料后继续）'
      );
    } catch (e: any) {
      Message.error(`导出失败：${e?.message || e}`);
    } finally {
      setExporting(false);
    }
  }, [changeMode, fileName, quantPreviewUrl]);

  const sizeText = stats
    ? `${stats.size.x.toFixed(1)} × ${stats.size.z.toFixed(1)} × ${stats.size.y.toFixed(2)} mm`
    : '—';

  return (
    <div className="cp">
      <PageNav title="照片转多色正片" code="COLOR" />

      <div className="cp-body">
        <div className="cp-panel">
          {/* 图片 IMAGE ---------------------------------------------- */}
          <section className="lx-panel cp-section">
            <div className="lx-eyebrow">
              <span>图片</span>
              <span className="lx-eyebrow-code">IMAGE</span>
            </div>
            <div className="cp-field-label">选择图像</div>
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
                else if (!list || !list.length) resetAll();
              }}
              tip="仅支持图片"
            />
            {imageUrl && natSize.w ? (
              <>
                <div className="cp-field-label" style={{ marginTop: 12 }}>
                  原图 / 裁剪
                </div>
                <div className="describe">拖动选框移动、八向手柄改尺寸、上方选比例；裁剪直接作用于原图。</div>
                <CropEditor
                  src={imageUrl}
                  naturalWidth={natSize.w}
                  naturalHeight={natSize.h}
                  value={crop}
                  onChange={setCrop}
                  longEdgeMm={maxLength}
                  onLongEdgeChange={(mm) => setMaxLength(Math.min(1000, Math.max(1, Math.round(mm))))}
                />
              </>
            ) : null}
          </section>

          {imageUrl ? (
            <>
              {/* 色板 PALETTE ---------------------------------------- */}
              <section className="lx-panel cp-section">
                <div className="lx-eyebrow">
                  <span>色板</span>
                  <span className="lx-eyebrow-code">PALETTE</span>
                </div>
                <div className="cp-field-label">颜色数量</div>
                <div className="describe">
                  自动从图片提取主色；点色块可改成自己耗材的颜色，改后进入自定义状态。
                </div>
                <div className="cp-palette-head">
                  <InputNumber
                    className="lx-data"
                    style={{ width: 140 }}
                    mode="button"
                    min={MIN_COLORS}
                    max={MAX_COLORS}
                    step={1}
                    precision={0}
                    value={colorCount}
                    disabled={customized}
                    onChange={onColorCountChange}
                  />
                  <Button size="small" onClick={reExtract}>
                    重新提取
                  </Button>
                </div>
                {customized ? (
                  <div className="describe">色板已自定义；调整颜色数量前请先「重新提取」。</div>
                ) : null}
                {bands ? (
                  <PaletteBands
                    bands={bands}
                    zTable={zTable}
                    counts={counts}
                    onColorChange={onBandColor}
                    onLayersChange={onBandLayers}
                    onReorder={onReorder}
                  />
                ) : (
                  <div className="describe">正在提取主色…</div>
                )}
              </section>

              {/* 模型 MODEL ------------------------------------------ */}
              <section className="lx-panel cp-section">
                <div className="lx-eyebrow">
                  <span>模型</span>
                  <span className="lx-eyebrow-code">MODEL</span>
                </div>
                <div className="cp-field-label">层高 (mm)</div>
                <div className="describe">换色只发生在层边界；打印机层高必须与此一致。</div>
                <RadioGroup type="button" value={layerHeight} onChange={(v: number) => setLayerHeight(v)}>
                  {LAYER_HEIGHT_OPTIONS.map((lh) => (
                    <Radio key={lh} value={lh}>
                      {lh.toFixed(2)}
                    </Radio>
                  ))}
                </RadioGroup>

                <div className="cp-field-label" style={{ marginTop: 16 }}>
                  底板层数
                </div>
                <div className="describe">底板与最底部颜色同色连续，保证整体强度。首层层高固定 0.20mm。</div>
                <InputNumber
                  className="lx-data"
                  style={{ width: 140 }}
                  mode="button"
                  min={1}
                  max={50}
                  step={1}
                  precision={0}
                  value={baseLayers}
                  onChange={(v: number) => setBaseLayers(Math.max(1, Math.round(v || 1)))}
                />

                <div className="cp-field-label" style={{ marginTop: 16 }}>
                  成像区长边长度 (mm)
                </div>
                <div className="describe">
                  常见照片尺寸（点击设置长边）：
                  {PhotoSizeMap.map((i) => (
                    <Tag key={i.name} className="cp-size-tag" onClick={() => setMaxLength(Math.max(i.width, i.height))}>
                      {i.name}
                    </Tag>
                  ))}
                </div>
                <InputNumber
                  className="lx-data"
                  style={{ width: 180 }}
                  size="large"
                  mode="button"
                  suffix="mm"
                  min={1}
                  max={1000}
                  step={1}
                  precision={1}
                  value={maxLength}
                  onChange={(v: number) => setMaxLength(v)}
                />
                <div className="describe cp-readout" style={{ marginTop: 8 }}>
                  图像区尺寸：
                  <span className="lx-data">
                    {printSize.width} × {printSize.height}
                  </span>{' '}
                  mm
                </div>

                <div className="cp-field-label" style={{ marginTop: 16 }}>
                  精细度（每 mm 像素数）
                </div>
                <div className="describe">越高越精细，三角面数与切片时间也随之上升；建议 A1/P1/X1 取 4/8/10。</div>
                <InputNumber
                  className="lx-data"
                  style={{ width: 140 }}
                  mode="button"
                  min={1}
                  max={20}
                  step={1}
                  precision={0}
                  value={quality}
                  onChange={(v: number) => setQuality(v)}
                />

                <div className="describe cp-readout" style={{ marginTop: 12 }}>
                  成品总高：<span className="lx-data">{totalHeight.toFixed(2)}</span> mm（
                  <span className="lx-data">{totalLayerCount}</span> 层，其中底板{' '}
                  <span className="lx-data">{baseLayers}</span> 层）
                </div>
              </section>

              {/* 打印 PRINT ------------------------------------------ */}
              <section className="lx-panel cp-section">
                <div className="lx-eyebrow">
                  <span>打印</span>
                  <span className="lx-eyebrow-code">PRINT</span>
                </div>
                <div className="cp-field-label">换色方式</div>
                <RadioGroup type="button" value={changeMode} onChange={(v: ChangeMode) => setChangeMode(v)}>
                  <Radio value="ams">AMS 自动换色</Radio>
                  <Radio value="pause">暂停手动换料</Radio>
                </RadioGroup>
                {changeMode === 'ams' && bands && bands.length > 4 ? (
                  <div className="describe cp-warn" style={{ marginTop: 8 }}>
                    超过 4 色需要多个 AMS；单 AMS 用户建议切换「暂停手动换料」。
                  </div>
                ) : null}
                {changeMode === 'pause' ? (
                  <div className="describe" style={{ marginTop: 8 }}>
                    每到换色层打印机自动暂停（M400 U1），手动换料后点继续即可，无需 AMS。
                  </div>
                ) : null}

                <div className="cp-field-label" style={{ marginTop: 16 }}>
                  生成进度
                </div>
                <Progress percent={progress} formatText={() => progressInfo} />

                <div className="describe cp-readout" style={{ marginTop: 16 }}>
                  成品尺寸（宽×长×厚）：<span className="lx-data">{sizeText}</span>
                  {stats ? (
                    <>
                      ；三角面 <span className="lx-data">{stats.triangles.toLocaleString()}</span>；换色{' '}
                      <span className="lx-data">{bands ? bands.length - 1 : 0}</span> 次
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
                  导出 3MF（含分层换色）
                </Button>
                <div className="describe" style={{ marginTop: 8 }}>
                  已内置拓竹工艺参数与 {bands ? bands.length : 0} 色料表，打开 3mf 文件即可打印。
                </div>
              </section>
            </>
          ) : null}
        </div>

        <div className="cp-viewer lx-viewport">
          {viewObject ? (
            <>
              <ModelViewer object={viewObject} className="cp-canvas" revision={revision} />
              {quantPreviewUrl ? <img className="cp-thumb" src={quantPreviewUrl} alt="量化预览" /> : null}
              {stats ? (
                <div className="lx-viewport-hud cp-hud">
                  {stats.size.x.toFixed(1)} × {stats.size.z.toFixed(1)} × {stats.size.y.toFixed(2)} mm
                  {' · '}
                  {stats.triangles.toLocaleString()} 面{' · '}换色 {bands ? bands.length - 1 : 0} 次
                </div>
              ) : null}
            </>
          ) : (
            <div className="lx-empty cp-empty">
              <div className="cp-empty-title">还没有模型</div>
              <div className="cp-empty-hint">上传一张图片，多色正片会在此实时成形</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ColorPositive;
