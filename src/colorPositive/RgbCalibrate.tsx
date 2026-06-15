import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  List,
  Input,
  Button,
  Message,
  Tag,
  Slider,
  // @ts-ignore arco 类型偶尔解析不到
} from '@arco-design/web-react';
import { useDocumentTitle } from '../useDocumentTitle';
import { pack3mf } from '../export/bambu/build3mf';
import { splitBoxSolids } from './buildColorField';
import { buildRgbCalibrationTile, CAL_ROWS, CAL_LAYER_MM } from './buildRgbCalibrationTile';
import {
  SwatchSample,
  fitCalibration,
  saveCalibration,
  clearCalibration,
  loadCalibration,
  RgbCalibration,
  loadSavedCalibrations,
  addSavedCalibration,
  deleteSavedCalibration,
  nextAutoName,
  autoChromaGain,
  MAX_CHROMA_GAIN,
  PRIMARY_LABEL,
  PRIMARY_NOMINAL,
} from './calibration';
import RgbCalibrationTable from './RgbCalibrationTable';
import RgbCalibrationPicker from './RgbCalibrationPicker';
import PhotoDropZone from '../colorCmyk/PhotoDropZone';
import '../colorCmyk/CmykCalibrate.css';

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

const CORNER_LABELS = ['左上', '右上', '右下', '左下'];
const rowHex = (id: keyof typeof PRIMARY_NOMINAL) =>
  '#' + PRIMARY_NOMINAL[id].map((v) => v.toString(16).padStart(2, '0')).join('');

const RgbCalibrate: React.FC = () => {
  const navigate = useNavigate();
  useDocumentTitle('RGB 耗材校准');

  const [exporting, setExporting] = useState(false);
  const [photoUrl, setPhotoUrl] = useState('');
  const imgRef = useRef<HTMLImageElement | null>(null);
  const fullCanvasRef = useRef<HTMLCanvasElement | null>(null); // offscreen full-res
  const dispCanvasRef = useRef<HTMLCanvasElement | null>(null); // on-screen
  const [corners, setCorners] = useState<{ x: number; y: number }[]>([]); // natural coords
  const [dispScale, setDispScale] = useState(1);
  const [fitted, setFitted] = useState<RgbCalibration | null>(null);
  const [current, setCurrent] = useState<RgbCalibration>(() => loadCalibration());
  const [savedCals, setSavedCals] = useState(() => loadSavedCalibrations());
  const [fitName, setFitName] = useState('');
  const [editName, setEditName] = useState('');

  // ---- export calibration tile -------------------------------------------
  const onExportTile = useCallback(async () => {
    setExporting(true);
    try {
      const parts = buildRgbCalibrationTile();
      // each colour on its OWN plate, all bound to filament slot 1, so the user
      // loads one filament and prints that plate with no colour changes
      const objects = parts.map((p, i) => ({
        name: p.palette.label,
        geometry: splitBoxSolids(p.geometry),
        extruder: 1,
        plate: i + 1,
      }));
      const lw = '0.25';
      const overrides: Record<string, unknown> = {
        layer_height: String(CAL_LAYER_MM),
        initial_layer_print_height: String(CAL_LAYER_MM),
        sparse_infill_density: '100%',
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
      const u8 = await pack3mf(
        'color-positive',
        objects,
        { title: 'RGB 校准片（5 盘单色）' },
        {
          projectSettingsOverrides: overrides,
          markModified: Object.keys(overrides),
        }
      );
      saveBlob(u8, 'rgb-calibration.3mf');
      Message.success('校准片 3MF 已导出（5 个单色盘）');
    } catch (e: any) {
      Message.error(`导出失败：${e?.message || e}`);
    } finally {
      setExporting(false);
    }
  }, []);

  // ---- photo upload -------------------------------------------------------
  const onPhoto = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const url = e.target?.result as string;
      setPhotoUrl(url);
      setCorners([]);
      setFitted(null);
      const img = new Image();
      img.onload = () => {
        imgRef.current = img;
        const fc = document.createElement('canvas');
        fc.width = img.width;
        fc.height = img.height;
        fc.getContext('2d')?.drawImage(img, 0, 0);
        fullCanvasRef.current = fc;
        const maxW = 640;
        setDispScale(Math.min(1, maxW / img.width));
      };
      img.src = url;
    };
    reader.readAsDataURL(file);
  }, []);

  // draw photo + corner markers + projected grid
  const redraw = useCallback(() => {
    const img = imgRef.current;
    const cv = dispCanvasRef.current;
    if (!img || !cv) return;
    cv.width = Math.round(img.width * dispScale);
    cv.height = Math.round(img.height * dispScale);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    corners.forEach((p, i) => {
      const x = p.x * dispScale;
      const y = p.y * dispScale;
      ctx.strokeStyle = '#ffd400';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#ffd400';
      ctx.font = '13px sans-serif';
      ctx.fillText(CORNER_LABELS[i], x + 9, y + 4);
    });
    // projected sample points once all 4 corners are set (5 rows × 1 col)
    if (corners.length === 4) {
      const R = CAL_ROWS.length;
      const [TL, TR, BR, BL] = corners;
      const bil = (u: number, v: number) => {
        const tx = TL.x + (TR.x - TL.x) * u;
        const ty = TL.y + (TR.y - TL.y) * u;
        const bx = BL.x + (BR.x - BL.x) * u;
        const by = BL.y + (BR.y - BL.y) * u;
        return { x: (tx + (bx - tx) * v) * dispScale, y: (ty + (by - ty) * v) * dispScale };
      };
      ctx.strokeStyle = 'rgba(0,255,180,0.8)';
      ctx.lineWidth = 1;
      for (let i = 0; i < R; i++) {
        const c = bil(0.5, (i + 0.5) / R);
        ctx.strokeRect(c.x - 6, c.y - 6, 12, 12);
      }
    }
  }, [corners, dispScale]);

  useEffect(() => {
    redraw();
  }, [redraw, photoUrl]);

  const onCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const cv = dispCanvasRef.current;
      if (!cv || !imgRef.current) return;
      const rect = cv.getBoundingClientRect();
      const x = (e.clientX - rect.left) / dispScale;
      const y = (e.clientY - rect.top) / dispScale;
      setCorners((prev) => (prev.length >= 4 ? [{ x, y }] : [...prev, { x, y }]));
      setFitted(null);
    },
    [dispScale]
  );

  // ---- fit ----------------------------------------------------------------
  const sampleBox = useCallback((cx: number, cy: number, half: number): [number, number, number] => {
    const fc = fullCanvasRef.current;
    const ctx = fc?.getContext('2d');
    if (!fc || !ctx) return [0, 0, 0];
    const x0 = Math.max(0, Math.round(cx - half));
    const y0 = Math.max(0, Math.round(cy - half));
    const w = Math.min(fc.width - x0, Math.round(half * 2) || 1);
    const h = Math.min(fc.height - y0, Math.round(half * 2) || 1);
    const d = ctx.getImageData(x0, y0, w, h).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
      n++;
    }
    return [r / n, g / n, b / n];
  }, []);

  const onFit = useCallback(() => {
    if (corners.length !== 4) {
      Message.warning('请先在照片上依次点击拼接块的四个角（左上、右上、右下、左下）');
      return;
    }
    const R = CAL_ROWS.length; // 5 primary rows: R, G, B, K, W
    const [TL, TR, BR, BL] = corners;
    const bil = (u: number, v: number) => {
      const tx = TL.x + (TR.x - TL.x) * u;
      const ty = TL.y + (TR.y - TL.y) * u;
      const bx = BL.x + (BR.x - BL.x) * u;
      const by = BL.y + (BR.y - BL.y) * u;
      return { x: tx + (bx - tx) * v, y: ty + (by - ty) * v };
    };
    const cellW = Math.hypot(TR.x - TL.x, TR.y - TL.y);
    const cellH = Math.hypot(BL.x - TL.x, BL.y - TL.y) / R;
    const half = Math.max(2, 0.25 * Math.min(cellW, cellH));

    const samples: SwatchSample[] = [];
    for (let f = 0; f < R; f++) {
      const c = bil(0.5, (f + 0.5) / R);
      samples.push({ id: CAL_ROWS[f], rgb: sampleBox(c.x, c.y, half) });
    }
    const cal = fitCalibration(samples, 'reflective');
    setFitted(cal);
    Message.success('已拟合，确认后点保存');
  }, [corners, sampleBox]);

  // ---- apply / edit / save (mirror the CMYK calibrate page) -----------------
  const applyCal = useCallback((c: RgbCalibration) => {
    const copy: RgbCalibration = JSON.parse(JSON.stringify(c));
    saveCalibration(copy);
    setCurrent(copy);
    setFitted(null);
    Message.success(copy.label ? `已应用：${copy.label}` : '已应用校准');
  }, []);

  const onEditCurrent = useCallback((next: RgbCalibration) => {
    saveCalibration(next);
    setCurrent(next);
  }, []);

  const setChromaGain = useCallback(
    (v: number | number[]) => {
      const g = Array.isArray(v) ? v[0] : v;
      onEditCurrent({ ...current, chromaGain: g, label: undefined });
    },
    [current, onEditCurrent]
  );

  const saveAsPreset = useCallback(
    (cal: RgbCalibration, rawName: string) => {
      const name = rawName.trim() || nextAutoName();
      const entry = addSavedCalibration(name, cal);
      setSavedCals(loadSavedCalibrations());
      applyCal(entry.cal);
      Message.success(`已保存为预设：${name}`);
      return name;
    },
    [applyCal]
  );

  const onSaveNamed = useCallback(() => {
    if (!fitted) return;
    saveAsPreset(fitted, fitName);
    setFitName('');
  }, [fitted, fitName, saveAsPreset]);

  const onSaveCurrentNamed = useCallback(() => {
    saveAsPreset(current, editName);
    setEditName('');
  }, [current, editName, saveAsPreset]);

  const onDeleteSaved = useCallback((id: string) => {
    deleteSavedCalibration(id);
    setSavedCals(loadSavedCalibrations());
    Message.info('已删除该本地校准');
  }, []);

  const onClear = useCallback(() => {
    clearCalibration();
    const d = loadCalibration();
    setCurrent(d);
    setFitted(null);
    Message.info('已恢复未校准默认值');
  }, []);

  return (
    <div className="cmykcal rgbcal">
      <div className="page-nav">
        <Button type="text" size="small" onClick={() => navigate('/color-positive')}>
          ← 返回正片模块
        </Button>
        <span className="page-nav-title">RGB 耗材校准（反射观看）</span>
      </div>

      <div className="cmykcal-body">
        <div className="cmykcal-grid">
          <List className="cmykcal-col" size="large" header="当前校准 · 参数与预览">
            <List.Item key="status">
              <div className="title">当前校准</div>
              <div className="cmykcal-status">
                {current.calibrated ? (
                  <Tag color="green">
                    {current.label
                      ? `预设：${current.label}`
                      : `已使用自定义校准${
                          current.updatedAt ? `（${current.updatedAt.slice(0, 10)}）` : ''
                        }`}
                  </Tag>
                ) : (
                  <Tag color="gray">未校准（按理想原色推算默认值）</Tag>
                )}
              </div>
              <div className="describe">
                每卷耗材打印出的实际颜色都偏离理想原色（红更暗、蓝更脏），偏色就来自这里。
                打印下面的校准片实测各原色真实显色，预览与成品才一致。也可在下方手动微调参数。
              </div>
              <RgbCalibrationPicker
                activeLabel={current.label}
                saved={savedCals}
                onApply={applyCal}
                onDelete={onDeleteSaved}
              />
              <RgbCalibrationTable cal={current} showTable={false} />
              <div className="cmykcal-editbox">
                <div className="cmykcal-edit-title">
                  饱和度还原 {(current.chromaGain ?? 1).toFixed(1)}×（抵消手机拍照掉色）
                </div>
                <div className="describe">
                  拍照取色会整体掉饱和度。此项按<b>统一倍率</b>把各原色的彩度放大回去——只改鲜艳度、
                  <b>保留偏色方向与原色间相对关系</b>，避免成品发灰。拟合时已自动给一个值，可手动微调；
                  1.0× 为原样不还原。
                </div>
                <div className="rgbcal-sat-row">
                  <Slider
                    style={{ flex: 1 }}
                    min={1}
                    max={MAX_CHROMA_GAIN}
                    step={0.1}
                    value={current.chromaGain ?? 1}
                    onChange={setChromaGain}
                  />
                  <span className="rgbcal-sat-val">{(current.chromaGain ?? 1).toFixed(1)}×</span>
                  <Button
                    size="mini"
                    onClick={() => setChromaGain(autoChromaGain(current.primaries))}
                  >
                    自动
                  </Button>
                </div>
              </div>
              <div className="cmykcal-editbox">
                <div className="cmykcal-edit-title">手动微调参数（各原色 sRGB 实测色 0–255）</div>
                <div className="cmykcal-warn">⚠ 手动修改会直接改变作画的颜色还原，请谨慎操作。</div>
                <RgbCalibrationTable cal={current} showSwatches={false} onChange={onEditCurrent} />
                <div className="cmykcal-name-row">
                  <Input
                    className="cmykcal-name-input"
                    placeholder="预设名称（留空自动按日期编号）"
                    value={editName}
                    onChange={(v: string) => setEditName(v)}
                    maxLength={24}
                    onPressEnter={onSaveCurrentNamed}
                  />
                  <Button type="primary" onClick={onSaveCurrentNamed}>
                    保存为预设
                  </Button>
                  <Button status="warning" onClick={onClear}>
                    恢复默认
                  </Button>
                </div>
              </div>
            </List.Item>
          </List>

          <List className="cmykcal-col" size="large" header="校准流程">
            <List.Item key="step1">
              <div className="title">① 分色打印校准片</div>
              <div className="describe">
                导出的 3MF 含 <b>5 个打印盘</b>（红/绿/蓝/黑/白各一盘）。在 Bambu Studio 里逐盘选择、
                逐个换上对应耗材打印——<b>全程不换色、无需 AMS</b>。每色一条实心色块，层高 {CAL_LAYER_MM}mm、
                100% 填充打成不透光实块。
              </div>
              <div className="describe">
                打印完把 5 条按<b>燕尾槽侧向滑入</b>拼成一整片（红在最上、白在最下），拼接后牢固不散。
              </div>
              <svg className="cmykcal-guide" viewBox="0 0 260 150" xmlns="http://www.w3.org/2000/svg">
                {CAL_ROWS.map((row, i) => {
                  const rh = 142 / CAL_ROWS.length;
                  const y = 4 + i * rh;
                  return (
                    <g key={row}>
                      <rect
                        x={6}
                        y={y + 1.5}
                        width={248}
                        height={rh - 3}
                        fill={rowHex(row)}
                        stroke="#666"
                        strokeWidth="0.5"
                      />
                      {i < CAL_ROWS.length - 1
                        ? [0.3, 0.55, 0.8].map((fx, k) => (
                            <path
                              key={k}
                              d={`M ${6 + fx * 248 - 5} ${y + rh} l 4 4 l 2 0 l 4 -4`}
                              fill="none"
                              stroke="#999"
                              strokeWidth="1"
                            />
                          ))
                        : null}
                    </g>
                  );
                })}
              </svg>
              <div className="describe" style={{ marginTop: 4 }}>
                （白参考无需另打：拼接片里的白色条本身就是白参考。）
              </div>
              <Button type="primary" loading={exporting} onClick={onExportTile}>
                导出校准片 3MF（5 盘）
              </Button>
            </List.Item>

            <List.Item key="step2">
              <div className="title">② 反射光下拍照并载入</div>
              <div className="describe">
                把拼好的整片平放在<b>均匀的环境光/柔光</b>下（避免直射强光、闪光灯与彩色反光），
                建议关闭手机自动白平衡、锁定曝光，正对拍一张，载入到这里。
                <b>照片只在本地浏览器读取处理，不会离开你的设备。</b>
              </div>
              <PhotoDropZone onFile={onPhoto} loaded={!!photoUrl} />
            </List.Item>

            {photoUrl ? (
              <List.Item key="step3">
                <div className="title">③ 点击拼接块四角配准</div>
                <div className="describe">
                  依次点击<b>五色拼接块</b>的四个角：红行左上 → 红行右上 → 白行右下 → 白行左下。
                  点满四个后会叠加绿色采样点（每色一个），第五次点击重新开始。
                </div>
                <canvas ref={dispCanvasRef} className="cmykcal-canvas" onClick={onCanvasClick} />
                <div style={{ marginTop: 10 }}>
                  <Button type="primary" onClick={onFit} disabled={corners.length !== 4}>
                    拟合校准（{corners.length}/4 角）
                  </Button>
                </div>
              </List.Item>
            ) : null}

            {fitted ? (
              <List.Item key="step4">
                <div className="title">④ 确认 · 命名保存到本地</div>
                <div className="describe">
                  下方是拟合结果（各原色实测显色），与白参考对比看是否合理。
                  给这组耗材起个名字保存到本地，之后可在「我保存的」里快捷点选。
                </div>
                <RgbCalibrationTable cal={fitted} />
                <div className="cmykcal-name-row">
                  <Input
                    className="cmykcal-name-input"
                    placeholder="预设名称（留空自动按日期编号）"
                    value={fitName}
                    onChange={(v: string) => setFitName(v)}
                    maxLength={24}
                    onPressEnter={onSaveNamed}
                  />
                  <Button type="primary" onClick={onSaveNamed}>
                    保存为预设并应用
                  </Button>
                  <Button onClick={() => applyCal(fitted)}>仅应用不保存</Button>
                </div>
              </List.Item>
            ) : null}
          </List>
        </div>
      </div>
    </div>
  );
};

export default RgbCalibrate;
