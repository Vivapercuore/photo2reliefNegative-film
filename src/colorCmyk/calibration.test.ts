import {
  CALIBRATION_PRESETS,
  saturationLayers,
  mergeCalibration,
  CmykCalibration,
  CAL_LAYERS,
  CAL_LAYER_MM,
} from './calibration';

const LAYER_MM = 0.08;

describe('calibration strip contract', () => {
  it('pins the 7-step / 0.08mm-per-layer wedge that the physical calibration strip model uses', () => {
    // These two constants are the contract with the printed calibration strip
    // (a ready-made model the user downloads once per filament): 7 wedge steps,
    // one extra 0.08mm layer each. If either changes, the strip model must be
    // re-authored to match — this test exists to make that break loudly.
    expect(CAL_LAYERS).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(CAL_LAYER_MM).toBe(0.08);
  });
});

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

describe('mergeCalibration (per-filament progressive merge)', () => {
  // distinct α rows so we can tell whose value ended up where by inspection
  const base: CmykCalibration = {
    alpha: [
      [1, 1, 1], // C (base)
      [2, 2, 2], // M (base)
      [3, 3, 3], // Y (base)
      [4, 4, 4], // W (base)
    ],
    white: [0.1, 0.1, 0.1],
    calibrated: false,
    updatedAt: '2020-01-01',
    label: '未校准占位',
  };
  const fit: CmykCalibration = {
    alpha: [
      [10, 10, 10], // C (fit)
      [20, 20, 20], // M (fit)
      [30, 30, 30], // Y (fit)
      [40, 40, 40], // W (fit)
    ],
    white: [0.9, 0.8, 0.7],
    calibrated: true,
    updatedAt: '2026-07-03',
  };

  it('takes fit rows for sampled filaments and base rows for the rest', () => {
    const merged = mergeCalibration(base, fit, [0, 2]); // C, Y re-measured
    expect(merged.alpha[0]).toEqual([10, 10, 10]); // C ← fit
    expect(merged.alpha[1]).toEqual([2, 2, 2]); // M ← base (not sampled)
    expect(merged.alpha[2]).toEqual([30, 30, 30]); // Y ← fit
    expect(merged.alpha[3]).toEqual([4, 4, 4]); // W ← base (not sampled)
  });

  it('clears label, marks calibrated, and takes white from fit', () => {
    const merged = mergeCalibration(base, fit, [1]);
    expect(merged.label).toBeUndefined();
    expect(merged.calibrated).toBe(true);
    expect(merged.white).toEqual([0.9, 0.8, 0.7]); // from fit
    expect(merged.updatedAt).toBe('2026-07-03'); // from fit
  });

  it('does not share array references with either input (inputs stay intact)', () => {
    const merged = mergeCalibration(base, fit, [0]);
    // returned rows are copies — mutating them must not touch base/fit
    merged.alpha[0][0] = 999; // a fit-sourced row
    merged.alpha[1][0] = 888; // a base-sourced row
    (merged.white as number[])[0] = 777;
    expect(fit.alpha[0]).toEqual([10, 10, 10]); // fit input untouched
    expect(base.alpha[1]).toEqual([2, 2, 2]); // base input untouched
    expect(fit.white).toEqual([0.9, 0.8, 0.7]); // fit white untouched
    // and no result row aliases an input row
    expect(merged.alpha[0]).not.toBe(fit.alpha[0]);
    expect(merged.alpha[1]).not.toBe(base.alpha[1]);
  });
});
