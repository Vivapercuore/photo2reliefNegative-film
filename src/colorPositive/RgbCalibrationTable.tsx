import React from 'react';
import {
  InputNumber,
  // @ts-ignore arco 类型偶尔解析不到
} from '@arco-design/web-react';
import {
  RgbCalibration,
  CAL_PRIMARIES,
  PRIMARY_LABEL,
  primaryLin,
  primaryRawLin,
  srgb2lin,
  lin2srgb,
} from './calibration';
import './RgbCalibrationTable.css';

const toHex = (rgb: [number, number, number]) =>
  '#' +
  rgb
    .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0').toUpperCase())
    .join('');

const linToSrgb255 = (lin: number[]): [number, number, number] => [
  255 * lin2srgb(lin[0]),
  255 * lin2srgb(lin[1]),
  255 * lin2srgb(lin[2]),
];

/** Final colour actually used (raw + saturation restoration) — for the swatches. */
function primarySrgb(cal: RgbCalibration, id: string): [number, number, number] {
  return linToSrgb255(primaryLin(cal, id));
}

/** RAW measured colour (no saturation restoration) — for the editable table. */
function primaryRawSrgb(cal: RgbCalibration, id: string): [number, number, number] {
  return linToSrgb255(primaryRawLin(cal, id));
}

interface Props {
  cal: RgbCalibration;
  /** show the measured-colour swatches above the table (default true) */
  showSwatches?: boolean;
  /** show the editable RGB table (default true). false → swatches only. */
  showTable?: boolean;
  /** when provided, the table cells become editable and every edit calls back
   *  with the next calibration (label dropped — it's now custom). */
  onChange?: (next: RgbCalibration) => void;
}

/** Measured-primary table for the RGB color-positive module: each primary's real
 *  printed colour (sRGB 0..255). Shared by the calibrate page (editable) and the
 *  module settings (read-only). Reuses the .cmykcal-* calibration styling. */
const RgbCalibrationTable: React.FC<Props> = ({
  cal,
  showSwatches = true,
  showTable = true,
  onChange,
}) => {
  const editable = !!onChange;

  const setChannel = (id: string, c: number, v: number) => {
    if (!onChange) return;
    // edit the RAW measured primaries (saturation restoration is applied on top)
    const primaries: Record<string, [number, number, number]> = {};
    for (const k of CAL_PRIMARIES) primaries[k] = [...primaryRawLin(cal, k)] as [number, number, number];
    primaries[id][c] = srgb2lin(Math.max(0, Math.min(255, v)) / 255);
    onChange({
      ...cal,
      primaries,
      label: undefined,
      calibrated: true,
      updatedAt: new Date().toISOString(),
    });
  };

  const cell = (id: string, c: number) => {
    const v = Math.round(primaryRawSrgb(cal, id)[c]);
    return editable ? (
      <InputNumber
        size="mini"
        hideControl
        min={0}
        max={255}
        step={1}
        precision={0}
        value={v}
        onChange={(nv: number) => setChannel(id, c, nv ?? 0)}
        style={{ width: '100%', minWidth: 56 }}
        className="lx-data"
      />
    ) : (
      <span className="lx-data">{v}</span>
    );
  };

  return (
    <div className="cmykcal-params">
      {showSwatches ? (
        <>
          <div className="rgbcal-sw-row">
            <div className="rgbcal-sw-item">
              <i
                className="rgbcal-sw-chip"
                style={{
                  background: toHex([
                    255 * lin2srgb(cal.white[0]),
                    255 * lin2srgb(cal.white[1]),
                    255 * lin2srgb(cal.white[2]),
                  ]),
                }}
              />
              <span className="rgbcal-sw-name">白参考</span>
            </div>
            {CAL_PRIMARIES.map((id) => (
              <div key={id} className="rgbcal-sw-item">
                <i className="rgbcal-sw-chip" style={{ background: toHex(primarySrgb(cal, id)) }} />
                <span className="rgbcal-sw-name">
                  {PRIMARY_LABEL[id]} {id}
                </span>
              </div>
            ))}
          </div>
          <div className="rgbcal-sw-cap">
            各原色作画所用的实际显色（实测偏色 + 饱和度还原{' '}
            <span className="lx-data">{(cal.chromaGain ?? 1).toFixed(1)}×</span>）
          </div>
        </>
      ) : null}

      {showTable ? (
        <table className="cmykcal-table">
          <thead>
            <tr>
              <th>原色</th>
              <th>R</th>
              <th>G</th>
              <th>B</th>
            </tr>
          </thead>
          <tbody>
            {CAL_PRIMARIES.map((id) => (
              <tr key={id}>
                <td>
                  {PRIMARY_LABEL[id]}（{id}）
                </td>
                {[0, 1, 2].map((c) => (
                  <td key={c}>{cell(id, c)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
};

export default RgbCalibrationTable;
