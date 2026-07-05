import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  List,
  Input,
  Button,
  Message,
  Tag,
  // @ts-ignore arco 类型偶尔解析不到
} from '@arco-design/web-react';
import { useDocumentTitle } from '../useDocumentTitle';
import { pack3mf } from 'bambu-3mf';
import { splitBoxSolids } from '../colorPositive/buildColorField';
import { buildCalibrationTile, CAL_ROWS } from './buildCalibrationTile';
import {
  CAL_LAYERS,
  CAL_LAYER_MM,
  WedgeSample,
  fitCalibration,
  saveCalibration,
  clearCalibration,
  loadCalibration,
  CmykCalibration,
  loadSavedCalibrations,
  addSavedCalibration,
  deleteSavedCalibration,
  nextAutoName,
} from './calibration';
import CalibrationTable from './CalibrationTable';
import CalibrationPicker from './CalibrationPicker';
import PhotoDropZone from './PhotoDropZone';
import PageNav from '../components/PageNav';
import './CmykCalibrate.css';

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

const LAYER_MM = CAL_LAYER_MM;
const CORNER_LABELS = ['左上', '右上', '右下', '左下'];

const CmykCalibrate: React.FC = () => {
  useDocumentTitle('CMYK 耗材校准');

  const [exporting, setExporting] = useState(false);
  const [photoUrl, setPhotoUrl] = useState('');
  const imgRef = useRef<HTMLImageElement | null>(null);
  const fullCanvasRef = useRef<HTMLCanvasElement | null>(null); // offscreen full-res
  const dispCanvasRef = useRef<HTMLCanvasElement | null>(null); // on-screen
  const [corners, setCorners] = useState<{ x: number; y: number }[]>([]); // natural coords
  const [dispScale, setDispScale] = useState(1);
  const [fitted, setFitted] = useState<CmykCalibration | null>(null);
  const [current, setCurrent] = useState<CmykCalibration>(() => loadCalibration());
  const [savedCals, setSavedCals] = useState(() => loadSavedCalibrations());
  const [fitName, setFitName] = useState('');
  const [editName, setEditName] = useState('');

  // ---- fullscreen white backlight (use the monitor as an even light source) --
  const [backlight, setBacklight] = useState(false);
  const openBacklight = useCallback(() => {
    setBacklight(true);
    const el = document.documentElement as HTMLElement & {
      requestFullscreen?: () => Promise<void>;
    };
    el.requestFullscreen?.().catch(() => {
      /* fullscreen optional — the white overlay still covers the viewport */
    });
  }, []);
  const closeBacklight = useCallback(() => {
    setBacklight(false);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }, []);
  // pressing Esc exits fullscreen on its own; keep the overlay state in sync
  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement) setBacklight(false);
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // ---- export calibration tile -------------------------------------------
  const onExportTile = useCallback(async () => {
    setExporting(true);
    try {
      const parts = buildCalibrationTile();
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
        layer_height: String(LAYER_MM),
        initial_layer_print_height: String(LAYER_MM),
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
        'color-cmyk',
        objects,
        { title: 'CMYK 校准片（4 盘单色）' },
        {
          projectSettingsOverrides: overrides,
          markModified: Object.keys(overrides),
        }
      );
      saveBlob(u8, 'cmyk-calibration.3mf');
      Message.success('校准片 3MF 已导出（4 个单色盘）');
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
        // full-res offscreen
        const fc = document.createElement('canvas');
        fc.width = img.width;
        fc.height = img.height;
        fc.getContext('2d')?.drawImage(img, 0, 0);
        fullCanvasRef.current = fc;
        // display scale (fit width 640)
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
    // markers
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
    // projected grid once all 4 corners are set
    if (corners.length === 4) {
      const R = CAL_ROWS.length;
      const C = CAL_LAYERS.length;
      const [TL, TR, BR, BL] = corners;
      const bil = (u: number, v: number) => {
        const tx = TL.x + (TR.x - TL.x) * u;
        const ty = TL.y + (TR.y - TL.y) * u;
        const bx = BL.x + (BR.x - BL.x) * u;
        const by = BL.y + (BR.y - BL.y) * u;
        return { x: (tx + (bx - tx) * v) * dispScale, y: (ty + (by - ty) * v) * dispScale };
      };
      ctx.strokeStyle = 'rgba(0,255,180,0.7)';
      ctx.lineWidth = 1;
      for (let i = 0; i < R; i++) {
        for (let j = 0; j < C; j++) {
          const c = bil((j + 0.5) / C, (i + 0.5) / R);
          ctx.strokeRect(c.x - 4, c.y - 4, 8, 8);
        }
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
    const R = CAL_ROWS.length; // 4 colour rows: C, M, Y, W
    const C = CAL_LAYERS.length;
    const [TL, TR, BR, BL] = corners;
    const bil = (u: number, v: number) => {
      const tx = TL.x + (TR.x - TL.x) * u;
      const ty = TL.y + (TR.y - TL.y) * u;
      const bx = BL.x + (BR.x - BL.x) * u;
      const by = BL.y + (BR.y - BL.y) * u;
      return { x: tx + (bx - tx) * v, y: ty + (by - ty) * v };
    };
    const cellW = Math.hypot(TR.x - TL.x, TR.y - TL.y) / C;
    const cellH = Math.hypot(BL.x - TL.x, BL.y - TL.y) / R;
    const half = Math.max(2, 0.25 * Math.min(cellW, cellH));

    // per-column white reference = the bare backlight just ABOVE and BELOW the
    // assembled block (v<0 and v>1), averaged. Same column ⇒ same X ⇒ corrects
    // horizontal backlight gradient; above+below average softens vertical drift.
    // sample half a row clear of the block so the box can't catch a patch edge
    const whiteCol: [number, number, number][] = [];
    for (let j = 0; j < C; j++) {
      const u = (j + 0.5) / C;
      const a = bil(u, -0.5 / R);
      const b = bil(u, 1 + 0.5 / R);
      const sa = sampleBox(a.x, a.y, half);
      const sb = sampleBox(b.x, b.y, half);
      whiteCol.push([(sa[0] + sb[0]) / 2, (sa[1] + sb[1]) / 2, (sa[2] + sb[2]) / 2]);
    }

    const samples: WedgeSample[] = [];
    for (let f = 0; f < R; f++) {
      for (let j = 0; j < C; j++) {
        const c = bil((j + 0.5) / C, (f + 0.5) / R);
        samples.push({
          filament: f,
          thicknessMm: CAL_LAYERS[j] * CAL_LAYER_MM,
          rgb: sampleBox(c.x, c.y, half),
          whiteRgb: whiteCol[j],
        });
      }
    }
    const cal = fitCalibration(samples);
    setFitted(cal);
    Message.success('已拟合，确认后点保存');
  }, [corners, sampleBox]);

  // ---- apply a calibration as the active one (preset / saved / fit) ----------
  const applyCal = useCallback((c: CmykCalibration) => {
    const copy: CmykCalibration = JSON.parse(JSON.stringify(c)); // own copy
    saveCalibration(copy);
    setCurrent(copy);
    setFitted(null);
    Message.success(copy.label ? `已应用：${copy.label}` : '已应用校准');
  }, []);

  // ---- live manual edit of the active calibration's α / white point ----------
  const onEditCurrent = useCallback((next: CmykCalibration) => {
    saveCalibration(next);
    setCurrent(next);
  }, []);

  // ---- name + save a calibration to the local preset list --------------------
  const saveAsPreset = useCallback(
    (cal: CmykCalibration, rawName: string) => {
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
    <div className="cmykcal">
      <PageNav title="CMYK 耗材校准" code="CMYK·CAL" backTo="/color-cmyk" />

      <div className="cmykcal-body">
        <div className="cmykcal-grid">
        <List className="cmykcal-col" size="large" header="当前校准 · 参数与预览">
          <List.Item key="status">
            <div className="lx-eyebrow">
              <span>当前校准</span>
              <span className="lx-eyebrow-code">CURRENT</span>
            </div>
            <div className="cmykcal-status">
              {current.calibrated ? (
                <Tag color="green">
                  {current.label
                    ? `预设：${current.label}`
                    : `已使用自定义校准${current.updatedAt ? `（${current.updatedAt.slice(0, 10)}）` : ''}`}
                </Tag>
              ) : (
                <Tag color="gray">未校准（按调色板推算默认值）</Tag>
              )}
            </div>
            <div className="describe">
              已有测好的耗材？<b>点下面的预设按钮即可一键套用</b>，无需重新拍照。也可以用右侧「校准流程」
              拍照自测，或在下方手动微调参数。
            </div>
            <CalibrationPicker
              activeLabel={current.label}
              saved={savedCals}
              onApply={applyCal}
              onDelete={onDeleteSaved}
            />
            <CalibrationTable cal={current} showTable={false} />
            <div className="cmykcal-editbox">
              <div className="lx-eyebrow cmykcal-edit-title">
                <span>手动微调参数</span>
                <span className="lx-eyebrow-code">MANUAL</span>
              </div>
              <div className="cmykcal-warn">⚠ 手动修改会直接改变作画的颜色还原，请谨慎操作。</div>
              <CalibrationTable cal={current} showSwatches={false} onChange={onEditCurrent} />
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
            <div className="lx-eyebrow cmykcal-step">
              <span>① 分色打印校准片</span>
              <span className="lx-eyebrow-code">STEP 01</span>
            </div>
            <div className="describe">
              导出的 3MF 含 <b>4 个打印盘</b>（青/品红/黄/白各一盘）。在 Bambu Studio 里逐盘选择、
              逐个换上对应耗材打印——<b>全程不换色、无需 AMS</b>。层高固定 {LAYER_MM}mm（与作画一致，
              厚度才对得上）。每色一条，含 {CAL_LAYERS.length} 个厚度楔形（
              {CAL_LAYERS.map((l) => (l * CAL_LAYER_MM).toFixed(2)).join(' / ')} mm）。
            </div>
            <div className="describe">
              打印完把 4 条按<b>燕尾槽侧向滑入</b>拼成一整片（青在最上、白在最下），拼接后牢固不散。
            </div>
            {/* 布局示意：4 条单色片 + 燕尾接缝 */}
            <svg className="cmykcal-guide" viewBox="0 0 260 150" xmlns="http://www.w3.org/2000/svg">
              {CAL_ROWS.map((row, i) => {
                const cols = CAL_LAYERS.length;
                const rh = 142 / CAL_ROWS.length;
                const y = 4 + i * rh;
                const colW = 248 / cols;
                const rowColor =
                  row === 'C' ? '#00AEEF' : row === 'M' ? '#EC008C' : row === 'Y' ? '#FFF200' : '#FFFFFF';
                return (
                  <g key={row}>
                    {CAL_LAYERS.map((l, j) => {
                      const op = 0.3 + 0.7 * (l / Math.max(...CAL_LAYERS));
                      return (
                        <rect
                          key={j}
                          x={6 + j * colW}
                          y={y + 1.5}
                          width={colW - 3}
                          height={rh - 3}
                          fill={rowColor}
                          opacity={op}
                        />
                      );
                    })}
                    {/* 燕尾接缝示意（行间） */}
                    {i < CAL_ROWS.length - 1
                      ? [0.3, 0.55, 0.8].map((fx, k) => (
                          <path
                            key={k}
                            d={`M ${6 + fx * 248 - 5} ${y + rh} l 4 4 l 2 0 l 4 -4`}
                            fill="none"
                            stroke="var(--lx-line-bright)"
                            strokeWidth="1"
                          />
                        ))
                      : null}
                  </g>
                );
              })}
            </svg>
            <div className="describe" style={{ marginTop: 4 }}>
              （白参考无需打印：拍照时拼接块四周露出背光即可。）
            </div>
            <Button type="primary" loading={exporting} onClick={onExportTile}>
              导出校准片 3MF（4 盘）
            </Button>
          </List.Item>

          <List.Item key="step2">
            <div className="lx-eyebrow cmykcal-step">
              <span>② 背光拍照并载入</span>
              <span className="lx-eyebrow-code">STEP 02</span>
            </div>
            <div className="describe">
              把拼好的整片平放在灯板/背光上，<b>四周留出一圈背光</b>（用作白参考）。建议关闭手机自动
              白平衡、锁定曝光，正对拍一张，载入到这里。<b>照片只在本地浏览器读取处理，不会离开你的设备。</b>
            </div>
            <div className="describe">
              没有灯板？可让<b>显示器当背光</b>：把屏幕亮度调到最高，点下面按钮全屏铺白，
              把拼接片贴在屏幕上用手机拍。点屏幕或按 Esc 退出。
            </div>
            <Button onClick={openBacklight} style={{ marginBottom: 12 }}>
              打开全屏白色背光
            </Button>
            <PhotoDropZone onFile={onPhoto} loaded={!!photoUrl} />
          </List.Item>

          {photoUrl ? (
            <List.Item key="step3">
              <div className="lx-eyebrow cmykcal-step">
                <span>③ 点击拼接块四角配准</span>
                <span className="lx-eyebrow-code">STEP 03</span>
              </div>
              <div className="describe">
                依次点击<b>四色拼接块</b>的四个角（青行左上角 → 右上角 → 白行右下角 → 左下角）：左上 → 右上 → 右下 → 左下。点满四个后会叠加绿色采样点，第五次点击重新开始。
              </div>
              <canvas
                ref={dispCanvasRef}
                className="cmykcal-canvas"
                onClick={onCanvasClick}
              />
              <div style={{ marginTop: 10 }}>
                <Button type="primary" onClick={onFit} disabled={corners.length !== 4}>
                  拟合校准（{corners.length}/4 角）
                </Button>
              </div>
            </List.Item>
          ) : null}

          {fitted ? (
            <List.Item key="step4">
              <div className="lx-eyebrow cmykcal-step">
                <span>④ 确认 · 命名保存到本地</span>
                <span className="lx-eyebrow-code">STEP 04</span>
              </div>
              <div className="describe">
                下方是拟合结果（各耗材 0.8mm 厚度下的显色预测与 α 系数），与白参考对比看是否合理。
                给这组耗材起个名字保存到本地，之后可在「我保存的」里快捷点选。
              </div>
              <CalibrationTable cal={fitted} />
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

      {backlight ? (
        <div className="cmykcal-backlight" onClick={closeBacklight}>
          <span className="cmykcal-backlight-hint">点击屏幕或按 Esc 退出 · 把屏幕亮度调到最高</span>
        </div>
      ) : null}
    </div>
  );
};

export default CmykCalibrate;
