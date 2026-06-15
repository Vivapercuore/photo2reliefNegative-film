import React from 'react';
import {
  Button,
  Popconfirm,
  // @ts-ignore arco 类型偶尔解析不到
} from '@arco-design/web-react';
import { RgbCalibration, CALIBRATION_PRESETS, SavedCalibration } from './calibration';

interface Props {
  /** label of the currently-applied calibration (highlights the matching button) */
  activeLabel?: string;
  /** user-saved calibrations to list after the built-in presets */
  saved: SavedCalibration[];
  /** apply a calibration as the active one */
  onApply: (cal: RgbCalibration) => void;
  /** when provided, saved items get a delete affordance */
  onDelete?: (id: string) => void;
}

/** One tappable calibration button — filled so it reads as clickable, with a
 *  ✓使用中 marker when it's the active one. */
const PickBtn: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({
  label,
  active,
  onClick,
}) => (
  <Button size="small" type={active ? 'primary' : 'secondary'} onClick={onClick}>
    {active ? `✓ ${label}` : label}
  </Button>
);

/** Built-in presets + user-saved calibrations as one-click "套用" buttons.
 *  Shared by the RGB calibrate page and the color-positive module settings.
 *  (Reuses the .cmykcal-* calibration styling namespace.) */
const RgbCalibrationPicker: React.FC<Props> = ({ activeLabel, saved, onApply, onDelete }) => (
  <>
    {CALIBRATION_PRESETS.length ? (
      <div className="cmykcal-presets">
        <span className="cmykcal-presets-label">预设耗材（点这套用）：</span>
        {CALIBRATION_PRESETS.map((p) => (
          <PickBtn
            key={p.id}
            label={p.label}
            active={activeLabel === p.label}
            onClick={() => onApply(p.cal)}
          />
        ))}
      </div>
    ) : null}
    {saved.length ? (
      <div className="cmykcal-presets">
        <span className="cmykcal-presets-label">我保存的（点这套用）：</span>
        {saved.map((s) => (
          <span key={s.id} className="cmykcal-saved-item">
            <PickBtn label={s.label} active={activeLabel === s.label} onClick={() => onApply(s.cal)} />
            {onDelete ? (
              <Popconfirm
                title={`删除本地校准「${s.label}」？`}
                onOk={() => onDelete(s.id)}
                okText="删除"
                cancelText="取消"
              >
                <Button size="small" type="text" status="danger" className="cmykcal-saved-del">
                  ×
                </Button>
              </Popconfirm>
            ) : null}
          </span>
        ))}
      </div>
    ) : null}
  </>
);

export default RgbCalibrationPicker;
