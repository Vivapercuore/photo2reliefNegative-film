import {
  HslDelta,
  ZERO_DELTAS,
  rgbToHsl,
  hslToRgb,
  refThickness,
  filamentSwatch,
  applyHslDeltas,
} from './artworkCorrection';
import { CALIBRATION_PRESETS, CmykCalibration } from './calibration';

/** Deep clone a calibration so we can assert an input was not mutated. */
function cloneCal(cal: CmykCalibration): CmykCalibration {
  return {
    alpha: cal.alpha.map((r) => r.slice()),
    white: [cal.white[0], cal.white[1], cal.white[2]],
    calibrated: cal.calibrated,
    label: cal.label,
    updatedAt: cal.updatedAt,
  };
}

/** Deltas array with a single filament nudged (others zero). */
function only(f: number, d: HslDelta): HslDelta[] {
  const out: HslDelta[] = [
    { h: 0, s: 0, l: 0 },
    { h: 0, s: 0, l: 0 },
    { h: 0, s: 0, l: 0 },
    { h: 0, s: 0, l: 0 },
  ];
  out[f] = d;
  return out;
}

const preset = CALIBRATION_PRESETS[0].cal;

describe('ZERO_DELTAS', () => {
  it('is length 4 and all zero, and is frozen (no shared mutable state)', () => {
    expect(ZERO_DELTAS).toHaveLength(4);
    ZERO_DELTAS.forEach((d) => expect(d).toEqual({ h: 0, s: 0, l: 0 }));
    expect(Object.isFrozen(ZERO_DELTAS)).toBe(true);
    ZERO_DELTAS.forEach((d) => expect(Object.isFrozen(d)).toBe(true));
  });
});

describe('applyHslDeltas — identity at zero offset', () => {
  it('reproduces α (6 decimals), copies white, clears label, marks calibrated', () => {
    const cal: CmykCalibration = { ...preset, label: '拓竹CMYK3' };
    const out = applyHslDeltas(cal, ZERO_DELTAS);
    out.alpha.forEach((row, f) =>
      row.forEach((v, c) => expect(v).toBeCloseTo(cal.alpha[f][c], 6))
    );
    expect(out.white).toEqual(cal.white);
    expect(out.label).toBeUndefined();
    expect(out.calibrated).toBe(true);
  });
});

describe('applyHslDeltas — lightness maps to absorption', () => {
  it('negative Δl raises all three α of that filament; positive Δl lowers them', () => {
    const f = 0; // cyan
    const darker = applyHslDeltas(preset, only(f, { h: 0, s: 0, l: -15 }));
    const lighter = applyHslDeltas(preset, only(f, { h: 0, s: 0, l: 15 }));
    for (let c = 0; c < 3; c++) {
      expect(darker.alpha[f][c]).toBeGreaterThan(preset.alpha[f][c]);
      expect(lighter.alpha[f][c]).toBeLessThan(preset.alpha[f][c]);
    }
  });
});

describe('applyHslDeltas — saturation to zero neutralises', () => {
  it('Δs = -100 makes that filament α near-neutral (three channels within 5%)', () => {
    const f = 1; // magenta
    const out = applyHslDeltas(preset, only(f, { h: 0, s: -100, l: 0 }));
    const [a0, a1, a2] = out.alpha[f];
    const max = Math.max(a0, a1, a2);
    const min = Math.min(a0, a1, a2);
    expect((max - min) / max).toBeLessThan(0.05);
  });
});

describe('applyHslDeltas — locality', () => {
  it('nudging only f=0 leaves rows f=1..3 unchanged (6 decimals)', () => {
    const out = applyHslDeltas(preset, only(0, { h: 20, s: 10, l: -10 }));
    for (let f = 1; f < 4; f++) {
      out.alpha[f].forEach((v, c) => expect(v).toBeCloseTo(preset.alpha[f][c], 6));
    }
  });
});

describe('applyHslDeltas — input purity', () => {
  it('does not mutate the base calibration alpha or white', () => {
    const cal: CmykCalibration = { ...preset, alpha: preset.alpha.map((r) => r.slice()) };
    const snapshot = cloneCal(cal);
    applyHslDeltas(cal, only(2, { h: -30, s: 25, l: 12 }));
    expect(cal.alpha).toEqual(snapshot.alpha);
    expect(cal.white).toEqual(snapshot.white);
  });
});

describe('rgbToHsl / hslToRgb round-trip', () => {
  it('recovers typical colours (including pure grey) within 1e-6', () => {
    const colors: [number, number, number][] = [
      [0.5, 0.5, 0.5], // pure grey
      [0.2, 0.2, 0.2], // dark grey
      [0.9, 0.1, 0.1], // red
      [0.1, 0.7, 0.3], // green
      [0.15, 0.3, 0.85], // blue
      [0.8, 0.8, 0.1], // yellow
      [0.6, 0.2, 0.7], // purple
    ];
    for (const [r, g, b] of colors) {
      const [h, s, l] = rgbToHsl(r, g, b);
      const [r2, g2, b2] = hslToRgb(h, s, l);
      expect(r2).toBeCloseTo(r, 6);
      expect(g2).toBeCloseTo(g, 6);
      expect(b2).toBeCloseTo(b, 6);
    }
  });
});

describe('applyHslDeltas — degenerate all-zero α row', () => {
  it('does not throw and returns a near-zero row at zero offset', () => {
    const cal: CmykCalibration = {
      alpha: [
        [0, 0, 0], // fully transparent filament
        [1, 0.5, 0.5],
        [0.5, 1, 0.5],
        [0.8, 0.8, 0.8],
      ],
      white: [1, 1, 1],
      calibrated: true,
    };
    let out: CmykCalibration | undefined;
    expect(() => {
      out = applyHslDeltas(cal, ZERO_DELTAS);
    }).not.toThrow();
    // A fully-transparent filament's swatch is white (l = 1). The spec's l-clamp
    // ceiling (0.995) means it round-trips to ~1e-4 absorption, not exactly 0 —
    // still "near 0" (well under one part in a thousand of any real α), and never
    // negative or NaN. This is the intended stable-region guard, not a bug.
    out!.alpha[0].forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1e-3);
    });
  });
});

describe('refThickness / filamentSwatch — sanity', () => {
  it('strongest channel transmits ≈ REF_T at refThickness', () => {
    for (let f = 0; f < 4; f++) {
      const a = preset.alpha[f];
      const t = refThickness(preset, f);
      const maxAlpha = Math.max(a[0], a[1], a[2]);
      // only exact when t* is inside the [0.05,100] clamp — true for the preset
      expect(Math.exp(-maxAlpha * t)).toBeCloseTo(0.15, 6);
    }
  });

  it('swatch channels are valid sRGB in [0,1]', () => {
    for (let f = 0; f < 4; f++) {
      filamentSwatch(preset, f).forEach((v) => {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      });
    }
  });
});
