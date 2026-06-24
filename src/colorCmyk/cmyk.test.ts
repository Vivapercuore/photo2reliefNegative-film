import { quantizeCmyk, cmykStats, CmykField } from './cmyk';
import { CALIBRATION_PRESETS, saturationLayers } from './calibration';
import { RGBAImage } from '../colorPositive/dither';

const LAYER_MM = 0.08;
const BASE = 2;
const cal = CALIBRATION_PRESETS[0].cal;

/** A solid w×h RGBA image of one colour (alpha 255). */
function solidImage(w: number, h: number, rgb: [number, number, number]): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

/** tallest stacked column in layers (channels only, no base). */
function maxStack(f: CmykField): number {
  const [c0, c1, c2, c3] = f.channels;
  let m = 0;
  for (let i = 0; i < c0.length; i++) {
    const s = c0[i] + c1[i] + c2[i] + c3[i];
    if (s > m) m = s;
  }
  return m;
}

describe('quantizeCmyk — calibration-derived caps + per-pixel box-constrained solve', () => {
  const opts = { cal, layerMm: LAYER_MM, baseLayers: 2, topLayers: 0 };

  it('ceilings are the calibration-derived saturation layers (image-independent)', () => {
    const f = quantizeCmyk(solidImage(4, 4, [128, 128, 128]), 4, 4, 0.6, opts);
    expect(f.caps).toEqual(saturationLayers(cal, LAYER_MM));
  });

  it('every channel stays within its ceiling, even for a pure-black image', () => {
    const f = quantizeCmyk(solidImage(4, 4, [0, 0, 0]), 4, 4, 0.6, opts);
    for (let ch = 0; ch < 4; ch++) {
      for (let i = 0; i < f.channels[ch].length; i++) {
        expect(f.channels[ch][i]).toBeLessThanOrEqual(f.caps[ch]);
      }
    }
  });

  it('no global rescaling: a colour next to black keeps the same layers as without black', () => {
    // A saturated colour solved on its own must not change when a black pixel is
    // present elsewhere — that was the old global-compression wash-out bug.
    const cyan: [number, number, number] = [0, 174, 239];
    const alone = quantizeCmyk(solidImage(1, 1, cyan), 1, 1, 0.6, opts);
    const beside = quantizeCmyk(
      // left pixel cyan, right pixel black
      (() => {
        const data = new Uint8ClampedArray(2 * 4);
        data.set([0, 174, 239, 255], 0);
        data.set([0, 0, 0, 255], 4);
        return { width: 2, height: 1, data } as RGBAImage;
      })(),
      2,
      1,
      0.6,
      opts
    );
    for (let ch = 0; ch < 4; ch++) {
      expect(beside.channels[ch][0]).toBe(alone.channels[ch][0]);
    }
  });

  it('a near-white image needs almost no ink (brightest pixels ≈ floor only)', () => {
    const f = quantizeCmyk(solidImage(4, 4, [248, 248, 248]), 4, 4, 0.6, opts);
    const total = [0, 1, 2, 3].reduce((s, ch) => s + f.channels[ch][0], 0);
    expect(total).toBeLessThanOrEqual(2);
  });

  it('targetTotalMm scales the total thickness toward the requested value', () => {
    const img = solidImage(4, 4, [0, 0, 0]); // black → tall natural stack
    const natural = quantizeCmyk(img, 4, 4, 0.6, opts);
    const naturalTotalMm = (BASE + maxStack(natural)) * LAYER_MM;

    const thin = quantizeCmyk(img, 4, 4, 0.6, { ...opts, targetTotalMm: 1.0 });
    const thinTotalMm = (BASE + maxStack(thin)) * LAYER_MM;

    expect(thinTotalMm).toBeLessThan(naturalTotalMm);
    // targetTotalMm is approximate under the colour-matching quantizer: the
    // tallest column tracks the target but can sit a layer or two above it,
    // because Pass 2 picks the nearest printable COLOUR (a neutral black is
    // densest when its C/M/Y are balanced) rather than the exact scaled thickness.
    expect(thinTotalMm).toBeLessThanOrEqual(1.0 + 3 * LAYER_MM);
    expect(thinTotalMm).toBeGreaterThan(0);
  });

  it('reports per-channel peak thickness in stats.maxLayers, within caps', () => {
    const f = quantizeCmyk(solidImage(4, 4, [0, 0, 0]), 4, 4, 0.6, opts);
    const s = cmykStats(f);
    expect(s.maxLayers).toHaveLength(4);
    // a black target must use plenty of ink somewhere (mostly the C/M/Y mix now)
    expect(Math.max(...s.maxLayers)).toBeGreaterThan(0);
    expect(s.maxLayers[0] + s.maxLayers[1] + s.maxLayers[2]).toBeGreaterThan(0);
    s.maxLayers.forEach((v, ch) => expect(v).toBeLessThanOrEqual(f.caps[ch]));
  });

  it('reproduces a black target as a near-neutral C+M+Y mix (not single-colour)', () => {
    const f = quantizeCmyk(solidImage(4, 4, [0, 0, 0]), 4, 4, 0.6, opts);
    const s = cmykStats(f);
    const [c, m, y] = s.maxLayers;
    // all three chroma inks should be engaged (a single ink can't block to black)
    expect(c).toBeGreaterThan(0);
    expect(m).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
  });

  it('lays a uniform topLayers white cap on every cell, regardless of colour', () => {
    // The top white is a uniform cap so the viewing surface is always white. Every
    // cell, whatever its colour, carries exactly topLayers in channel W.
    const o = { cal, layerMm: LAYER_MM, baseLayers: 2, topLayers: 6 };
    const colors: [number, number, number][] = [
      [0, 0, 0],
      [255, 255, 0],
      [0, 174, 239],
      [255, 255, 255],
    ];
    for (const rgb of colors) {
      const f = quantizeCmyk(solidImage(2, 2, rgb), 2, 2, 0.6, o);
      for (let i = 0; i < f.channels[3].length; i++) expect(f.channels[3][i]).toBe(6);
    }
  });
});
