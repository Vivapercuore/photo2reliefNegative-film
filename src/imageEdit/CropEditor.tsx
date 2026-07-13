import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CropRect, NO_CROP } from './imageEdit';
import './ImageEditor.css';

interface Props {
  /** image source url (data/object URL) */
  src: string;
  /** intrinsic pixel size of the source (for aspect + mm readout) */
  naturalWidth: number;
  naturalHeight: number;
  /** current crop (normalised 0..1) */
  value: CropRect;
  onChange: (c: CropRect) => void;
  /** physical length (mm) of the FINISHED long edge, to show/edit the crop in mm */
  longEdgeMm?: number;
  /** called when the manual W×H inputs change the size (= max(W,H)); lets the
   *  page keep its "long edge" in sync so the typed size is the print size */
  onLongEdgeChange?: (mm: number) => void;
}

/** Aspect presets: visual pixel ratio w/h, or null for free. */
const RATIOS: { id: string; label: string; ratio: number | null }[] = [
  { id: 'free', label: '自由', ratio: null },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
];

/** minimum crop size in normalised units (keeps a grabbable box) */
const MIN_N = 0.05;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 'e' | 's' | 'w' | 'move';

/**
 * Interactive crop overlay, shared by the CMYK / relief / positive modules. Eight
 * resize handles + drag-to-move on the original image, a rule-of-thirds grid,
 * aspect presets, and a manual W×H size (mm, excl. border) that both sets the
 * print size (via onLongEdgeChange) and locks the crop box to that ratio. The
 * crop is stored NORMALISED (0..1) so it is resolution-independent; `onChange`
 * fires on release so the downstream pipeline only recomputes once per edit.
 */
const CropEditor: React.FC<Props> = ({
  src,
  naturalWidth,
  naturalHeight,
  value,
  onChange,
  longEdgeMm,
  onLongEdgeChange,
}) => {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<CropRect>(value);
  const [ratio, setRatio] = useState<number | null>(null); // active visual w/h, null=free
  const [ratioId, setRatioId] = useState('free');
  const drag = useRef<{ handle: Handle; sx: number; sy: number; start: CropRect } | null>(null);

  // keep local rect in sync when the parent resets it (e.g. new image)
  useEffect(() => setRect(value), [value]);
  // mirror the latest rect so onUp can commit it WITHOUT calling onChange inside
  // a setState updater (that updates the parent during our render → React warns)
  const rectRef = useRef(rect);
  useEffect(() => {
    rectRef.current = rect;
  }, [rect]);

  // normalised aspect = w_norm / h_norm = visualRatio * (natH / natW)
  const aspectN = ratio && naturalWidth > 0 && naturalHeight > 0 ? ratio * (naturalHeight / naturalWidth) : null;

  const onDown = (handle: Handle) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const b = boxRef.current!.getBoundingClientRect();
    drag.current = {
      handle,
      sx: clamp01((e.clientX - b.left) / b.width),
      sy: clamp01((e.clientY - b.top) / b.height),
      start: rect,
    };
  };

  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const b = boxRef.current!.getBoundingClientRect();
      const nx = clamp01((e.clientX - b.left) / b.width);
      const ny = clamp01((e.clientY - b.top) / b.height);
      setRect(applyDrag(d.handle, d.start, d.sx, d.sy, nx, ny, aspectN));
    },
    [aspectN]
  );

  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    onChange(rectRef.current);
  };

  const pickRatio = (id: string) => {
    const r = RATIOS.find((x) => x.id === id)?.ratio ?? null;
    setRatioId(id);
    setRatio(r);
    const next = r ? centeredAspect(r * (naturalHeight / naturalWidth)) : NO_CROP;
    setRect(next);
    onChange(next);
  };

  // ---- mm readout / manual size ----
  const cropWpx = Math.max(1, Math.round(rect.w * naturalWidth));
  const cropHpx = Math.max(1, Math.round(rect.h * naturalHeight));
  const longPx = Math.max(cropWpx, cropHpx);
  const mmPerPx = longEdgeMm ? longEdgeMm / longPx : 0;
  const wMm = Math.round(cropWpx * mmPerPx);
  const hMm = Math.round(cropHpx * mmPerPx);

  // editable drafts (resync from derived mm whenever they change, e.g. on drag)
  const [wDraft, setWDraft] = useState('');
  const [hDraft, setHDraft] = useState('');
  useEffect(() => {
    setWDraft(String(wMm));
    setHDraft(String(hMm));
  }, [wMm, hMm]);

  // commit a typed size: set aspect to W:H, snap the box, and report the new long
  // edge (= max) so the page's print size becomes exactly W×H.
  const commitSize = (wStr: string, hStr: string) => {
    const w = parseFloat(wStr);
    const h = parseFloat(hStr);
    if (!(w > 0) || !(h > 0)) {
      setWDraft(String(wMm));
      setHDraft(String(hMm));
      return;
    }
    const vRatio = w / h;
    // 自定义尺寸即「自由」：把选框按 W:H 居中铺好，但不锁比例，之后可继续自由拖拽
    setRatio(null);
    setRatioId('free');
    const next = centeredAspect(vRatio * (naturalHeight / naturalWidth));
    setRect(next);
    onChange(next);
    onLongEdgeChange?.(Math.max(w, h));
  };

  const pct = (v: number) => `${v * 100}%`;
  const handles: Handle[] = ['nw', 'ne', 'sw', 'se', 'n', 'e', 's', 'w'];

  return (
    <div className="crop-editor">
      <div className="crop-ratios">
        {RATIOS.map((r) => (
          <button
            key={r.id}
            className={`crop-ratio${ratioId === r.id ? ' active' : ''}`}
            onClick={() => pickRatio(r.id)}
          >
            {r.label}
          </button>
        ))}
        <span className="crop-readout">{cropWpx}×{cropHpx}px</span>
      </div>

      {longEdgeMm ? (
        <div className="crop-size">
          <span className="crop-size-label">尺寸（不含边框）</span>
          宽
          <input
            className="crop-size-input"
            type="number"
            min={1}
            value={wDraft}
            onChange={(e) => setWDraft(e.target.value)}
            onBlur={() => commitSize(wDraft, hDraft)}
            onKeyDown={(e) => e.key === 'Enter' && commitSize(wDraft, hDraft)}
          />
          ×高
          <input
            className="crop-size-input"
            type="number"
            min={1}
            value={hDraft}
            onChange={(e) => setHDraft(e.target.value)}
            onBlur={() => commitSize(wDraft, hDraft)}
            onKeyDown={(e) => e.key === 'Enter' && commitSize(wDraft, hDraft)}
          />
          mm
        </div>
      ) : null}

      <div
        className="crop-stage"
        ref={boxRef}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <img className="crop-img" src={src} alt="原图" draggable={false} />
        <div
          className="crop-box"
          style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
          onPointerDown={onDown('move')}
        >
          <div className="crop-grid" />
          {handles.map((h) => (
            <div key={h} className={`crop-handle crop-${h}`} onPointerDown={onDown(h)} />
          ))}
        </div>
      </div>
    </div>
  );
};

/** Largest rect of normalised aspect `an` (=w/h) centred in the unit square. */
function centeredAspect(an: number): CropRect {
  let w = 1;
  let h = 1;
  if (an >= 1) h = 1 / an;
  else w = an;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/** Compute the new crop for a drag of `handle` from the start rect. */
function applyDrag(
  handle: Handle,
  start: CropRect,
  sx: number,
  sy: number,
  nx: number,
  ny: number,
  aspectN: number | null
): CropRect {
  if (handle === 'move') {
    const x = clamp01Range(start.x + (nx - sx), start.w);
    const y = clamp01Range(start.y + (ny - sy), start.h);
    return { x, y, w: start.w, h: start.h };
  }

  let l = start.x;
  let t = start.y;
  let r = start.x + start.w;
  let b = start.y + start.h;
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  const south = handle.includes('s');

  if (aspectN) {
    // aspect locked: anchor at the opposite corner; size from the moved axis
    const ax = west ? r : east ? l : (l + r) / 2;
    const ay = north ? b : south ? t : (t + b) / 2;
    let w = west || east ? Math.abs(nx - ax) : start.w;
    let h = north || south ? Math.abs(ny - ay) : start.h;
    if (west || east) h = w / aspectN;
    else w = h * aspectN;
    const maxW = west ? ax : east ? 1 - ax : Math.min(ax, 1 - ax) * 2;
    const maxH = north ? ay : south ? 1 - ay : Math.min(ay, 1 - ay) * 2;
    if (w > maxW) {
      w = maxW;
      h = w / aspectN;
    }
    if (h > maxH) {
      h = maxH;
      w = h * aspectN;
    }
    w = Math.max(MIN_N, w);
    h = Math.max(MIN_N, h);
    const nl = west ? ax - w : east ? ax : ax - w / 2;
    const nt = north ? ay - h : south ? ay : ay - h / 2;
    return { x: clamp01(nl), y: clamp01(nt), w, h };
  }

  // free: move only the edges this handle controls
  if (west) l = Math.min(nx, r - MIN_N);
  if (east) r = Math.max(nx, l + MIN_N);
  if (north) t = Math.min(ny, b - MIN_N);
  if (south) b = Math.max(ny, t + MIN_N);
  return { x: l, y: t, w: r - l, h: b - t };
}

/** keep position so position+size stays within [0,1] */
function clamp01Range(pos: number, size: number): number {
  if (pos < 0) return 0;
  if (pos + size > 1) return 1 - size;
  return pos;
}

export default CropEditor;
