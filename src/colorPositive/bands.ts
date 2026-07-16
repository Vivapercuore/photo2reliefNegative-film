import type { PauseLayer, Pack3mfOptions } from 'bambu-3mf';

/** 一个色带：label = 量化标签（稳定 id），layers = 本带打印层数。数组约定底→顶。 */
export interface Band {
  label: number;
  color: string;
  layers: number;
}

/** 打印全局参数（层号 ↔ z 换算用）。 */
export interface PrintParams {
  layerHeight: number;
  firstLayerHeight: number;
  /** 底板层数：并入最底部色带（同色连续） */
  baseLayers: number;
}

export type ChangeMode = 'ams' | 'pause';

export const DEFAULT_BAND_LAYERS = 3;
export const DEFAULT_BASE_LAYERS = 3;
export const FIRST_LAYER_HEIGHT = 0.2;
export const LAYER_HEIGHT_OPTIONS = [0.08, 0.12, 0.16, 0.2] as const;
export const DEFAULT_LAYER_HEIGHT = 0.2;
export const MIN_COLORS = 2;
export const MAX_COLORS = 8;

const round2 = (v: number) => Math.round(v * 100) / 100;

/** 打印完第 layerCount 层后的顶面 z（mm）；第 1 层 = 首层层高。 */
export function layerTopZ(layerCount: number, p: PrintParams): number {
  if (layerCount <= 0) return 0;
  return round2(p.firstLayerHeight + (layerCount - 1) * p.layerHeight);
}

export interface BandZ {
  zBottom: number;
  zTop: number;
  /** 本带首层 / 末层（1-based，含底板层） */
  startLayer: number;
  endLayer: number;
}

/** 各色带（底→顶）的高度区间与层号区间；底板层并入第一带。 */
export function bandZTable(bands: Band[], p: PrintParams): BandZ[] {
  const out: BandZ[] = [];
  let cum = p.baseLayers;
  let prevTop = 0;
  let prevCum = 0;
  for (const b of bands) {
    cum += b.layers;
    const zTop = layerTopZ(cum, p);
    out.push({ zBottom: prevTop, zTop, startLayer: prevCum + 1, endLayer: cum });
    prevTop = zTop;
    prevCum = cum;
  }
  return out;
}

/** label → 顶面高度 z（mm）。几何级用它把标签图变成深度图。 */
export function heightsByLabel(bands: Band[], p: PrintParams): number[] {
  const zs = bandZTable(bands, p);
  const out: number[] = [];
  bands.forEach((b, i) => {
    out[b.label] = zs[i].zTop;
  });
  return out;
}

/**
 * n−1 条换色记录。bambu-3mf 的 PauseLayer.atZ 语义：G-code 插在「顶面到达
 * atZ 的那一层」开始打印之前 —— 要在色带 i−1 完成后、色带 i 首层之前换色，
 * atZ = 色带 i 首层的顶面 z。
 */
export function buildPauses(bands: Band[], p: PrintParams, mode: ChangeMode): PauseLayer[] {
  const out: PauseLayer[] = [];
  if (!bands.length) return out;
  let cum = p.baseLayers + bands[0].layers;
  for (let i = 1; i < bands.length; i++) {
    const atZ = layerTopZ(cum + 1, p);
    out.push(
      mode === 'ams'
        ? { atZ, type: 2, extruder: i + 1, color: bands[i].color }
        : { atZ, type: 1, gcode: 'M400 U1', color: bands[i].color }
    );
    cum += bands[i].layers;
  }
  return out;
}

/** 组装 pack3mf 导出选项（不含缩略图——缩略图在页面侧异步生成后并入）。 */
export function buildExportOptions(bands: Band[], p: PrintParams, mode: ChangeMode): Pack3mfOptions {
  return {
    filaments: bands.map((b) => b.color),
    pauses: buildPauses(bands, p, mode),
    projectSettingsOverrides: {
      layer_height: String(p.layerHeight),
      initial_layer_print_height: String(p.firstLayerHeight),
    },
    markModified: ['layer_height', 'initial_layer_print_height'],
    metadataOverrides: {
      ProfileTitle: '多色正片（分层换色）',
    },
  };
}
