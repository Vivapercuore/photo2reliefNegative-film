import {
  layerTopZ,
  bandZTable,
  heightsByLabel,
  buildPauses,
  buildExportOptions,
  Band,
  PrintParams,
} from './bands';

const P: PrintParams = { layerHeight: 0.2, firstLayerHeight: 0.2, baseLayers: 3 };
const BANDS: Band[] = [
  { label: 0, color: '#101010', layers: 3 },
  { label: 1, color: '#3355AA', layers: 3 },
  { label: 2, color: '#CC8833', layers: 3 },
  { label: 3, color: '#F0F0F0', layers: 3 },
];

describe('layerTopZ', () => {
  it('第 1 层顶面 = 首层层高', () => expect(layerTopZ(1, P)).toBe(0.2));
  it('0 层 = 0', () => expect(layerTopZ(0, P)).toBe(0));
  it('首层与层高不同时', () =>
    expect(layerTopZ(4, { layerHeight: 0.12, firstLayerHeight: 0.2, baseLayers: 0 })).toBe(0.56));
});

describe('bandZTable', () => {
  it('底板层并入第一带；区间首尾相接、含层号', () => {
    expect(bandZTable(BANDS, P)).toEqual([
      { zBottom: 0, zTop: 1.2, startLayer: 1, endLayer: 6 },
      { zBottom: 1.2, zTop: 1.8, startLayer: 7, endLayer: 9 },
      { zBottom: 1.8, zTop: 2.4, startLayer: 10, endLayer: 12 },
      { zBottom: 2.4, zTop: 3, startLayer: 13, endLayer: 15 },
    ]);
  });
});

describe('heightsByLabel', () => {
  it('乱序色带也按 label 映射顶面高度', () => {
    const shuffled = [BANDS[2], BANDS[0], BANDS[3], BANDS[1]];
    const h = heightsByLabel(shuffled, P);
    expect(h[2]).toBe(1.2);
    expect(h[0]).toBe(1.8);
    expect(h[3]).toBe(2.4);
    expect(h[1]).toBe(3);
  });
});

describe('buildPauses', () => {
  it('AMS 模式：n-1 条 type:2，atZ = 上一带完成后下一层的顶面', () => {
    expect(buildPauses(BANDS, P, 'ams')).toEqual([
      { atZ: 1.4, type: 2, extruder: 2, color: '#3355AA' },
      { atZ: 2, type: 2, extruder: 3, color: '#CC8833' },
      { atZ: 2.6, type: 2, extruder: 4, color: '#F0F0F0' },
    ]);
  });
  it('暂停模式：type:1 + M400 U1', () => {
    expect(buildPauses(BANDS.slice(0, 2), P, 'pause')).toEqual([
      { atZ: 1.4, type: 1, gcode: 'M400 U1', color: '#3355AA' },
    ]);
  });
  it('单色不产生换色', () => {
    expect(buildPauses(BANDS.slice(0, 1), P, 'ams')).toEqual([]);
  });
});

describe('buildExportOptions', () => {
  it('料表 = 底→顶颜色；层高写入并标记修改', () => {
    const o = buildExportOptions(BANDS, P, 'ams');
    expect(o.filaments).toEqual(['#101010', '#3355AA', '#CC8833', '#F0F0F0']);
    expect(o.pauses).toHaveLength(3);
    expect(o.projectSettingsOverrides).toEqual({
      layer_height: '0.2',
      initial_layer_print_height: '0.2',
    });
    expect(o.markModified).toEqual(['layer_height', 'initial_layer_print_height']);
  });
});
