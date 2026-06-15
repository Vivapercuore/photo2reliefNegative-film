import React from 'react';
import {
  InputNumber,
  // @ts-ignore arco 类型偶尔解析不到
} from '@arco-design/web-react';
import { CmykCalibration, CAL_FILAMENTS, transmit, lin2srgb } from './calibration';

const toHex = (rgb: [number, number, number]) =>
  '#' +
  rgb
    .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0').toUpperCase())
    .join('');

/** Single-filament display colour at thickness t (mm) through the model. */
function swatchAt(cal: CmykCalibration, f: number, t: number): string {
  const th = [0, 0, 0, 0];
  th[f] = t;
  const lin = transmit(cal, th);
  return toHex([255 * lin2srgb(lin[0]), 255 * lin2srgb(lin[1]), 255 * lin2srgb(lin[2])]);
}

/** Preview ramp thicknesses: 0.08 → 0.80mm, one print layer (0.08mm) per step. */
const RAMP_MM = Array.from({ length: 10 }, (_, i) => (i + 1) * 0.08);

interface Props {
  cal: CmykCalibration;
  /** show the preview swatch ramps above the table (default true) */
  showSwatches?: boolean;
  /** show the α / white-point table (default true). false → ramps only. */
  showTable?: boolean;
  /** when provided, the α / white-point cells become editable and every edit
   *  calls back with the next calibration (label dropped — it's now custom). */
  onChange?: (next: CmykCalibration) => void;
}

/** α (absorption per RGB channel) + white-point table, shared by the calibrate
 *  page (editable) and the CMYK module settings (read-only view). */
const CalibrationTable: React.FC<Props> = ({
  cal,
  showSwatches = true,
  showTable = true,
  onChange,
}) => {
  const editable = !!onChange;

  const setAlpha = (f: number, c: number, v: number) => {
    if (!onChange) return;
    const alpha = cal.alpha.map((row) => row.slice());
    alpha[f][c] = v;
    onChange({ ...cal, alpha, label: undefined, calibrated: true, updatedAt: new Date().toISOString() });
  };
  const setWhite = (c: number, v: number) => {
    if (!onChange) return;
    const white = [...cal.white] as [number, number, number];
    white[c] = v;
    onChange({ ...cal, white, label: undefined, calibrated: true, updatedAt: new Date().toISOString() });
  };

  const cell = (val: number, onSet: (v: number) => void, min: number, max: number, step: number) =>
    editable ? (
      <InputNumber
        size="mini"
        hideControl
        min={min}
        max={max}
        step={step}
        precision={3}
        value={val}
        onChange={(v: number) => onSet(v ?? 0)}
        style={{ width: '100%', minWidth: 64 }}
      />
    ) : (
      val.toFixed(3)
    );

  return (
    <div className="cmykcal-params">
      {showSwatches ? (
        <>
          <div className="cmykcal-swatches">
            <div className="cmykcal-sw">
              <span className="cmykcal-sw-label">白参考</span>
              <i
                className="cmykcal-sw-chip"
                style={{
                  background: toHex([
                    255 * lin2srgb(cal.white[0]),
                    255 * lin2srgb(cal.white[1]),
                    255 * lin2srgb(cal.white[2]),
                  ]),
                }}
              />
            </div>
            {CAL_FILAMENTS.map((id, f) => (
              <div key={id} className="cmykcal-sw">
                <span className="cmykcal-sw-label">{id}</span>
                <span className="cmykcal-ramp-strip">
                  {RAMP_MM.map((t, i) => (
                    <i
                      key={i}
                      style={{ background: swatchAt(cal, f, t) }}
                      title={`${id} ${t.toFixed(2)}mm`}
                    />
                  ))}
                </span>
              </div>
            ))}
          </div>
          <div className="cmykcal-ramp-cap">单色厚度渐变：左 0.08mm → 右 0.80mm（每格一层 0.08mm）</div>
        </>
      ) : null}

      {showTable ? (
      <table className="cmykcal-table">
        <thead>
          <tr>
            <th>耗材</th>
            <th>αR</th>
            <th>αG</th>
            <th>αB</th>
          </tr>
        </thead>
        <tbody>
          {CAL_FILAMENTS.map((id, f) => (
            <tr key={id}>
              <td>{id}</td>
              {[0, 1, 2].map((c) => (
                <td key={c}>{cell(cal.alpha[f][c], (v) => setAlpha(f, c, v), 0, 50, 0.1)}</td>
              ))}
            </tr>
          ))}
          <tr>
            <td title="背光参考亮度 I₀（线性光）">白点 I₀</td>
            {[0, 1, 2].map((c) => (
              <td key={c}>{cell(cal.white[c], (v) => setWhite(c, v), 0.05, 1, 0.01)}</td>
            ))}
          </tr>
        </tbody>
      </table>
      ) : null}
    </div>
  );
};

export default CalibrationTable;
