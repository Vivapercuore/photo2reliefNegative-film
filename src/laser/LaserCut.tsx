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
import { buildModel, disposeBuild, BuildResult, BuildOptions } from './lac/buildMesh';
import ModelViewer from './viewer/ModelViewer';
import { exportBinarySTL, zipStlFiles, StlEntry } from './export/exportStl';

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

const LaserCut: React.FC = () => {
  const navigate = useNavigate();

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
  // Groove depth/width are derived from each path's laser energy density
  // (power/speed); these ratios scale that physical estimate.
  const [depthRatio, setDepthRatio] = useState(1);
  const [widthRatio, setWidthRatio] = useState(1);

  const buildRef = useRef<BuildResult | null>(null);
  const [viewObject, setViewObject] = useState<THREE.Object3D | null>(null);
  const [stats, setStats] = useState<{ triangles: number; size: { x: number; y: number; z: number } } | null>(
    null
  );

  const reparse = useCallback((bytes: Uint8Array) => {
    try {
      const m = parseLac(bytes);
      setModel(m);
      setPlateSel(ALL_PLATES);
      if (m.meta.thicknessMm) setThickness(m.meta.thicknessMm);
      m.warnings.forEach((w) => Message.warning(w));
      const totalPieces = m.plates.reduce((s, p) => s + p.pieces.length, 0);
      Message.success(`解析成功：${m.plates.length} 个盘，共 ${totalPieces} 个零件`);
    } catch (e: any) {
      setModel(null);
      Message.error(`解析失败：${e?.message || e}`);
    }
  }, []);

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
        setStats({ triangles: result.triangleCount, size: result.size });
      } catch (e: any) {
        Message.error(`生成模型失败：${e?.message || e}`);
      } finally {
        setBuilding(false);
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [model, thickness, scale, flipY, cutHoles, plateSel, engraveAsGroove, depthRatio, widthRatio]);

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

  // Export every built plate as its own STL, packed into a single zip.
  const onExportZip = useCallback(() => {
    const build = buildRef.current;
    if (!build || !build.plates.length) {
      Message.warning('请先上传并生成模型');
      return;
    }
    try {
      const entries: StlEntry[] = build.plates
        .filter((p) => p.geometries.length)
        .map((p) => ({
          name: `${baseName}_盘${p.index}`,
          data: exportBinarySTL(p.geometries),
        }));
      if (!entries.length) {
        Message.warning('没有可导出的几何');
        return;
      }
      if (entries.length === 1) {
        saveBlob(entries[0].data, `${entries[0].name}.stl`);
      } else {
        const zip = zipStlFiles(entries);
        saveBlob(zip, `${baseName}_STL.zip`);
      }
      Message.success(`已导出 ${entries.length} 个 STL`);
    } catch (e: any) {
      Message.error(`导出失败：${e?.message || e}`);
    }
  }, [baseName]);

  // Export only the current view as a single STL.
  const onExportSingle = useCallback(() => {
    const build = buildRef.current;
    if (!build || !build.geometries.length) {
      Message.warning('请先上传并生成模型');
      return;
    }
    try {
      const buf = exportBinarySTL(build.geometries);
      const suffix = plateSel === ALL_PLATES ? '全部' : `盘${plateSel}`;
      saveBlob(buf, `${baseName}_${suffix}.stl`);
      Message.success('STL 已导出');
    } catch (e: any) {
      Message.error(`导出失败：${e?.message || e}`);
    }
  }, [baseName, plateSel]);

  // Export one specific plate as a single STL (by plate index). Works in any
  // view: if that plate isn't in the current build, build it on demand.
  const onExportOnePlate = useCallback(
    (index: number) => {
      if (!model) return;
      try {
        let geoms = buildRef.current?.plates.find((p) => p.index === index)?.geometries;
        let temp: BuildResult | null = null;
        if (!geoms || !geoms.length) {
          temp = buildModel(model, {
            thickness,
            scale,
            flipY,
            cutHoles,
            engraveAsGroove,
            depthRatio,
            widthRatio,
            onlyPlate: index,
          });
          geoms = temp.geometries;
        }
        if (!geoms.length) {
          Message.warning(`盘 ${index} 没有可导出的几何`);
          if (temp) disposeBuild(temp);
          return;
        }
        const buf = exportBinarySTL(geoms);
        saveBlob(buf, `${baseName}_盘${index}.stl`);
        if (temp) disposeBuild(temp);
        Message.success(`盘 ${index} 已导出`);
      } catch (e: any) {
        Message.error(`导出失败：${e?.message || e}`);
      }
    },
    [model, baseName, thickness, scale, flipY, cutHoles, engraveAsGroove, depthRatio, widthRatio]
  );

  const footprintText = useMemo(() => {
    if (!stats) return '';
    const { x, z } = stats.size;
    return `${x.toFixed(0)} × ${z.toFixed(0)} mm`;
  }, [stats]);

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
      .map((u) => {
        const e = u.params.energy;
        const frac = e != null && cutEnergy > 0 ? e / cutEnergy : 0.3;
        const depthMm = Math.min(thickness * 0.95, frac * depthRatio * thickness) * scale;
        const widthMm = Math.max(0.05, (e != null ? e : 0.6) * widthRatio) * scale;
        return {
          key: u.params.processType,
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
    if (!model || !v) return;
    // base scaling on the largest single plate edge so a plate fits the target
    const maxEdge =
      Math.max(...model.plates.flatMap((p) => [p.bbox.width, p.bbox.height]), 1) || 1;
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
                    当前缩放后：单盘约 {(Math.max(...model.plates.map((p) => p.bbox.width)) * scale).toFixed(0)} ×{' '}
                    {(Math.max(...model.plates.map((p) => p.bbox.height)) * scale).toFixed(0)} mm，
                    厚度 {(thickness * scale).toFixed(2)} mm；整体视图占地 {footprintText || '—'}。
                  </div>
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
                    <span>或：把单盘最大边缩放到指定长度 (mm)：</span>
                    <InputNumber
                      style={{ width: 160 }}
                      min={1}
                      max={2000}
                      step={10}
                      precision={1}
                      placeholder="例如 300"
                      onChange={(v: number) => setMaxEdge(v)}
                    />
                  </div>
                  <div className="describe" style={{ marginTop: 6 }}>
                    输入目标长度会自动换算缩放倍数，方便把整盘缩放到你的打印/切割幅面。
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
                    这通常是你想要的。关闭则把每条轮廓都当作独立实心片，内孔会被填平，仅在孔洞识别异常时用于排查。
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
                  <div className="title">导出 STL</div>
                  <div className="describe">
                    导出标准二进制 STL，可直接导入切片软件 / 3D 打印或 CNC。导出的模型与左侧设置（厚度、缩放、
                    孔洞、翻转）完全一致。当前视图三角面：{stats ? stats.triangles.toLocaleString() : '生成中…'}。
                  </div>

                  <div className="laser-export-sub">按盘单独下载</div>
                  <div className="describe">每张盘各自生成一个 STL 文件，便于逐盘打印 / 切割。</div>
                  <div className="laser-plate-btns">
                    {model.plates.map((p) => (
                      <Button
                        key={p.index}
                        size="default"
                        disabled={building}
                        onClick={() => onExportOnePlate(p.index)}
                      >
                        盘 {p.index} STL
                      </Button>
                    ))}
                  </div>

                  <div className="laser-export-sub">批量 / 合并</div>
                  <Button
                    type="primary"
                    size="large"
                    long
                    disabled={building}
                    onClick={onExportZip}
                    style={{ marginBottom: 10 }}
                  >
                    全部盘打包下载（{model.plates.length} 个 STL · zip）
                  </Button>
                  <div className="describe">把所有盘的 STL 一次性打包成一个 zip 下载。</div>
                  <Button
                    size="large"
                    long
                    disabled={building}
                    onClick={onExportSingle}
                    style={{ marginTop: 10 }}
                  >
                    {plateSel === ALL_PLATES ? '当前视图合并为单个 STL' : `仅导出盘 ${plateSel}（单文件）`}
                  </Button>
                  <div className="describe">
                    把当前预览的内容合并成一个 STL：选“全部盘”时所有盘合为一体，选单盘时即该盘。
                  </div>
                </List.Item>
              </>
            ) : null}
          </List>
        </div>

        <div className="laser-viewer">
          <Spin loading={building} tip="生成模型中…" className="laser-spin">
            {viewObject ? (
              <ModelViewer object={viewObject} className="laser-canvas" />
            ) : (
              <div className="laser-empty">上传 .lac 文件后在此预览 3D 模型</div>
            )}
          </Spin>
        </div>
      </div>
    </div>
  );
};

export default LaserCut;
