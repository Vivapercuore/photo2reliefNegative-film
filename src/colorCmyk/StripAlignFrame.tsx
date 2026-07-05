import React, { useCallback, useEffect, useRef } from 'react';
import {
  Quad,
  Pt,
  bilinear,
  stepCenters,
  whiteRefPairs,
  sampleHalf,
  moveCorner,
  moveEdge,
  translateQuad,
} from './stripSampling';

interface Props {
  /** full-resolution source canvas the strip photo is drawn from */
  source: HTMLCanvasElement;
  /** current alignment quad (source-canvas pixel coords), TL,TR,BR,BL */
  quad: Quad;
  /** called with the next quad on every drag move */
  onQuadChange: (q: Quad) => void;
  /** white-reference offset, in box-height multiples (v = -whiteOff / 1+whiteOff) */
  whiteOff: number;
  /** number of calibration steps (default 7) */
  steps?: number;
  /** max display width in CSS px; the source is drawn at scale = min(1, this/w) */
  maxWidth?: number;
}

/** Drag mode: which part of the quad the current pointer gesture controls. */
type DragMode =
  | { kind: 'corner'; i: number }
  | { kind: 'edge'; i: number }
  | { kind: 'inner' };

interface DragState {
  mode: DragMode;
  /** the pointer that owns this gesture — later pointers are ignored so a second
   *  touch can't hijack the drag and either lift can't kill it mid-gesture */
  pointerId: number;
  /** quad at pointer-down (source coords) — deltas accumulate from here */
  startQuad: Quad;
  /** pointer position at pointer-down, in SOURCE coords */
  startSrc: Pt;
}

const FRAME = '#ffd400'; // strip frame / handles (visible on bright backlight)
const STEP_STROKE = 'rgba(0,255,180,0.9)'; // step sample squares
const WHITE_STROKE = '#fff'; // white-reference squares

/**
 * Draggable alignment frame over one calibration-strip photo. Purely controlled:
 * the parent owns `quad` and updates it from `onQuadChange`. Rendering and hit
 * testing happen in DISPLAY coordinates (= source coords × scale); every drag
 * result is converted back to source coordinates before being lifted up.
 */
const StripAlignFrame: React.FC<Props> = ({
  source,
  quad,
  onQuadChange,
  whiteOff,
  steps = 7,
  maxWidth = 640,
}) => {
  const photoRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const scale = Math.min(1, maxWidth / source.width);
  const dispW = Math.round(source.width * scale);
  const dispH = Math.round(source.height * scale);

  // (re)draw the source photo into the display canvas whenever it changes
  useEffect(() => {
    const cv = photoRef.current;
    if (!cv) return;
    cv.width = dispW;
    cv.height = dispH;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, dispW, dispH);
    ctx.drawImage(source, 0, 0, dispW, dispH);
  }, [source, dispW, dispH]);

  // display-space helpers -----------------------------------------------------
  const d = useCallback((p: Pt): Pt => ({ x: p.x * scale, y: p.y * scale }), [scale]);
  const dispQuad = quad.map(d) as Quad;
  const half = sampleHalf(quad, steps);
  // sample-window side in display px, with a visible floor of 8px
  const boxSide = Math.max(8, 2 * half * scale);

  // pointer → source coords, relative to the overlay's own box. The ratio is
  // derived from the LIVE rect (not the fixed `scale`) because the overlay can
  // render smaller than dispW when the column is narrower (see CSS): the true
  // source-per-CSS-px ratio is source.width / rect.width, which only equals
  // 1/scale when rect.width === dispW.
  const srcFromEvent = useCallback(
    (e: React.PointerEvent): Pt => {
      const rect = e.currentTarget.getBoundingClientRect();
      const rx = rect.width > 0 ? source.width / rect.width : 1 / scale;
      const ry = rect.height > 0 ? source.height / rect.height : 1 / scale;
      return { x: (e.clientX - rect.left) * rx, y: (e.clientY - rect.top) * ry };
    },
    [source.width, source.height, scale]
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      // one gesture at a time: a second finger during a drag is ignored
      if (dragRef.current) return;
      const el = e.target as Element;
      let mode: DragMode | null = null;
      if (el.classList.contains('salign-corner')) {
        mode = { kind: 'corner', i: Number(el.getAttribute('data-idx')) };
      } else if (el.classList.contains('salign-edge')) {
        mode = { kind: 'edge', i: Number(el.getAttribute('data-idx')) };
      } else if (el.classList.contains('salign-inner')) {
        mode = { kind: 'inner' };
      }
      if (!mode) return;
      dragRef.current = { mode, pointerId: e.pointerId, startQuad: quad, startSrc: srcFromEvent(e) };
      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
    },
    [quad, srcFromEvent]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const st = dragRef.current;
      if (!st || e.pointerId !== st.pointerId) return;
      const cur = srcFromEvent(e);
      const dx = cur.x - st.startSrc.x;
      const dy = cur.y - st.startSrc.y;
      const w = source.width;
      const h = source.height;
      let next: Quad;
      if (st.mode.kind === 'corner') {
        // corner follows the pointer's absolute source position
        next = moveCorner(st.startQuad, st.mode.i, cur.x, cur.y, w, h);
      } else if (st.mode.kind === 'edge') {
        next = moveEdge(st.startQuad, st.mode.i, dx, dy, w, h);
      } else {
        next = translateQuad(st.startQuad, dx, dy, w, h);
      }
      onQuadChange(next);
    },
    [onQuadChange, source.width, source.height, srcFromEvent]
  );

  const endDrag = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const st = dragRef.current;
    // ignore lifts from any other pointer so the owning finger keeps the drag
    if (!st || e.pointerId !== st.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  // geometry for the overlay (all display coords) -----------------------------
  const innerPoly = dispQuad.map((p) => `${p.x},${p.y}`).join(' ');
  const centers = stepCenters(quad, steps).map(d);
  const whites = whiteRefPairs(quad, steps, whiteOff).map((pair) => ({
    above: d(pair.above),
    below: d(pair.below),
  }));
  // step split lines: u = j/steps (j=1..steps-1), from top edge to bottom edge
  const splits: { a: Pt; b: Pt }[] = [];
  for (let j = 1; j < steps; j++) {
    splits.push({ a: d(bilinear(quad, j / steps, 0)), b: d(bilinear(quad, j / steps, 1)) });
  }
  // the 4 edges as [from, to] display points
  const edges = [0, 1, 2, 3].map((i) => ({
    a: dispQuad[i],
    b: dispQuad[(i + 1) % 4],
    i,
  }));

  // small centred square path helper (display coords)
  const sq = (c: Pt) => ({ x: c.x - boxSide / 2, y: c.y - boxSide / 2 });

  return (
    <div className="salign" style={{ width: dispW }}>
      <canvas ref={photoRef} className="salign-photo" />
      <svg
        className="salign-overlay"
        width={dispW}
        height={dispH}
        viewBox={`0 0 ${dispW} ${dispH}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {/* inner translate hit region (drawn first → lowest hit priority) */}
        <polygon className="salign-inner" points={innerPoly} fill="transparent" pointerEvents="fill" />

        {/* frame edges: dark halo under a bright yellow line */}
        {edges.map((e) => (
          <line
            key={`fe-${e.i}`}
            x1={e.a.x}
            y1={e.a.y}
            x2={e.b.x}
            y2={e.b.y}
            stroke="rgba(0,0,0,0.5)"
            strokeWidth={4}
          />
        ))}
        {edges.map((e) => (
          <line
            key={`fy-${e.i}`}
            x1={e.a.x}
            y1={e.a.y}
            x2={e.b.x}
            y2={e.b.y}
            stroke={FRAME}
            strokeWidth={2}
          />
        ))}

        {/* step split lines */}
        {splits.map((s, j) => (
          <line
            key={`sp-${j}`}
            x1={s.a.x}
            y1={s.a.y}
            x2={s.b.x}
            y2={s.b.y}
            stroke={FRAME}
            strokeWidth={1}
            strokeDasharray="4 3"
            opacity={0.5}
          />
        ))}

        {/* step sample squares + index labels */}
        {centers.map((c, j) => {
          const p = sq(c);
          return (
            <g key={`st-${j}`}>
              <rect
                x={p.x}
                y={p.y}
                width={boxSide}
                height={boxSide}
                fill="none"
                stroke={STEP_STROKE}
                strokeWidth={1.5}
              />
              <text
                x={c.x}
                y={p.y - 3}
                fill={FRAME}
                fontSize={12}
                textAnchor="middle"
                stroke="rgba(0,0,0,0.85)"
                strokeWidth={2.5}
                paintOrder="stroke"
                style={{ paintOrder: 'stroke' }}
              >
                {j + 1}
              </text>
            </g>
          );
        })}

        {/* white-reference squares (dashed, above + below each column) */}
        {whites.map((pair, j) =>
          (['above', 'below'] as const).map((side) => {
            const c = pair[side];
            const p = sq(c);
            return (
              <g key={`wr-${j}-${side}`}>
                <rect
                  x={p.x}
                  y={p.y}
                  width={boxSide}
                  height={boxSide}
                  fill="none"
                  stroke="rgba(0,0,0,0.6)"
                  strokeWidth={3}
                  strokeDasharray="4 3"
                />
                <rect
                  x={p.x}
                  y={p.y}
                  width={boxSide}
                  height={boxSide}
                  fill="none"
                  stroke={WHITE_STROKE}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
              </g>
            );
          })
        )}

        {/* edge grab handles: fat transparent hit lines */}
        {edges.map((e) => (
          <line
            key={`eh-${e.i}`}
            className="salign-edge"
            data-idx={e.i}
            x1={e.a.x}
            y1={e.a.y}
            x2={e.b.x}
            y2={e.b.y}
            stroke="transparent"
            strokeWidth={14}
            pointerEvents="stroke"
          />
        ))}

        {/* corner handles (drawn last → highest hit priority) */}
        {dispQuad.map((p, i) => (
          <circle
            key={`ch-${i}`}
            className="salign-corner"
            data-idx={i}
            cx={p.x}
            cy={p.y}
            r={7}
            fill={FRAME}
            stroke="rgba(0,0,0,0.8)"
            strokeWidth={1.5}
          />
        ))}
      </svg>
    </div>
  );
};

export default StripAlignFrame;
