import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  List,
  Upload,
  Button,
  Switch,
  InputNumber,
  Select,
  Message,
  Spin,
  Tag,
  Collapse,
  Table,
  // @ts-ignore arco 类型偶尔解析不到
} from '@arco-design/web-react';
import * as THREE from 'three';
import './LaserCut.css';

import { parseLac, LacModel } from './lac/parseLac';
import { buildModel, disposeBuild, BuildResult, BuildOptions, engraveColorAt } from './lac/buildMesh';
import ModelViewer from './viewer/ModelViewer';
import PathPreview from './viewer/PathPreview';
import { pack3mf } from 'bambu-3mf';
import { useDocumentTitle } from '../useDocumentTitle';

const Option = Select.Option;

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

function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

const ALL_PLATES = 0; // sentinel for "show every plate"

// Minimum mm to keep both below the deepest engrave (remaining material) and
// for the shallowest engrave (groove depth) when auto-picking the depth ratio.
const MIN_MARGIN_MM = 0.2;

/**
 * Adjust the default depthRatio (1) for a freshly loaded model only when it
 * would violate the safe band; otherwise keep the previous default of 1:
 *   1. the DEEPEST engrave must leave ≥ MIN_MARGIN_MM of material (priority), and
 *   2. the SHALLOWEST engrave must be ≥ MIN_MARGIN_MM deep.
 * depth_i = (energy_i / cutEnergy) × ratio × thickness. Returns 1 when there's
 * not enough info (no engraves / unknown energies / too-thin board).
 */
function autoDepthRatio(model: LacModel, thickness: number): number {
  const cutEnergy =
    model.meta.cutEnergy ??
    model.plates
      .flatMap((p) => p.pieces)
      .reduce((m, pc) => (pc.process === 'cut' ? Math.max(m, pc.laser.energy ?? 0) : m), 0);
  if (!(cutEnergy > 0) || !(thickness > 0)) return 1;

  const fracs = model.processes
    .filter((u) => u.process === 'engrave' && u.params.energy != null)
    .map((u) => (u.params.energy as number) / cutEnergy)
    .filter((f) => f > 0);
  if (!fracs.length) return 1;

  const fracMax = Math.max(...fracs);
  const fracMin = Math.min(...fracs);
  // ceiling: deepest engrave keeps ≥ MIN_MARGIN_MM of remaining material
  const ceil = (thickness - MIN_MARGIN_MM) / (fracMax * thickness);
  // floor: shallowest engrave is ≥ MIN_MARGIN_MM deep
  const floor = MIN_MARGIN_MM / (fracMin * thickness);
  if (!(ceil > 0)) return 1; // board too thin to leave any margin

  // Keep the default of 1, only nudging it into the [floor, ceil] band. The
  // deepest constraint (ceil) has priority, so it caps last.
  let ratio = 1;
  if (ratio < floor) ratio = floor;
  if (ratio > ceil) ratio = ceil;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

const LaserCut: React.FC = () => {
  const navigate = useNavigate();
  useDocumentTitle('激光刀切转3D模型');

  const [fileName, setFileName] = useState('');
  const fileBytesRef = useRef<Uint8Array | null>(null);

  const [model, setModel] = useState<LacModel | null>(null);
  const [building, setBuilding] = useState(false);

  // build options
  const [thickness, setThickness] = useState(3);
  const [scale, setScale] = useState(1);
  const [flipY, setFlipY] = useState(true);
  const [cutHoles, setCutHoles] = useState(true);
  const [plateSel, setPlateSel] = useState<number>(ALL_PLATES);
  const [engraveAsGroove, setEngraveAsGroove] = useState(true);
  // show the per-energy color hint on engrave marks (preview only)
  const [showEngraveColors, setShowEngraveColors] = useState(true);
  // Groove depth/width are derived from each path's laser energy density
  // (power/speed); these ratios scale that physical estimate.
  const [depthRatio, setDepthRatio] = useState(1);
  const [widthRatio, setWidthRatio] = useState(1);

  const buildRef = useRef<BuildResult | null>(null);
  const [viewObject, setViewObject] = useState<THREE.Object3D | null>(null);
  // which preview to show on the right: 3D model or flat 2D path view
  const [viewMode, setViewMode] = useState<'3d' | '2d'>('3d');
  const [stats, setStats] = useState<{
    triangles: number;
    size: { x: number; y: number; z: number };
    /** largest single part footprint, in ORIGINAL (unscaled) mm */
    largestPart: { x: number; y: number; maxEdge: number };
  } | null>(null);

  const reparse = useCallback((bytes: Uint8Array) => {
    try {
      const m = parseLac(bytes);
      setModel(m);
      setPlateSel(ALL_PLATES);
      const th = m.meta.thicknessMm ?? thickness;
      if (m.meta.thicknessMm) setThickness(m.meta.thicknessMm);
      // Auto-pick a depth ratio that keeps engrave grooves in a safe band.
      setDepthRatio(autoDepthRatio(m, th));
      m.warnings.forEach((w) => Message.warning(w));
      const totalPieces = m.plates.reduce((s, p) => s + p.pieces.length, 0);
      Message.success(`解析成功：${m.plates.length} 个盘，共 ${totalPieces} 个零件`);
    } catch (e: any) {
      setModel(null);
      Message.error(`解析失败：${e?.message || e}`);
    }
  }, [thickness]);

  const handleFile = useCallback(
    async (file: File) => {
      try {
        const ab = await readFileAsArrayBuffer(file);
        const bytes = new Uint8Array(ab);
        fileBytesRef.current = bytes;
        setFileName(file.name);
        reparse(bytes);
      } catch (e: any) {
        Message.error(`读取文件失败：${e?.message || e}`);
      }
    },
    [reparse]
  );

  // (re)build the 3D model when the model or build options change
  useEffect(() => {
    if (!model) {
      if (buildRef.current) {
        disposeBuild(buildRef.current);
        buildRef.current = null;
      }
      setViewObject(null);
      setStats(null);
      return;
    }
    setBuilding(true);
    const opts: BuildOptions = {
      thickness,
      scale,
      flipY,
      cutHoles,
      engraveAsGroove,
      showEngraveColors,
      depthRatio,
      widthRatio,
      onlyPlate: plateSel === ALL_PLATES ? undefined : plateSel,
    };
    const timer = setTimeout(() => {
      try {
        if (buildRef.current) disposeBuild(buildRef.current);
        const result = buildModel(model, opts);
        buildRef.current = result;
        setViewObject(result.group);
        setStats({ triangles: result.triangleCount, size: result.size, largestPart: result.largestPart });
      } catch (e: any) {
        Message.error(`生成模型失败：${e?.message || e}`);
      } finally {
        setBuilding(false);
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [model, thickness, scale, flipY, cutHoles, plateSel, engraveAsGroove, showEngraveColors, depthRatio, widthRatio]);

  // dispose on unmount
  useEffect(
    () => () => {
      if (buildRef.current) disposeBuild(buildRef.current);
    },
    []
  );

  const baseName = useMemo(
    () => (model?.meta.title || fileName || 'laser-model').replace(/\.[^.]+$/, ''),
    [model, fileName]
  );

  const [exporting, setExporting] = useState(false);

  // Carry the .lac project info (title / designer / material) into the 3MF.
  const projectMeta = useMemo(
    () => ({
      title: model?.meta.title || baseName,
      designer: model?.meta.designer,
      description: model?.meta.material ? `激光刀切转 3D · ${model.meta.material}` : undefined,
    }),
    [model, baseName]
  );

  // Each .lac plate → its own print plate (bed). Within a plate every piece is
  // welded as an independent solid, so touching parts stay manifold.
  const onExportAll = useCallback(async () => {
    if (!model) return;
    let temp: BuildResult | null = null;
    setExporting(true);
    try {
      // Always export every plate: reuse the current build only if it already
      // holds all plates, otherwise rebuild the full layout on demand.
      let build = buildRef.current;
      if (!build || plateSel !== ALL_PLATES) {
        temp = buildModel(model, {
          thickness,
          scale,
          flipY,
          cutHoles,
          engraveAsGroove,
          depthRatio,
          widthRatio,
        });
        build = temp;
      }
      // One 3MF object PER PART, tagged with its print-plate index (= source
      // .lac plate). Parts sharing a plate are auto-arranged together on one
      // bed; emitting each part separately lets the slicer move/repack them
      // individually and keeps each object's footprint small.
      const objects = build.plates
        .filter((p) => p.parts.length)
        .flatMap((p, i) =>
          p.parts.map((part, j) => ({
            name: `${baseName}-盘${p.index}-件${j + 1}`,
            geometry: part.geometries,
            plate: i + 1,
          }))
        );
      if (!objects.length) {
        Message.warning('没有可导出的几何');
        return;
      }
      const u8 = await pack3mf('laser', objects, projectMeta, {
        bedSize: { x: 256, y: 256 },
      });
      saveBlob(u8, `${baseName}.3mf`);
      const plateCount = build.plates.filter((p) => p.parts.length).length;
      Message.success(`已导出 ${objects.length} 个零件，分布在 ${plateCount} 个打印盘`);
    } catch (e: any) {
      Message.error(`导出失败：${e?.message || e}`);
    } finally {
      if (temp) disposeBuild(temp);
      setExporting(false);
    }
  }, [model, baseName, plateSel, projectMeta, thickness, scale, flipY, cutHoles, engraveAsGroove, depthRatio, widthRatio]);

  const engraveCount = useMemo(
    () =>
      model
        ? model.plates.reduce(
            (s, p) => s + p.pieces.filter((pc) => pc.process === 'engrave').length,
            0
          )
        : 0,
    [model]
  );

  // Laser energy summary + the resulting groove depth/width for the current
  // ratios, so the user sees what the physics-derived values actually are.
  const engraveInfo = useMemo(() => {
    if (!model) return null;
    const eng = model.plates
      .flatMap((p) => p.pieces)
      .find((pc) => pc.process === 'engrave');
    if (!eng) return null;
    const cutEnergy =
      model.meta.cutEnergy ??
      model.plates
        .flatMap((p) => p.pieces)
        .reduce((m, pc) => (pc.process === 'cut' ? Math.max(m, pc.laser.energy ?? 0) : m), 0);
    const e = eng.laser.energy;
    const frac = e != null && cutEnergy > 0 ? e / cutEnergy : 0.3;
    const depthMm = Math.min(thickness * 0.95, frac * depthRatio * thickness) * scale;
    const widthMm = Math.max(0.05, (e != null ? e : 0.6) * widthRatio) * scale;
    return {
      cutPower: model.plates.flatMap((p) => p.pieces).find((pc) => pc.process === 'cut')?.laser,
      engLaser: eng.laser,
      cutEnergy,
      depthMm,
      widthMm,
    };
  }, [model, thickness, scale, depthRatio, widthRatio]);

  // Every distinct laser process in the file, with the depth/width it produces
  // under the current ratios — drives the collapsible parameter table.
  const processRows = useMemo(() => {
    if (!model) return [];
    const cutEnergy =
      model.meta.cutEnergy ??
      model.plates
        .flatMap((p) => p.pieces)
        .reduce((m, pc) => (pc.process === 'cut' ? Math.max(m, pc.laser.energy ?? 0) : m), 0);
    // Only engrave processes — cuts are always through-cut and not controlled
    // by the depth/width ratios.
    return model.processes
      .filter((u) => u.process === 'engrave')
      .map((u, i) => {
        const e = u.params.energy;
        const frac = e != null && cutEnergy > 0 ? e / cutEnergy : 0.3;
        const depthMm = Math.min(thickness * 0.95, frac * depthRatio * thickness) * scale;
        const widthMm = Math.max(0.05, (e != null ? e : 0.6) * widthRatio) * scale;
        return {
          key: u.params.processType,
          // color tagging this energy — matches the painted top face on the model
          color: engraveColorAt(i),
          power: u.params.power ?? null,
          speed: u.params.speed ?? null,
          energy: e ?? null,
          count: u.count,
          depthMm,
          widthMm,
        };
      });
  }, [model, thickness, scale, depthRatio, widthRatio]);

  const setMaxEdge = (v: number) => {
    if (!v) return;
    // Scale so the LARGEST single PART's longest edge hits the target length.
    // largestPart is in original (unscaled) mm, so the ratio is independent of
    // the current scale.
    const maxEdge = stats?.largestPart.maxEdge || 0;
    if (maxEdge <= 0) return;
    setScale(Number((v / maxEdge).toFixed(4)));
  };

  return (
    <div className="laser">
      <div className="page-nav">
        <Button type="text" size="small" onClick={() => navigate('/')}>
          ← 返回首页
        </Button>
        <span className="page-nav-title">激光刀切转 3D 模型</span>
      </div>

      <div className="laser-body">
        <div className="laser-panel">
          <List size="large" header="上传 .lac 并生成 3D 模型">
            <List.Item key="upload">
              <div className="title">选择激光刀切文件</div>
              <div className="describe">
                支持拓竹 Bambu Suite / MakerWorld 的激光刀切工程文件（.lac）。文件本质是一个压缩包，
                内部记录了每张材料板（盘）上所有零件的切割轮廓与排版位置。上传后全部解析与建模都在
                本地浏览器完成，文件不会上传到任何服务器。
              </div>
              <Upload
                drag
                accept=".lac,application/zip"
                limit={1}
                autoUpload={false}
                showUploadList
                onChange={(list: any[]) => {
                  const f = list && list[list.length - 1];
                  if (f?.originFile) handleFile(f.originFile);
                }}
                tip="仅支持 .lac 文件"
              />
            </List.Item>

            {model ? (
              <>
                <List.Item key="meta">
                  <div className="title">文件信息</div>
                  <div className="laser-meta">
                    {model.meta.title ? <Tag color="arcoblue">{model.meta.title}</Tag> : null}
                    {model.meta.designer ? <Tag>作者：{model.meta.designer}</Tag> : null}
                    {model.meta.material ? <Tag color="green">{model.meta.material}</Tag> : null}
                    <Tag>{model.plates.length} 个盘</Tag>
                    <Tag>{model.plates.reduce((s, p) => s + p.pieces.length, 0)} 个路径</Tag>
                    {engraveCount ? (
                      <Tag color="purple">{engraveCount} 条雕刻线</Tag>
                    ) : null}
                  </div>
                  <div className="laser-plate-list">
                    {model.plates.map((p) => (
                      <div key={p.index} className="laser-plate-row">
                        盘 {p.index}：{p.bbox.width.toFixed(0)} × {p.bbox.height.toFixed(0)} mm，
                        {p.pieces.length} 件
                      </div>
                    ))}
                  </div>
                  {model.meta.source !== 'project_settings' ? (
                    <div className="describe" style={{ marginTop: 8 }}>
                      ⚠ 未找到排版信息，按单盘平铺显示（坐标可能非物理尺寸）
                    </div>
                  ) : null}
                </List.Item>

                <List.Item key="plate">
                  <div className="title">显示盘</div>
                  <div className="describe">
                    “盘”对应一张实际材料板。选择“全部盘”会把每张盘按真实尺寸在地面上铺成网格、一次看全；
                    选择某一盘则只显示该盘，便于单独检查。此选项只影响预览，不影响“每盘单独导出”。
                  </div>
                  <Select
                    style={{ width: 240 }}
                    value={plateSel}
                    onChange={(v: number) => setPlateSel(v)}
                  >
                    <Option value={ALL_PLATES}>全部盘（网格平铺）</Option>
                    {model.plates.map((p) => (
                      <Option key={p.index} value={p.index}>
                        盘 {p.index}（{p.bbox.width.toFixed(0)}×{p.bbox.height.toFixed(0)} mm）
                      </Option>
                    ))}
                  </Select>
                </List.Item>

                <List.Item key="thickness">
                  <div className="title">材料厚度 (mm)</div>
                  <div className="describe">
                    平面轮廓会沿厚度方向挤出成 3D 实体，这里就是挤出的高度。默认读取文件里的材料配置
                    （如 3mm 胶合板）。若你打算用别的厚度的板材，改这里即可。注意：开启下方“缩放比例”后，
                    最终厚度 = 此值 × 缩放比例。
                  </div>
                  <InputNumber
                    style={{ width: 200 }}
                    size="large"
                    mode="button"
                    suffix="mm"
                    min={0.1}
                    max={100}
                    step={0.5}
                    precision={2}
                    value={thickness}
                    onChange={(v: number) => setThickness(v)}
                  />
                </List.Item>

                <List.Item key="scale">
                  <div className="title">缩放比例</div>
                  <div className="describe">
                    对模型做<strong>等比缩放</strong>——长、宽、厚度三个方向同时按此倍数缩放，保持原始比例不变形。
                    1.0 = 文件中的原始物理尺寸（单位 mm）。例如设为 0.5，则成品缩到一半（厚度也减半）。
                  </div>
                  <div className="describe">
                    当前缩放后厚度 {(thickness * scale).toFixed(2)} mm。
                  </div>
                  {stats && stats.largestPart.maxEdge > 0 ? (
                    <div className="describe">
                      <strong>最大零件</strong>（决定能否放入打印幅面）：约{' '}
                      {(stats.largestPart.x * scale).toFixed(1)} ×{' '}
                      {(stats.largestPart.y * scale).toFixed(1)} mm，最大边{' '}
                      {(stats.largestPart.maxEdge * scale).toFixed(1)} mm。
                    </div>
                  ) : null}
                  <InputNumber
                    style={{ width: 200 }}
                    size="large"
                    mode="button"
                    suffix="倍"
                    min={0.001}
                    max={1000}
                    step={0.1}
                    precision={3}
                    value={scale}
                    onChange={(v: number) => setScale(v)}
                  />
                  <div className="laser-quick">
                    <span>或：把最大零件的最大边缩放到指定长度 (mm)：</span>
                    <InputNumber
                      style={{ width: 160 }}
                      min={1}
                      max={2000}
                      step={10}
                      precision={1}
                      placeholder="例如 200"
                      disabled={!stats || stats.largestPart.maxEdge <= 0}
                      onChange={(v: number) => setMaxEdge(v)}
                    />
                  </div>
                  <div className="laser-quick-presets">
                    {[
                      { label: 'H2', mm: 320 },
                      { label: 'X1', mm: 256 },
                      { label: 'A1 mini', mm: 180 },
                    ].map((p) => (
                      <Button
                        key={p.label}
                        size="small"
                        disabled={!stats || stats.largestPart.maxEdge <= 0}
                        onClick={() => setMaxEdge(p.mm)}
                      >
                        {p.label}：{p.mm}mm
                      </Button>
                    ))}
                  </div>
                  <div className="describe" style={{ marginTop: 6 }}>
                    输入目标长度会自动换算缩放倍数，使<strong>最大的单个零件</strong>正好缩放到该尺寸，
                    确保所有零件都能放进你的打印/切割幅面。
                  </div>
                </List.Item>

                <List.Item key="opts">
                  <div className="title">几何选项</div>
                  <div className="laser-switch">
                    <Switch checked={cutHoles} onChange={(v: boolean | string | number) => setCutHoles(Boolean(v))} />{' '}
                    <span>挖空内部孔洞</span>
                  </div>
                  <div className="describe">
                    开启时，零件内部的封闭轮廓会被识别为镂空（如齿轮中心孔、卡槽），生成真正带孔的实体——
                    这通常是你想要的。关闭时<strong>不会填平内孔</strong>，而是把每个内孔轮廓也当作一个
                    独立的实心零件单独拆出（外圈仍保留孔洞），便于把内外件分别摆盘、分件打印。
                    <strong>但这会需要你自行删除空洞中多余的实体</strong>
                  </div>
                  <div className="laser-switch" style={{ marginTop: 12 }}>
                    <Switch checked={flipY} onChange={(v: boolean | string | number) => setFlipY(Boolean(v))} />{' '}
                    <span>翻转 Y 轴（推荐）</span>
                  </div>
                  <div className="describe">
                    刀切文件的 Y 轴方向与 3D 习惯相反，开启后模型朝向与设计图一致（推荐保持开启）。
                    如果发现预览呈镜像/上下颠倒，切换此项即可。
                  </div>
                </List.Item>

                {engraveCount ? (
                  <List.Item key="engrave">
                    <div className="title">雕刻线处理</div>
                    <div className="describe">
                      文件中有 {engraveCount} 条标记为“雕刻”（LaserLineEngrave）的线路——它们不是切穿，
                      而是在材料表面刻痕。雕刻的深浅与粗细由激光的<strong>能量密度 = 功率 ÷ 速度 × 次数</strong>决定：
                      能量越高刻得越深越宽。下面的凹槽深度/宽度<strong>自动按文件中的功率、速度推算</strong>，
                      你只需用比例系数整体放大或缩小。
                    </div>
                    {engraveInfo ? (
                      <div className="describe laser-energy-box">
                        切割：功率 {engraveInfo.cutPower?.power ?? '—'} / 速度 {engraveInfo.cutPower?.speed ?? '—'}
                        （能量 {engraveInfo.cutEnergy ? engraveInfo.cutEnergy.toFixed(2) : '—'}，对应切穿全厚）
                        <br />
                        雕刻：功率 {engraveInfo.engLaser.power ?? '—'} / 速度 {engraveInfo.engLaser.speed ?? '—'}
                        （能量 {engraveInfo.engLaser.energy != null ? engraveInfo.engLaser.energy.toFixed(2) : '—'}）
                      </div>
                    ) : null}
                    <div className="laser-switch">
                      <Switch
                        checked={engraveAsGroove}
                        onChange={(v: boolean | string | number) => setEngraveAsGroove(Boolean(v))}
                      />{' '}
                      <span>雕刻线生成为表面凹槽（减薄）</span>
                    </div>
                    <div className="describe">
                      开启：在零件正面沿雕刻路径下沉出真实凹槽（影响导出的实体）。
                      关闭：不改变厚度，仅用紫色细线在表面标出雕刻位置，便于辨认。
                    </div>
                    {engraveAsGroove ? (
                      <div className="laser-engrave-params">
                        <div className="laser-param">
                          <span>功率深度比例</span>
                          <InputNumber
                            style={{ width: 150 }}
                            mode="button"
                            suffix="×"
                            min={0.1}
                            max={20}
                            step={0.1}
                            precision={2}
                            value={depthRatio}
                            onChange={(v: number) => setDepthRatio(v)}
                          />
                          <span className="laser-param-hint">
                            放大/缩小由能量推算的深度。当前实际深度 ≈{' '}
                            {engraveInfo ? engraveInfo.depthMm.toFixed(2) : '—'} mm
                            （材料 {(thickness * scale).toFixed(2)} mm）。
                          </span>
                        </div>
                        <div className="laser-param">
                          <span>宽度比例</span>
                          <InputNumber
                            style={{ width: 150 }}
                            mode="button"
                            suffix="×"
                            min={0.1}
                            max={20}
                            step={0.1}
                            precision={2}
                            value={widthRatio}
                            onChange={(v: number) => setWidthRatio(v)}
                          />
                          <span className="laser-param-hint">
                            放大/缩小由能量推算的刻线宽度。当前实际宽度 ≈{' '}
                            {engraveInfo ? engraveInfo.widthMm.toFixed(2) : '—'} mm。
                          </span>
                        </div>
                      </div>
                    ) : null}

                    <div className="laser-switch" style={{ marginTop: 12 }}>
                      <Switch
                        checked={showEngraveColors}
                        onChange={(v: boolean | string | number) => setShowEngraveColors(Boolean(v))}
                      />{' '}
                      <span>雕刻线颜色提示</span>
                    </div>
                    <div className="describe">
                      按能量为每种雕刻工艺着色，模型表面与下方参数表用同色标记，便于对照辨认。
                      仅影响预览着色，不改变导出的实体几何。
                    </div>

                    {processRows.length ? (
                      <Collapse bordered={false} style={{ marginTop: 12 }} className="laser-proc-collapse">
                        <Collapse.Item
                          name="proc"
                          header={`文件中的雕刻功率配置（${processRows.length} 种）及对应深/宽`}
                        >
                          <Table
                            className="laser-proc-table"
                            size="mini"
                            border={{ wrapper: true, cell: false }}
                            pagination={false}
                            data={processRows}
                            onRow={(record: any) => ({
                              style: showEngraveColors
                                ? {
                                    outline: `2px solid ${record.color}`,
                                    outlineOffset: '-2px',
                                  }
                                : undefined,
                            })}
                            columns={[
                              {
                                title: '功率',
                                dataIndex: 'power',
                                render: (v: number | null) => (v == null ? '—' : v),
                              },
                              {
                                title: '速度',
                                dataIndex: 'speed',
                                render: (v: number | null) => (v == null ? '—' : v),
                              },
                              { title: '路径数', dataIndex: 'count' },
                              {
                                title: '深度(mm)',
                                dataIndex: 'depthMm',
                                render: (v: number) => v.toFixed(2),
                              },
                              {
                                title: '宽度(mm)',
                                dataIndex: 'widthMm',
                                render: (v: number) => v.toFixed(2),
                              },
                            ]}
                          />
                          <div className="describe" style={{ marginTop: 8 }}>
                            深/宽随上方“功率深度比例 / 宽度比例”及厚度、缩放实时变化。
                          </div>
                        </Collapse.Item>
                      </Collapse>
                    ) : null}
                  </List.Item>
                ) : null}

                <List.Item key="export">
                  <div className="title">导出 3MF</div>
                  <div className="describe">
                    导出 3MF（，可直接导入拓竹切片软件 打印。
                    导出的模型与左侧设置（厚度、缩放、孔洞、翻转）完全一致。当前视图三角面：
                    {stats ? stats.triangles.toLocaleString() : '生成中…'}。
                  </div>

                  <Button
                    type="primary"
                    size="large"
                    long
                    loading={exporting}
                    disabled={building || exporting}
                    onClick={onExportAll}
                  >
                    下载3MF
                  </Button>
                  <div className="describe" style={{ marginTop: 8 }}>
                    每个零件导出为一个<strong>独立的对象/实体</strong>
                    可能需要自行点击自动摆盘
                    若某零件超过机器幅面，请用上方缩放把最大零件缩到幅面内。
                  </div>
                </List.Item>
              </>
            ) : null}
          </List>
        </div>

        <div className="laser-viewer">
          {model ? (
            <div className="laser-view-toggle">
              <Button.Group>
                <Button
                  size="small"
                  type={viewMode === '3d' ? 'primary' : 'secondary'}
                  onClick={() => setViewMode('3d')}
                >
                  3D 模型
                </Button>
                <Button
                  size="small"
                  type={viewMode === '2d' ? 'primary' : 'secondary'}
                  onClick={() => setViewMode('2d')}
                >
                  平面路径
                </Button>
              </Button.Group>
            </div>
          ) : null}
          {viewMode === '2d' ? (
            model ? (
              <PathPreview
                model={model}
                plateSel={plateSel}
                flipY={flipY}
                showEngraveColors={showEngraveColors}
                className="laser-canvas"
              />
            ) : (
              <div className="laser-empty">上传 .lac 文件后在此预览平面路径</div>
            )
          ) : (
            <Spin loading={building} tip="生成模型中…" className="laser-spin">
              {viewObject ? (
                <ModelViewer object={viewObject} className="laser-canvas" />
              ) : (
                <div className="laser-empty">上传 .lac 文件后在此预览 3D 模型</div>
              )}
            </Spin>
          )}
        </div>
      </div>
    </div>
  );
};

export default LaserCut;
