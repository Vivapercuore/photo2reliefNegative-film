import {
  applyColorAdjust,
  defaultColorAdjust,
  isIdentityColor,
  isIdentityCrop,
  rgb2hsl,
  hsl2rgb,
  NO_CROP,
  ColorAdjust,
} from './imageEdit';

const CMY = ['C', 'M', 'Y'];

/** one-pixel RGBA buffer */
function px(r: number, g: number, b: number): Uint8ClampedArray {
  return new Uint8ClampedArray([r, g, b, 255]);
}

describe('imageEdit colour core', () => {
  it('identity adjust leaves pixels untouched', () => {
    const d = px(123, 45, 200);
    applyColorAdjust(d, defaultColorAdjust(CMY), CMY);
    expect([d[0], d[1], d[2]]).toEqual([123, 45, 200]);
  });

  it('NO_CROP and default colour are detected as identity', () => {
    expect(isIdentityCrop(NO_CROP)).toBe(true);
    expect(isIdentityColor(defaultColorAdjust(CMY))).toBe(true);
  });

  it('positive exposure brightens, negative darkens (monotonic)', () => {
    const base = px(100, 100, 100);
    const up = px(100, 100, 100);
    const down = px(100, 100, 100);
    applyColorAdjust(up, { ...defaultColorAdjust(CMY), exposure: 0.5 }, CMY);
    applyColorAdjust(down, { ...defaultColorAdjust(CMY), exposure: -0.5 }, CMY);
    expect(up[0]).toBeGreaterThan(base[0]);
    expect(down[0]).toBeLessThan(base[0]);
  });

  it('contrast pushes a mid-bright pixel away from grey', () => {
    const light = px(180, 180, 180);
    const dark = px(70, 70, 70);
    applyColorAdjust(light, { ...defaultColorAdjust(CMY), contrast: 0.5 }, CMY);
    applyColorAdjust(dark, { ...defaultColorAdjust(CMY), contrast: 0.5 }, CMY);
    expect(light[0]).toBeGreaterThan(180);
    expect(dark[0]).toBeLessThan(70);
  });

  it('cyan saturation band desaturates a cyan pixel but leaves a magenta pixel alone', () => {
    const cyan = px(0, 200, 220); // hue ~ 186°, in the C band
    const magenta = px(220, 0, 180); // hue ~ 311°, in the M band
    const adj: ColorAdjust = {
      ...defaultColorAdjust(CMY),
      primaries: { C: { sat: -1, bright: 0 }, M: { sat: 0, bright: 0 }, Y: { sat: 0, bright: 0 } },
    };
    const c0 = rgb2hsl(0, 200 / 255, 220 / 255)[1];
    const m0 = rgb2hsl(220 / 255, 0, 180 / 255)[1];
    applyColorAdjust(cyan, adj, CMY);
    applyColorAdjust(magenta, adj, CMY);
    const c1 = rgb2hsl(cyan[0] / 255, cyan[1] / 255, cyan[2] / 255)[1];
    const m1 = rgb2hsl(magenta[0] / 255, magenta[1] / 255, magenta[2] / 255)[1];
    expect(c1).toBeLessThan(c0 - 0.2); // cyan strongly desaturated
    expect(Math.abs(m1 - m0)).toBeLessThan(0.05); // magenta nearly unchanged
  });

  it('hsl round-trips a few colours', () => {
    for (const [r, g, b] of [
      [0.2, 0.5, 0.9],
      [0.9, 0.1, 0.4],
      [0.5, 0.5, 0.5],
    ]) {
      const [h, s, l] = rgb2hsl(r, g, b);
      const [r2, g2, b2] = hsl2rgb(h, s, l);
      expect(r2).toBeCloseTo(r, 5);
      expect(g2).toBeCloseTo(g, 5);
      expect(b2).toBeCloseTo(b, 5);
    }
  });
});
