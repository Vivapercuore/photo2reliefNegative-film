import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  List,
  Input,
  Button,
  Message,
  Tag,
  Slider,
  Radio,
  // @ts-ignore arco 类型偶尔解析不到
} from '@arco-design/web-react';
import { useDocumentTitle } from '../useDocumentTitle';
import {
  CAL_LAYERS,
  CAL_LAYER_MM,
  WedgeSample,
  fitCalibration,
  mergeCalibration,
  saveCalibration,
  clearCalibration,
  loadCalibration,
  CmykCalibration,
  loadSavedCalibrations,
  addSavedCalibration,
  deleteSavedCalibration,
  nextAutoName,
} from './calibration';
import {
  Quad,
  defaultQuad,
  stepCenters,
  whiteRefPairs,
  sampleHalf,
} from './stripSampling';
import StripAlignFrame from './StripAlignFrame';
import CalibrationTable from './CalibrationTable';
import CalibrationPicker from './CalibrationPicker';
import PhotoDropZone from './PhotoDropZone';
import ArtworkCorrect from './ArtworkCorrect';
import './CmykCalibrate.css';

// TODO: 校准模型链接由用户提供后填入
const CAL_MODEL_URL = '';

/** The four filaments, in the fit's filament-index order (C,M,Y,W). */
const FILAMENTS = [
  { id: 'C', name: '青', color: '#00AEEF' },
  { id: 'M', name: '品红', color: '#EC008C' },
  { id: 'Y', name: '黄', color: '#FFF200' },
  { id: 'W', name: '白', color: '#FFFFFF' },
];

const N_STEPS = CAL_LAYERS.length; // 7 wedge steps per strip

/** Per-strip state: the loaded photo canvas, its alignment quad, the white-ref
 *  offset, and the sampled result (null until sampled / after any realignment). */
interface StripState {
  canvas: HTMLCanvasElement;
  quad: Quad;
  whiteOff: number;
  samples: WedgeSample[] | null;
  swatches: { steps: string[]; white: string } | null;
}

const toHex = (r: number, g: number, b: number) =>
  '#' +
  [r, g, b]
    .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0').toUpperCase())
    .join('');

const CmykCalibrate: React.FC = () => {
  const navigate = useNavigate();
  useDocumentTitle('CMYK 耗材校准');

  const [strips, setStrips] = useState<(StripState | null)[]>([null, null, null, null]);
  const [active, setActive] = useState(0);
  const [fitted, setFitted] = useState<CmykCalibration | null>(null);
  // which filaments this fit freshly measured vs. carried over from `current`,
  // plus whether that carried-over base was itself calibrated (drives the note
  // / warning shown above the result table)
  const [fitMeta, setFitMeta] = useState<{ fresh: number[]; baseCalibrated: boolean } | null>(
    null
  );
  const [current, setCurrent] = useState<CmykCalibration>(() => loadCalibration());
  const [savedCals, setSavedCals] = useState(() => loadSavedCalibrations());
  const [fitName, setFitName] = useState('');
  const [editName, setEditName] = useState('');
  // right-column flow: 校准条校准 (strip) vs. 成品对照修正 (artwork)
  const [mode, setMode] = useState<'strip' | 'artwork'>('strip');

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

  // any change that invalidates the current fit clears both the fit and its meta
  const clearFit = useCallback(() => {
    setFitted(null);
    setFitMeta(null);
  }, []);

  // ---- photo upload (per filament) ----------------------------------------
  const onPhoto = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const url = e.target?.result as string;
        const img = new Image();
        img.onload = () => {
          // draw to a working canvas, longest edge capped at 2000px to bound
          // memory on huge phone photos (keep aspect ratio)
          const MAX_EDGE = 2000;
          const s = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
          const cw = Math.max(1, Math.round(img.width * s));
          const ch = Math.max(1, Math.round(img.height * s));
          const canvas = document.createElement('canvas');
          canvas.width = cw;
          canvas.height = ch;
          canvas.getContext('2d')?.drawImage(img, 0, 0, cw, ch);
          const strip: StripState = {
            canvas,
            quad: defaultQuad(cw, ch),
            whiteOff: 0.75,
            samples: null,
            swatches: null,
          };
          setStrips((prev) => {
            const next = prev.slice();
            next[active] = strip;
            return next;
          });
          clearFit(); // realigning any strip invalidates the previous fit
        };
        img.src = url;
      };
      reader.readAsDataURL(file);
    },
    [active, clearFit]
  );

  // quad / whiteOff change → update the strip and drop its stale samples + fit
  const onQuadChange = useCallback(
    (q: Quad) => {
      setStrips((prev) => {
        const cur = prev[active];
        if (!cur) return prev;
        const next = prev.slice();
        next[active] = { ...cur, quad: q, samples: null, swatches: null };
        return next;
      });
      clearFit();
    },
    [active, clearFit]
  );

  const onWhiteOff = useCallback(
    (v: number | number[]) => {
      const off = Array.isArray(v) ? v[0] : v;
      setStrips((prev) => {
        const cur = prev[active];
        if (!cur) return prev;
        const next = prev.slice();
        next[active] = { ...cur, whiteOff: off, samples: null, swatches: null };
        return next;
      });
      clearFit();
    },
    [active, clearFit]
  );

  // mean-sample a square region on a strip canvas, intersected with the canvas
  // bounds first (empty intersection → null, so out-of-frame boxes are ignored)
  const sampleBox = useCallback(
    (canvas: HTMLCanvasElement, cx: number, cy: number, half: number): [number, number, number] | null => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      const x0 = Math.max(0, Math.round(cx - half));
      const y0 = Math.max(0, Math.round(cy - half));
      const x1 = Math.min(canvas.width, Math.round(cx + half));
      const y1 = Math.min(canvas.height, Math.round(cy + half));
      const w = x1 - x0;
      const h = y1 - y0;
      if (w <= 0 || h <= 0) return null; // no overlap with the image
      const d = ctx.getImageData(x0, y0, w, h).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
        n++;
      }
      return n ? [r / n, g / n, b / n] : null;
    },
    []
  );

  // ---- sample the active strip --------------------------------------------
  const onSample = useCallback(() => {
    const strip = strips[active];
    if (!strip) return;
    // was this strip already sampled? if so, the user is re-shooting it on
    // purpose — don't auto-advance focus away from it after sampling.
    const wasSampled = !!strip.samples;
    const { canvas, quad, whiteOff } = strip;
    const half = sampleHalf(quad, N_STEPS);
    const centers = stepCenters(quad, N_STEPS);
    const whites = whiteRefPairs(quad, N_STEPS, whiteOff);

    const samples: WedgeSample[] = [];
    const stepHex: string[] = [];
    let whiteAcc: [number, number, number] = [0, 0, 0];
    for (let j = 0; j < N_STEPS; j++) {
      const patch = sampleBox(canvas, centers[j].x, centers[j].y, half);
      if (!patch) {
        Message.warning('采样越界：把黄色对准框拖回条内（每一阶都要落在图内）。');
        return;
      }
      // per-column white reference = the brighter of the above / below boxes
      const a = sampleBox(canvas, whites[j].above.x, whites[j].above.y, half);
      const b = sampleBox(canvas, whites[j].below.x, whites[j].below.y, half);
      const cand: [number, number, number][] = [];
      if (a) cand.push(a);
      if (b) cand.push(b);
      if (!cand.length) {
        Message.warning('白参考太暗：把白色虚线框移到条外的背光上，或调整白参考距离。');
        return;
      }
      const white = cand.reduce((p, c) => (c[0] + c[1] + c[2] > p[0] + p[1] + p[2] ? c : p));
      if (white[0] + white[1] + white[2] < 60) {
        Message.warning('白参考太暗：把白色虚线框移到条外的背光上，或调整白参考距离。');
        return;
      }
      samples.push({
        filament: active,
        thicknessMm: CAL_LAYERS[j] * CAL_LAYER_MM,
        rgb: patch,
        whiteRgb: white,
      });
      stepHex.push(toHex(patch[0], patch[1], patch[2]));
      whiteAcc = [whiteAcc[0] + white[0], whiteAcc[1] + white[1], whiteAcc[2] + white[2]];
    }
    const whiteHex = toHex(whiteAcc[0] / N_STEPS, whiteAcc[1] / N_STEPS, whiteAcc[2] / N_STEPS);

    setStrips((prev) => {
      const cur = prev[active];
      if (!cur) return prev;
      const next = prev.slice();
      next[active] = { ...cur, samples, swatches: { steps: stepHex, white: whiteHex } };
      return next;
    });
    clearFit();
    Message.success(`已采样：${FILAMENTS[active].name} ${FILAMENTS[active].id} 条`);

    // auto-advance to the next un-sampled tab, but only right after sampling a
    // previously-un-sampled strip (re-shooting keeps focus on the current strip)
    if (!wasSampled) {
      const done = new Set<number>();
      strips.forEach((st, i) => {
        if (i === active || (st && st.samples)) done.add(i);
      });
      for (let i = 0; i < FILAMENTS.length; i++) {
        if (!done.has(i)) {
          setActive(i);
          break;
        }
      }
    }
  }, [strips, active, sampleBox, clearFit]);

  const sampledCount = strips.filter((s) => s && s.samples).length;

  // ---- fit (any number of strips sampled → partial / progressive merge) -----
  const onFit = useCallback(() => {
    // collect samples from whatever strips are currently sampled; the fit only
    // updates those filaments, the rest carry over from `current` (the base at
    // fit time). α is exposure-independent so rows compose across shoots.
    const sampledIdx: number[] = [];
    const all: WedgeSample[] = [];
    strips.forEach((s, f) => {
      if (s && s.samples) {
        sampledIdx.push(f);
        all.push(...s.samples);
      }
    });
    if (!all.length) return;
    const fit = fitCalibration(all);
    const merged = mergeCalibration(current, fit, sampledIdx);
    setFitted(merged);
    setFitMeta({ fresh: sampledIdx, baseCalibrated: current.calibrated });
    Message.success(
      sampledIdx.length === FILAMENTS.length
        ? '已拟合全部四条，确认后点保存'
        : `已拟合 ${sampledIdx.length} 条（其余沿用当前校准），确认后点保存`
    );
  }, [strips, current]);

  // ---- apply a calibration as the active one (preset / saved / fit) ----------
  const applyCal = useCallback(
    (c: CmykCalibration) => {
      const copy: CmykCalibration = JSON.parse(JSON.stringify(c)); // own copy
      saveCalibration(copy);
      setCurrent(copy);
      clearFit();
      Message.success(copy.label ? `已应用：${copy.label}` : '已应用校准');
    },
    [clearFit]
  );

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
    clearFit();
    Message.info('已恢复未校准默认值');
  }, [clearFit]);

  const activeStrip = strips[active];

  return (
    <div className="cmykcal">
      <div className="page-nav">
        <Button type="text" size="small" onClick={() => navigate('/color-cmyk')}>
          ← 返回 CMYK 模块
        </Button>
        <span className="page-nav-title">CMYK 耗材校准</span>
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
                <div className="cmykcal-edit-title">手动微调参数</div>
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
            <List.Item key="mode">
              <div className="artfix-mode-row">
                <Radio.Group
                  type="button"
                  value={mode}
                  onChange={(v: string) => setMode(v as 'strip' | 'artwork')}
                >
                  <Radio value="strip">校准条校准（首次推荐）</Radio>
                  <Radio value="artwork">成品对照修正</Radio>
                </Radio.Group>
              </div>
              {mode === 'artwork' ? (
                <div className="describe" style={{ marginTop: 8 }}>
                  「成品对照修正」不用重新打印校准条：对着已打印的作品微调预览，让引擎学到真实显色。
                  首次校准仍建议用「校准条校准」一次测准。
                </div>
              ) : null}
            </List.Item>

            {mode === 'strip' ? (
            <>
            <List.Item key="step1">
              <div className="title">① 获取并打印校准条</div>
              <div className="describe">
                校准条是一条 <b>7 阶厚度楔形条</b>：第 1 格 0.08mm，每格加一层，到第 7 格 0.56mm
                （0.08mm 步进）。请用 <b>0.08mm 层高</b>打印，四种耗材各打印一条（青 C / 品红 M /
                黄 Y / 白 W，共 4 条），无需拼接。
              </div>
              <div className="describe">
                模型上的<b>半圆凸耳</b>有两个用途：拍照时<b>用手指按住凸耳</b>把条压平贴紧背光——手指只压在凸耳上，
                不会遮挡测光格；它也是<b>方向标记</b>，配准时把最薄的一格对到「1」号参照框。
              </div>
              {!CAL_MODEL_URL ? (
                <div className="describe">
                  （校准模型下载链接即将提供，敬请留意；在此之前下方「获取校准模型」按钮暂不可点。）
                </div>
              ) : null}
              {/* 单条 7 阶楔形示意 + 方向凸耳 */}
              <svg className="cmykcal-guide" viewBox="0 0 300 90" xmlns="http://www.w3.org/2000/svg">
                {/* outer strip frame */}
                <rect x="8" y="14" width="284" height="44" rx="5" fill="#222" stroke="#666" strokeWidth="1.5" />
                {/* 7 wedge cells, neutral grey, opacity ramp 0.15 → 0.9 */}
                {CAL_LAYERS.map((_, j) => {
                  const cellW = 280 / N_STEPS;
                  const x = 10 + j * cellW;
                  const op = 0.15 + (0.9 - 0.15) * (j / (N_STEPS - 1));
                  const cx = x + cellW / 2;
                  return (
                    <g key={j}>
                      <rect x={x} y="16" width={cellW - 1} height="40" fill="#9aabbb" opacity={op} />
                      <text x={cx} y="41" fill="#fff" fontSize="12" textAnchor="middle" opacity={0.85}>
                        {j + 1}
                      </text>
                    </g>
                  );
                })}
                {/* half-circle orientation ear on the lower edge, offset left */}
                <path d="M 40 58 a 10 10 0 0 0 20 0 z" fill="#222" stroke="#666" strokeWidth="1.5" />
                {/* press-here hint under the ear (拍照时手指压凸耳压平校准条) */}
                <text x="50" y="86" fill="#999" fontSize="9" textAnchor="middle">
                  手按此处
                </text>
                {/* thickness caption */}
                <text x="150" y="80" fill="#999" fontSize="11" textAnchor="middle">
                  0.08 → 0.56 mm（每格 +0.08）
                </text>
              </svg>
              {CAL_MODEL_URL ? (
                <Button type="primary" onClick={() => window.open(CAL_MODEL_URL, '_blank')}>
                  获取校准模型
                </Button>
              ) : (
                <Button disabled>获取校准模型（链接稍后提供）</Button>
              )}
            </List.Item>

            <List.Item key="step2">
              <div className="title">② 逐条背光拍照 · 对准 · 采样</div>
              <div className="describe">
                把校准条平放在灯板/背光上，条的<b>上下两侧留出背光</b>（作白参考）。建议关闭自动
                白平衡、锁定曝光，四条各拍一张。拍照时手指按住半圆凸耳固定校准条，别把手伸进测光格和白参考区域。
                <b>照片只在本地浏览器处理，不会离开你的设备。</b>
              </div>
              <div className="describe">
                没有灯板？可让<b>显示器当背光</b>：把屏幕亮度调到最高，点下面按钮全屏铺白，
                把校准条贴在屏幕上用手机拍。点屏幕或按 Esc 退出。
              </div>
              <Button onClick={openBacklight} style={{ marginBottom: 12 }}>
                打开全屏白色背光
              </Button>

              {/* 耗材 tab 行：切 tab 不丢任何数据 */}
              <div className="cmykcal-tabs">
                {FILAMENTS.map((fl, i) => {
                  const done = !!(strips[i] && strips[i]!.samples);
                  return (
                    <Button
                      key={fl.id}
                      size="small"
                      type={i === active ? 'primary' : 'secondary'}
                      onClick={() => setActive(i)}
                    >
                      <span
                        className={`cmykcal-tab-dot${fl.id === 'W' ? ' is-white' : ''}`}
                        style={{ background: fl.color }}
                      />
                      {fl.name} {fl.id}
                      {done ? ' ✓' : ''}
                    </Button>
                  );
                })}
              </div>

              <PhotoDropZone
                onFile={onPhoto}
                loaded={!!activeStrip}
                hint={`载入「${FILAMENTS[active].name} ${FILAMENTS[active].id}」条的照片 · 全程本地读取`}
              />

              {activeStrip ? (
                <>
                  <div style={{ marginTop: 12 }}>
                    <StripAlignFrame
                      source={activeStrip.canvas}
                      quad={activeStrip.quad}
                      onQuadChange={onQuadChange}
                      whiteOff={activeStrip.whiteOff}
                      steps={N_STEPS}
                    />
                  </div>
                  <div className="describe" style={{ marginTop: 10 }}>
                    拖动<b>黄色边框</b>（角、边、框内均可拖动），让 7 个绿色参照框落在每一阶中心
                    （1 最薄 → 7 最厚）。<b>白色虚线框</b>是白参考采样位，需落在<b>条外的背光</b>上——
                    可用下方「白参考距离」调整。
                  </div>
                  <div className="cmykcal-name-row">
                    <span className="cmykcal-slider-label">白参考距离</span>
                    <Slider
                      style={{ flex: 1, minWidth: 160 }}
                      min={0.3}
                      max={2}
                      step={0.05}
                      value={activeStrip.whiteOff}
                      onChange={onWhiteOff}
                    />
                    <span className="cmykcal-slider-val">{activeStrip.whiteOff.toFixed(2)}</span>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    <Button type="primary" onClick={onSample}>
                      采样本条（{FILAMENTS[active].name} {FILAMENTS[active].id}）
                    </Button>
                  </div>
                  {activeStrip.swatches ? (
                    <div className="cmykcal-strip-swatches">
                      {activeStrip.swatches.steps.map((hex, j) => (
                        <i
                          key={j}
                          style={{ background: hex }}
                          title={`${(CAL_LAYERS[j] * CAL_LAYER_MM).toFixed(2)}mm`}
                        />
                      ))}
                      <i
                        className="is-white-ref"
                        style={{ background: activeStrip.swatches.white }}
                        title="白参考"
                      />
                    </div>
                  ) : null}
                </>
              ) : null}
            </List.Item>

            <List.Item key="step3">
              <div className="title">③ 拟合 · 确认 · 保存</div>
              <div className="describe">
                <b>采完任意一条即可拟合</b>：本次拟合更新已采样耗材的 α，
                <b>未采样的沿用「当前校准」的数值</b>——可逐条补测、随测随存（拟合以点击时的当前校准为底）。
                建议最终四条都测齐。给这组耗材起个名字保存到本地，之后可在「我保存的」里一键套用。
              </div>
              <Button type="primary" onClick={onFit} disabled={sampledCount === 0}>
                拟合校准（{sampledCount}/4 条已采样）
              </Button>
              {fitted ? (
                <>
                  {fitMeta ? (
                    <>
                      <div className="describe" style={{ marginTop: 10 }}>
                        本次拟合更新：
                        {fitMeta.fresh.map((f) => `${FILAMENTS[f].name} ${FILAMENTS[f].id}`).join(' / ')}
                        ；沿用当前：
                        {FILAMENTS.filter((_, f) => !fitMeta.fresh.includes(f))
                          .map((fl) => `${fl.name} ${fl.id}`)
                          .join(' / ') || '无'}
                      </div>
                      {fitMeta.fresh.length < FILAMENTS.length && !fitMeta.baseCalibrated ? (
                        <div className="cmykcal-warn">
                          ⚠ 沿用的数值来自未校准默认值，仅作占位——建议尽快补测对应耗材。
                        </div>
                      ) : null}
                    </>
                  ) : null}
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
                </>
              ) : null}
            </List.Item>
            </>
            ) : (
              <List.Item key="artwork">
                <ArtworkCorrect
                  current={current}
                  saved={savedCals}
                  onApply={applyCal}
                  saveAsPreset={saveAsPreset}
                />
              </List.Item>
            )}
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
