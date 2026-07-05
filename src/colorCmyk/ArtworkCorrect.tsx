import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Select,
  Input,
  InputNumber,
  Button,
  Slider,
  Spin,
  // @ts-ignore arco 类型偶尔解析不到
} from '@arco-design/web-react';
import {
  CmykCalibration,
  SavedCalibration,
  CALIBRATION_PRESETS,
  CAL_LAYER_MM,
} from './calibration';
import { CmykField, quantizeCmyk, cmykToRGBA } from './cmyk';
import { RGBAImage } from '../colorPositive/dither';
import { HslDelta, ZERO_DELTAS, applyHslDeltas } from './artworkCorrection';
import CalibrationTable from './CalibrationTable';
import PhotoDropZone from './PhotoDropZone';

const Option = Select.Option;

/** The four filaments, in fit / α-row order (C,M,Y,W) — mirrors CmykCalibrate. */
const FILAMENTS = [
  { id: 'C', name: '青', color: '#00AEEF' },
  { id: 'M', name: '品红', color: '#EC008C' },
  { id: 'Y', name: '黄', color: '#FFF200' },
  { id: 'W', name: '白', color: '#FFFFFF' },
];

/** Longest edge (px) the working canvas is capped at — bounds decode memory. */
const MAX_WORK_EDGE = 1000;
/** Longest edge (cells) of the quantization grid — matches the artwork page's
 *  own preview density closely enough to expose per-filament colour shifts. */
const MAX_GRID_EDGE = 220;
/** Minimum grid dimension so a very lopsided image still solves a sane field. */
const MIN_GRID = 8;
/** White floor / top-white layers — DEFAULTS matching the artwork page's own
 *  defaults. The reconstructed field must reproduce the field the print was
 *  ACTUALLY made with (baseLayers/topLayers fold into the colour→thickness
 *  solve — see cmyk.ts fixedWhiteMm), so the user can override these in ① to
 *  match whatever white settings they printed with. */
const DEFAULT_BASE_LAYERS = 2;
const DEFAULT_TOP_LAYERS = 1;
/** Continuous-solve dot size (mm) passed to quantizeCmyk; irrelevant to colour,
 *  only labels the field's physical cell. Matches the artwork page's scale. */
const DOT_MM = 0.4;

/** A deep, mutable copy of a calibration (so the base is never shared/mutated). */
function cloneCal(cal: CmykCalibration): CmykCalibration {
  return {
    alpha: cal.alpha.map((row) => row.slice()),
    white: [cal.white[0], cal.white[1], cal.white[2]],
    calibrated: cal.calibrated,
    label: cal.label,
    updatedAt: cal.updatedAt,
  };
}

/** Fresh all-zero deltas (ZERO_DELTAS is frozen — never edit it in place). */
function zeroDeltas(): HslDelta[] {
  return ZERO_DELTAS.map((d) => ({ h: d.h, s: d.s, l: d.l }));
}

interface BaseOption {
  key: string;
  label: string;
  cal: CmykCalibration;
}

interface Props {
  /** the page's active calibration (offered as the default base "当前校准") */
  current: CmykCalibration;
  /** user-saved calibrations, listed after the built-in presets */
  saved: SavedCalibration[];
  /** apply the corrected calibration as the active one (no save) */
  onApply: (cal: CmykCalibration) => void;
  /** save the corrected calibration as a named preset (and apply it) */
  saveAsPreset: (cal: CmykCalibration, name: string) => void;
}

/**
 * "成品对照修正" — recover the true material calibration by eye from a physical
 * print, no calibration strip needed. The printed thickness field is a fixed
 * fact solved once under the OLD (base) calibration; the sliders only re-express
 * each filament's α row as an equivalent colour, and when the on-screen preview
 * matches the real print, the slider-adjusted calibration IS the correction
 * (α is exposure-independent — see artworkCorrection.ts).
 */
const ArtworkCorrect: React.FC<Props> = ({ current, saved, onApply, saveAsPreset }) => {
  // ---- ① base calibration selection ---------------------------------------
  // Stable option list: 当前校准 + built-in presets + user-saved. `value` is a
  // stable key (current / preset:{id} / saved:{id}); we resolve it to a deep
  // copy so nothing downstream mutates the shared source object.
  const baseOptions = useMemo<BaseOption[]>(() => {
    const opts: BaseOption[] = [{ key: 'current', label: '当前校准', cal: current }];
    CALIBRATION_PRESETS.forEach((p) => opts.push({ key: `preset:${p.id}`, label: p.label, cal: p.cal }));
    saved.forEach((s) => opts.push({ key: `saved:${s.id}`, label: s.label, cal: s.cal }));
    return opts;
  }, [current, saved]);

  const [baseKey, setBaseKey] = useState('current');
  // the base calibration (deep copy) the correction is reasoned against
  const baseCal = useMemo<CmykCalibration>(() => {
    const found = baseOptions.find((o) => o.key === baseKey) ?? baseOptions[0];
    return cloneCal(found.cal);
  }, [baseOptions, baseKey]);

  // ---- ① print white/thickness settings (must match the ACTUAL print) ------
  // These fold into the field solve exactly as they do on the artwork page:
  // baseLayers/topLayers change the fixed-white removed from the target (cmyk.ts
  // fixedWhiteMm) and targetTotalMm rescales the colour layers. If the print was
  // made with non-default white/thickness settings, the reconstructed field must
  // use the SAME values or the recovered α is biased — so the user can override.
  const [baseLayers, setBaseLayers] = useState(DEFAULT_BASE_LAYERS);
  const [topLayers, setTopLayers] = useState(DEFAULT_TOP_LAYERS);
  // null = natural thickness (no rescale), matching the artwork page's default.
  const [targetTotalMm, setTargetTotalMm] = useState<number | null>(null);

  // ---- ② working image ----------------------------------------------------
  const [work, setWork] = useState<HTMLCanvasElement | null>(null);

  // ---- ③ correction state -------------------------------------------------
  const [field, setField] = useState<CmykField | null>(null);
  const [deltas, setDeltas] = useState<HslDelta[]>(() => zeroDeltas());
  const [artFilament, setArtFilament] = useState(0);
  const [busy, setBusy] = useState(false);
  const dispRef = useRef<HTMLCanvasElement | null>(null);

  // ---- ④ generated correction ---------------------------------------------
  const [corrected, setCorrected] = useState<CmykCalibration | null>(null);
  const [fitName, setFitName] = useState('');

  // any change of base, image, or slider invalidates a previously-generated
  // correction (its deltas / base no longer describe the current preview)
  const invalidateCorrected = useCallback(() => setCorrected(null), []);

  // ---- image load: decode → working canvas (longest edge ≤ MAX_WORK_EDGE) --
  const onPhoto = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const url = e.target?.result as string;
        const img = new Image();
        img.onload = () => {
          const s = Math.min(1, MAX_WORK_EDGE / Math.max(img.width, img.height));
          const cw = Math.max(1, Math.round(img.width * s));
          const ch = Math.max(1, Math.round(img.height * s));
          const canvas = document.createElement('canvas');
          canvas.width = cw;
          canvas.height = ch;
          canvas.getContext('2d')?.drawImage(img, 0, 0, cw, ch);
          setWork(canvas);
          setDeltas(zeroDeltas()); // fresh image → drop stale adjustments
          invalidateCorrected();
        };
        img.src = url;
      };
      reader.readAsDataURL(file);
    },
    [invalidateCorrected]
  );

  // ---- field: re-quantize whenever the image, base calibration, or the print
  // white/thickness settings change -----------------------------------------
  // The printed thickness field is a fixed fact solved under the BASE (old)
  // calibration — exactly what the artwork page would have produced when this
  // print was made. It does NOT depend on the sliders (those only re-colour the
  // α rows for the preview). The white/thickness params are taken from the ①
  // inputs so the reconstructed field matches the SETTINGS the print was made
  // with; getting them right is a precondition of the recovered α being valid.
  useEffect(() => {
    if (!work) {
      setField(null);
      return;
    }
    const ctx = work.getContext('2d');
    if (!ctx) return;
    setBusy(true);
    // let the browser paint the spinner before the (synchronous) solve blocks
    const timer = window.setTimeout(() => {
      const imgData = ctx.getImageData(0, 0, work.width, work.height);
      const src: RGBAImage = { width: work.width, height: work.height, data: imgData.data };
      const long = Math.max(work.width, work.height);
      const scale = MAX_GRID_EDGE / long;
      const cols = Math.max(MIN_GRID, Math.round(work.width * scale));
      const rows = Math.max(MIN_GRID, Math.round(work.height * scale));
      const f = quantizeCmyk(src, cols, rows, DOT_MM, {
        cal: baseCal,
        layerMm: CAL_LAYER_MM,
        baseLayers,
        topLayers,
        targetTotalMm: targetTotalMm ?? undefined,
      });
      setField(f);
      setBusy(false);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      setBusy(false);
    };
  }, [work, baseCal, baseLayers, topLayers, targetTotalMm]);

  // ---- adjusted calibration (base + live slider deltas) --------------------
  const adjusted = useMemo(() => applyHslDeltas(baseCal, deltas), [baseCal, deltas]);

  // ---- preview: recombine the fixed field under the adjusted calibration ----
  // preview = cmykToRGBA(field, K(deltas)) — when it matches the real print,
  // K(deltas) is the material estimate. Rendered to an offscreen cols×rows
  // canvas then scaled up (nearest-neighbour) into the display canvas.
  useEffect(() => {
    const disp = dispRef.current;
    if (!disp || !field) return;
    const { cols, rows } = field;
    const rgba = cmykToRGBA(field, adjusted, CAL_LAYER_MM, baseLayers);
    const off = document.createElement('canvas');
    off.width = cols;
    off.height = rows;
    const octx = off.getContext('2d');
    if (!octx) return;
    octx.putImageData(new ImageData(rgba, cols, rows), 0, 0);
    // display canvas keeps the field's aspect ratio; CSS caps the on-screen
    // width, the intrinsic size drives the upscale
    disp.width = cols;
    disp.height = rows;
    const dctx = disp.getContext('2d');
    if (!dctx) return;
    dctx.imageSmoothingEnabled = false;
    dctx.drawImage(off, 0, 0);
  }, [field, adjusted, baseLayers]);

  // ---- slider handlers (each edit clears any generated correction) ---------
  const setDelta = useCallback(
    (f: number, key: keyof HslDelta, v: number) => {
      setDeltas((prev) => {
        const next = prev.map((d) => ({ ...d }));
        next[f][key] = v;
        return next;
      });
      invalidateCorrected();
    },
    [invalidateCorrected]
  );

  const resetFilament = useCallback(
    (f: number) => {
      setDeltas((prev) => {
        const next = prev.map((d) => ({ ...d }));
        next[f] = { h: 0, s: 0, l: 0 };
        return next;
      });
      invalidateCorrected();
    },
    [invalidateCorrected]
  );

  const resetAll = useCallback(() => {
    setDeltas(zeroDeltas());
    invalidateCorrected();
  }, [invalidateCorrected]);

  const onBaseChange = useCallback(
    (v: string) => {
      setBaseKey(v);
      invalidateCorrected(); // a new base means the deltas describe a different origin
    },
    [invalidateCorrected]
  );

  // print white/thickness settings rebuild the field, so a generated correction
  // (fitted to the previous field) is no longer valid — clear it.
  const onBaseLayersChange = useCallback(
    (v: number) => {
      setBaseLayers(Math.max(0, Math.min(12, Math.round(v || 0))));
      invalidateCorrected();
    },
    [invalidateCorrected]
  );
  const onTopLayersChange = useCallback(
    (v: number) => {
      setTopLayers(Math.max(0, Math.min(12, Math.round(v || 0))));
      invalidateCorrected();
    },
    [invalidateCorrected]
  );
  const onTargetTotalChange = useCallback(
    (v: number | null) => {
      setTargetTotalMm(v == null ? null : v);
      invalidateCorrected();
    },
    [invalidateCorrected]
  );

  // a filament has an active adjustment if any of its three deltas is non-zero
  const touched = useCallback((f: number) => {
    const d = deltas[f];
    return d.h !== 0 || d.s !== 0 || d.l !== 0;
  }, [deltas]);

  const anyTouched = deltas.some((d) => d.h !== 0 || d.s !== 0 || d.l !== 0);

  // ---- ④ generate the correction from the current deltas -------------------
  const onGenerate = useCallback(() => {
    if (!field || !anyTouched) return;
    setCorrected(applyHslDeltas(baseCal, deltas));
  }, [field, anyTouched, baseCal, deltas]);

  const onSaveNamed = useCallback(() => {
    if (!corrected) return;
    saveAsPreset(corrected, fitName);
    setFitName('');
  }, [corrected, fitName, saveAsPreset]);

  // ---- per-filament non-zero adjustment summary (for the ④ recap line) -----
  const summary = useMemo(() => {
    if (!corrected) return '';
    const parts: string[] = [];
    deltas.forEach((d, f) => {
      const bits: string[] = [];
      if (d.h !== 0) bits.push(`色相${d.h > 0 ? '+' : ''}${d.h}°`);
      if (d.s !== 0) bits.push(`饱和度${d.s > 0 ? '+' : ''}${d.s}`);
      if (d.l !== 0) bits.push(`明度${d.l > 0 ? '+' : ''}${d.l}`);
      if (bits.length) parts.push(`${FILAMENTS[f].name} ${FILAMENTS[f].id} ${bits.join(' · ')}`);
    });
    return parts.join('；');
  }, [corrected, deltas]);

  const cur = deltas[artFilament];
  const fmtDeg = (v: number) => `${v > 0 ? '+' : ''}${v}°`;
  const fmtNum = (v: number) => `${v > 0 ? '+' : ''}${v}`;

  return (
    <div className="artfix">
      {/* ① base calibration */}
      <div className="title">① 选择打印时用的校准</div>
      <div className="describe">
        选打印这件成品时所用的那套校准/预设——修正在它的基础上反推偏差。
      </div>
      <Select value={baseKey} onChange={onBaseChange} style={{ maxWidth: 360, width: '100%' }}>
        {baseOptions.map((o) => (
          <Option key={o.key} value={o.key}>
            {o.label}
          </Option>
        ))}
      </Select>

      {/* print white/thickness settings — MUST match the actual print, or the
          reconstructed field (and thus the recovered correction) is biased */}
      <div className="describe" style={{ marginTop: 12 }}>
        再填打印这件成品时用的白层与厚度设置（与打印页一致）——仿真按这些设置还原厚度场；
        <b>若打印时没改过就保持默认（白底 2 层 · 顶白 1 层 · 自然厚度）。</b>
        填错会让还原的厚度场偏离实物，反推的修正也随之偏差。
      </div>
      <div className="artfix-print-row">
        <div className="artfix-print-field">
          <span className="artfix-print-label">白色底层</span>
          <InputNumber
            style={{ width: 132 }}
            mode="button"
            suffix="层"
            min={0}
            max={12}
            step={1}
            precision={0}
            value={baseLayers}
            onChange={onBaseLayersChange}
          />
        </div>
        <div className="artfix-print-field">
          <span className="artfix-print-label">顶部白色盖层</span>
          <InputNumber
            style={{ width: 132 }}
            mode="button"
            suffix="层"
            min={0}
            max={12}
            step={1}
            precision={0}
            value={topLayers}
            onChange={onTopLayersChange}
          />
        </div>
        <div className="artfix-print-field">
          <span className="artfix-print-label">缩放总厚度</span>
          <InputNumber
            style={{ width: 150 }}
            mode="button"
            suffix="mm"
            min={Number(((baseLayers + 1) * CAL_LAYER_MM).toFixed(2))}
            max={20}
            step={CAL_LAYER_MM}
            precision={2}
            placeholder="自然厚度"
            value={targetTotalMm ?? undefined}
            onChange={onTargetTotalChange}
          />
          {targetTotalMm != null ? (
            <Button size="small" onClick={() => onTargetTotalChange(null)}>
              恢复自然
            </Button>
          ) : null}
        </div>
      </div>

      {/* ② artwork image */}
      <div className="title" style={{ marginTop: 20 }}>
        ② 载入打印用的原图
      </div>
      <div className="describe">
        上传当时用来生成模型的图片（若打印前用过「图像编辑」，请上传编辑后的效果图）；载入后按所选校准仿真出切分预览；
        <b>照片只在本地浏览器处理，不会离开你的设备。</b>
      </div>
      <PhotoDropZone
        onFile={onPhoto}
        loaded={!!work}
        hint="载入打印成品所用的原图 · 全程本地读取"
      />

      {work ? (
        <>
          {/* ③ match preview to the physical print by slider */}
          <div className="title" style={{ marginTop: 20 }}>
            ③ 对照实物调滑块
          </div>
          <div className="describe">
            把打印成品放在与拍照/验收时相同的背光上，对比下方预览。逐通道调滑块，直到预览看起来和实物最相似——
            此时滑块描述的就是旧参数与真实显色的偏差。
          </div>

          {/* filament tabs (reuse the strip-flow tab styling) */}
          <div className="cmykcal-tabs">
            {FILAMENTS.map((fl, i) => (
              <Button
                key={fl.id}
                size="small"
                type={i === artFilament ? 'primary' : 'secondary'}
                onClick={() => setArtFilament(i)}
              >
                <span
                  className={`cmykcal-tab-dot${fl.id === 'W' ? ' is-white' : ''}`}
                  style={{ background: fl.color }}
                />
                {fl.name} {fl.id}
                {touched(i) ? ' ✎' : ''}
              </Button>
            ))}
          </div>

          {/* preview canvas (busy overlay while re-quantizing the field) */}
          <div className="artfix-preview">
            <Spin loading={busy} style={{ display: 'block' }}>
              <canvas ref={dispRef} className="artfix-canvas" />
            </Spin>
          </div>

          {/* the active filament's three HSL sliders */}
          <div className="artfix-slider-row">
            <span className="artfix-slider-label">色相</span>
            <Slider
              style={{ flex: 1, minWidth: 160 }}
              min={-60}
              max={60}
              step={1}
              value={cur.h}
              onChange={(v: number | number[]) =>
                setDelta(artFilament, 'h', Array.isArray(v) ? v[0] : v)
              }
            />
            <span className="artfix-slider-val">{fmtDeg(cur.h)}</span>
          </div>
          <div className="artfix-slider-row">
            <span className="artfix-slider-label">饱和度</span>
            <Slider
              style={{ flex: 1, minWidth: 160 }}
              min={-50}
              max={50}
              step={1}
              value={cur.s}
              onChange={(v: number | number[]) =>
                setDelta(artFilament, 's', Array.isArray(v) ? v[0] : v)
              }
            />
            <span className="artfix-slider-val">{fmtNum(cur.s)}</span>
          </div>
          <div className="artfix-slider-row">
            <span className="artfix-slider-label">明度</span>
            <Slider
              style={{ flex: 1, minWidth: 160 }}
              min={-30}
              max={30}
              step={1}
              value={cur.l}
              onChange={(v: number | number[]) =>
                setDelta(artFilament, 'l', Array.isArray(v) ? v[0] : v)
              }
            />
            <span className="artfix-slider-val">{fmtNum(cur.l)}</span>
          </div>

          <div className="artfix-btn-row">
            <Button size="small" onClick={() => resetFilament(artFilament)} disabled={!touched(artFilament)}>
              重置本通道
            </Button>
            <Button size="small" onClick={resetAll} disabled={!anyTouched}>
              全部重置
            </Button>
          </div>

          {/* live thickness ramps under the adjusted calibration */}
          <CalibrationTable cal={adjusted} showTable={false} />

          {/* ④ generate + save the correction */}
          <div className="title" style={{ marginTop: 20 }}>
            ④ 生成修正 · 保存
          </div>
          <div className="describe">
            预览与实物一致后点按钮生成修正参数——引擎会按真实显色重新求解厚度，下一次打印更接近原图。
          </div>
          <Button
            type="primary"
            onClick={onGenerate}
            disabled={!field || !anyTouched}
          >
            按当前偏差生成修正参数
          </Button>
          {/* the disabled button can't surface a native title (browsers don't
              fire hover events on disabled controls), so keep the hint visible */}
          {!field || !anyTouched ? (
            <div className="describe" style={{ marginTop: 6 }}>
              先在上一步调整任一通道的滑块，再生成修正参数。
            </div>
          ) : null}

          {corrected ? (
            <>
              <div className="describe" style={{ marginTop: 12 }}>
                <b>本次调整：</b>
                {summary}
              </div>
              <CalibrationTable cal={corrected} />
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
                <Button onClick={() => onApply(corrected)}>仅应用不保存</Button>
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
};

export default ArtworkCorrect;
