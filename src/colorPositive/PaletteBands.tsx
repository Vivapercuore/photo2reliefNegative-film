import React, { useRef, useState } from 'react';
// @ts-ignore arco 类型偶尔解析不到
import { InputNumber } from '@arco-design/web-react';
import { Band, BandZ } from './bands';
import './PaletteBands.css';

interface Props {
  /** 色带（底→顶）；渲染时反转为顶→底，与模型上下方向一致 */
  bands: Band[];
  /** 与 bands 对齐的高度/层号区间 */
  zTable: BandZ[];
  /** 每个 label 的像素数（来自量化），未量化时为 null */
  counts: number[] | null;
  onColorChange: (label: number, color: string) => void;
  onLayersChange: (label: number, layers: number) => void;
  /** 把 bands[from] 移到 bands[to]（数组下标，底→顶方向） */
  onReorder: (from: number, to: number) => void;
}

/**
 * 高度-颜色图例编辑器：每行一个色带，从上到下 = 模型从顶到底。
 * 行内改颜色（原生取色器）与层数；拖拽整行重排顺序。
 */
const PaletteBands: React.FC<Props> = ({
  bands,
  zTable,
  counts,
  onColorChange,
  onLayersChange,
  onReorder,
}) => {
  const [dragFrom, setDragFrom] = useState<number | null>(null); // bands 数组下标
  const [dragOver, setDragOver] = useState<number | null>(null);
  const colorInputs = useRef<Record<number, HTMLInputElement | null>>({});

  const total = counts ? counts.reduce((s, c) => s + c, 0) : 0;
  // 顶→底渲染：显示第 d 行 ↔ bands 下标 bands.length - 1 - d
  const order = bands.map((_, d) => bands.length - 1 - d);

  return (
    <div className="cp-bands">
      {order.map((i) => {
        const band = bands[i];
        const z = zTable[i];
        const pct = counts && total ? ((counts[band.label] || 0) / total) * 100 : null;
        return (
          <div
            key={band.label}
            className={
              'cp-band' +
              (dragOver === i && dragFrom !== null && dragFrom !== i ? ' cp-band-over' : '') +
              (dragFrom === i ? ' cp-band-dragging' : '')
            }
            draggable
            onDragStart={(e) => {
              setDragFrom(i);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(i);
            }}
            onDragLeave={() => setDragOver((o) => (o === i ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              if (dragFrom !== null && dragFrom !== i) onReorder(dragFrom, i);
              setDragFrom(null);
              setDragOver(null);
            }}
            onDragEnd={() => {
              setDragFrom(null);
              setDragOver(null);
            }}
          >
            <span className="cp-band-grip" aria-hidden="true">
              ⋮⋮
            </span>
            <button
              type="button"
              className="cp-band-swatch"
              style={{ background: band.color }}
              title="点击修改颜色"
              onClick={() => colorInputs.current[band.label]?.click()}
            />
            <input
              ref={(el) => {
                colorInputs.current[band.label] = el;
              }}
              className="cp-band-color-input"
              type="color"
              value={band.color}
              onChange={(e) => onColorChange(band.label, e.target.value.toUpperCase())}
            />
            <span className="cp-band-hex lx-data">{band.color}</span>
            <span className="cp-band-pct lx-data">{pct === null ? '—' : `${pct.toFixed(1)}%`}</span>
            <InputNumber
              className="cp-band-layers lx-data"
              style={{ width: 92 }}
              size="mini"
              mode="button"
              min={1}
              max={50}
              step={1}
              precision={0}
              value={band.layers}
              onChange={(v: number) => onLayersChange(band.label, v)}
            />
            <span className="cp-band-z lx-data">
              {z ? `${z.zBottom.toFixed(2)}–${z.zTop.toFixed(2)}` : '—'}
              <span className="cp-band-z-unit">mm</span>
            </span>
          </div>
        );
      })}
      <div className="cp-bands-hint">
        上 = 模型顶部 · 拖拽整行调整顺序 · 「层数」是该色厚度（最底色带的区间已含底板层）
      </div>
    </div>
  );
};

export default PaletteBands;
