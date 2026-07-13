import React, { useRef } from 'react';
import './ImageEditor.css';

interface Props {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  /** called on release (pointer-up / key) so the heavy downstream runs once */
  onCommit: () => void;
  /** CSS background-image for the rail — a gradient that PREVIEWS the effect
   *  (e.g. a rainbow for hue, grey→colour for saturation, dark→light for value) */
  track: string;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Lightweight gradient slider: a rounded rail painted with a "preview" gradient
 * and a round thumb. Pointer-drag (with capture) updates live and commits on
 * release; arrow keys nudge by one step. Used by the colour editor so each
 * control shows, in its track, what it does.
 */
const GradientSlider: React.FC<Props> = ({ value, min, max, step = 0.01, onChange, onCommit, track }) => {
  const railRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const snap = (v: number) => {
    const s = Math.round(v / step) * step;
    return parseFloat(clamp(s, min, max).toFixed(4));
  };
  const fromX = (clientX: number) => {
    const r = railRef.current!.getBoundingClientRect();
    return snap(min + clamp((clientX - r.left) / r.width, 0, 1) * (max - min));
  };

  const onDown = (e: React.PointerEvent) => {
    dragging.current = true;
    try {
      railRef.current!.setPointerCapture?.(e.pointerId);
    } catch {
      /* synthetic / unsupported pointer id — capture is best-effort */
    }
    onChange(fromX(e.clientX));
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragging.current) onChange(fromX(e.clientX));
  };
  const onUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    onCommit();
  };
  const onKey = (e: React.KeyboardEvent) => {
    let nv = value;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') nv = snap(value - step);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') nv = snap(value + step);
    else return;
    e.preventDefault();
    onChange(nv);
    onCommit();
  };

  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="gs">
      <div
        className="gs-rail"
        ref={railRef}
        style={{ backgroundImage: track }}
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
      >
        <div className="gs-thumb" style={{ left: `${pct}%` }} />
      </div>
    </div>
  );
};

export default GradientSlider;
