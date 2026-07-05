import React, { useEffect, useState } from 'react';
// @ts-ignore arco 类型偶尔解析不到
import { Button } from '@arco-design/web-react';
import { ColorAdjust, PrimaryAdjust, defaultColorAdjust, isIdentityColor } from './imageEdit';
import GradientSlider from './GradientSlider';
import './ImageEditor.css';

interface PrimaryInfo {
  id: string;
  label: string;
  rgb: [number, number, number];
}

interface Props {
  value: ColorAdjust;
  onChange: (c: ColorAdjust) => void;
  /** the print primaries to expose per-band sat/brightness for (e.g. C/M/Y or R/G/B) */
  primaries: PrimaryInfo[];
}

/** A labelled gradient slider; the track previews what the control does. Edits
 *  commit on release so the heavy downstream re-render runs once per drag. */
const Row: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  track: string;
  onChange: (v: number) => void;
  onCommit: () => void;
  fmt?: (v: number) => string;
}> = ({ label, value, min, max, step, track, onChange, onCommit, fmt }) => (
  <div className="ce-row">
    <span className="ce-label">{label}</span>
    <GradientSlider
      value={value}
      min={min}
      max={max}
      step={step}
      track={track}
      onChange={onChange}
      onCommit={onCommit}
    />
    <span className="ce-val lx-data">{(fmt || ((v) => v.toFixed(2)))(value)}</span>
  </div>
);

const HUE_TRACK = 'linear-gradient(90deg,#ff0000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff,#ff0000)';
const EXPOSURE_TRACK = 'linear-gradient(90deg,#1f1f1f,#fdfdfd)';
const CONTRAST_TRACK = 'linear-gradient(90deg,#8c8c8c,#3a3a3a 50%,#ededed)';
const rgbStr = (rgb: [number, number, number]) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

/**
 * Colour adjustment panel: global exposure / contrast / hue, then per-print-
 * primary (C/M/Y for CMYK, R/G/B for positive) saturation + brightness. Each
 * slider's track is a gradient that previews the effect. Edits are kept in a
 * local draft for smooth dragging and pushed to the parent on release.
 */
const ColorEditor: React.FC<Props> = ({ value, onChange, primaries }) => {
  const [draft, setDraft] = useState<ColorAdjust>(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => onChange(draft);
  const setGlobal = (k: 'exposure' | 'contrast' | 'hue', v: number) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const setPrim = (id: string, k: keyof PrimaryAdjust, v: number) =>
    setDraft((d) => ({ ...d, primaries: { ...d.primaries, [id]: { ...d.primaries[id], [k]: v } } }));

  const reset = () => {
    const def = defaultColorAdjust(primaries.map((p) => p.id));
    setDraft(def);
    onChange(def);
  };

  return (
    <div className="color-editor">
      <div className="ce-section">
        <Row label="曝光" value={draft.exposure} min={-1} max={1} step={0.02} track={EXPOSURE_TRACK} onChange={(v) => setGlobal('exposure', v)} onCommit={commit} />
        <Row label="对比度" value={draft.contrast} min={-1} max={1} step={0.02} track={CONTRAST_TRACK} onChange={(v) => setGlobal('contrast', v)} onCommit={commit} />
        <Row label="色调" value={draft.hue} min={-180} max={180} step={1} track={HUE_TRACK} onChange={(v) => setGlobal('hue', v)} onCommit={commit} fmt={(v) => `${v | 0}°`} />
      </div>

      <div className="ce-divider" />

      {primaries.map((p) => {
        const c = rgbStr(p.rgb);
        return (
          <div className="ce-section ce-prim" key={p.id}>
            <div className="ce-prim-head lx-eyebrow">
              <i className="ce-swatch" style={{ background: c }} />
              <span>{p.label}</span>
            </div>
            <Row
              label="饱和度"
              value={draft.primaries[p.id]?.sat ?? 0}
              min={-1}
              max={1}
              step={0.02}
              track={`linear-gradient(90deg,#8a8a8a,${c})`}
              onChange={(v) => setPrim(p.id, 'sat', v)}
              onCommit={commit}
            />
            <Row
              label="亮度"
              value={draft.primaries[p.id]?.bright ?? 0}
              min={-1}
              max={1}
              step={0.02}
              track={`linear-gradient(90deg,#000,${c},#fff)`}
              onChange={(v) => setPrim(p.id, 'bright', v)}
              onCommit={commit}
            />
          </div>
        );
      })}

      <Button size="mini" disabled={isIdentityColor(draft)} onClick={reset} style={{ marginTop: 8 }}>
        重置色彩
      </Button>
    </div>
  );
};

export default ColorEditor;
