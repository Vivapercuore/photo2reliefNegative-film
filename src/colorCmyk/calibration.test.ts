import { CALIBRATION_PRESETS, saturationLayers, CmykCalibration } from './calibration';

const LAYER_MM = 0.08;

describe('saturationLayers', () => {
  it('derives per-filament ceilings from the preset α (white earns the most)', () => {
    // C/M/Y/W full-ink layers reverse-engineered from the measured absorption.
    // White is the weakest absorber → it earns the most layers (the luminance
    // ladder); the strong colour inks saturate in far fewer. Asserted as
    // PROPERTIES (not pinned numbers) so a re-measured preset doesn't break it.
    const cal = CALIBRATION_PRESETS[0].cal;
    const lv = saturationLayers(cal, LAYER_MM);
    expect(lv).toHaveLength(4);
    lv.forEach((v) => expect(v).toBeGreaterThanOrEqual(1));
    expect(lv[3]).toBe(Math.max(...lv)); // white (weakest) → most layers
    expect(lv[0]).toBeLessThan(lv[3]);
    expect(lv[1]).toBeLessThan(lv[3]);
    expect(lv[2]).toBeLessThan(lv[3]);
  });

  it('stronger absorption ⇒ fewer layers to saturate', () => {
    const weak: CmykCalibration = {
      alpha: [
        [1, 0.5, 0.5],
        [0.5, 1, 0.5],
        [0.5, 0.5, 1],
        [0.8, 0.8, 0.8],
      ],
      white: [1, 1, 1],
      calibrated: true,
    };
    const strong: CmykCalibration = {
      ...weak,
      alpha: weak.alpha.map((a) => a.map((v) => v * 2)),
    };
    const lw = saturationLayers(weak, LAYER_MM);
    const ls = saturationLayers(strong, LAYER_MM);
    ls.forEach((v, i) => expect(v).toBeLessThan(lw[i]));
  });

  it('clamps to at least one layer for very strong absorbers', () => {
    const huge: CmykCalibration = {
      alpha: [
        [500, 1, 1],
        [500, 1, 1],
        [500, 1, 1],
        [500, 1, 1],
      ],
      white: [1, 1, 1],
      calibrated: true,
    };
    saturationLayers(huge, LAYER_MM).forEach((v) => expect(v).toBe(1));
  });
});
