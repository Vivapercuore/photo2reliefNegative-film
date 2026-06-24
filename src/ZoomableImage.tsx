import React, { useEffect, useRef, useState } from 'react';
import './ZoomableImage.css';

interface Props {
  /** image source (data URL or object URL) */
  src: string;
  alt?: string;
  /** nearest-neighbour scaling, for pixel-art previews */
  pixelated?: boolean;
  /**
   * Separate source for the fullscreen view (defaults to `src`). Lets the
   * inline thumbnail be a pre-downscaled rendition (browsers downscale in
   * gamma space with moiré — wrong for dither dot maps) while zooming still
   * opens the full-resolution original.
   */
  zoomSrc?: string;
  /** nearest-neighbour scaling for the fullscreen view (defaults to `pixelated`) */
  zoomPixelated?: boolean;
  className?: string;
}

const MIN_SCALE = 1;
const MAX_SCALE = 16;

/**
 * Click-to-fullscreen image. Clicking opens a fullscreen lightbox; inside it the
 * scroll wheel zooms toward the cursor, drag pans (when zoomed), and a click (at
 * 1×) or × closes. Reused by the relief and colour modules.
 */
const ZoomableImage: React.FC<Props> = ({
  src,
  alt,
  pixelated,
  zoomSrc,
  zoomPixelated,
  className,
}) => {
  const [zoom, setZoom] = useState(false);
  const [view, setView] = useState({ s: 1, x: 0, y: 0 }); // scale + translate (px from center)
  const boxRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  // Wheel zoom toward the cursor. Attached non-passively because React's onWheel
  // is passive (preventDefault would be ignored), and we must stop the page from
  // scrolling behind the overlay.
  useEffect(() => {
    const box = boxRef.current;
    if (!zoom || !box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = box.getBoundingClientRect();
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      setView((p) => {
        let s = p.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2);
        if (s < MIN_SCALE) s = MIN_SCALE;
        else if (s > MAX_SCALE) s = MAX_SCALE;
        const k = s / p.s;
        let x = cx - k * (cx - p.x); // keep the point under the cursor fixed
        let y = cy - k * (cy - p.y);
        if (s === MIN_SCALE) {
          x = 0;
          y = 0;
        } // snap back to centred at 1×
        return { s, x, y };
      });
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [zoom]);

  if (!src) return null;
  const rendering = (pixelated ? 'pixelated' : 'auto') as React.CSSProperties['imageRendering'];
  const zoomRendering = ((zoomPixelated ?? pixelated)
    ? 'pixelated'
    : 'auto') as React.CSSProperties['imageRendering'];

  const open = () => {
    setView({ s: 1, x: 0, y: 0 });
    setZoom(true);
  };
  const close = () => setZoom(false);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) d.moved = true;
    if (view.s > 1 && d.moved) setView((p) => ({ s: p.s, x: d.vx + dx, y: d.vy + dy }));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved && view.s <= 1) close(); // clean click (only at 1×) closes
  };

  return (
    <>
      <img
        src={src}
        alt={alt || ''}
        className={`zoomable-img ${className || ''}`}
        style={{ imageRendering: rendering }}
        onClick={open}
      />
      {zoom ? (
        <div
          className="zoom-lightbox"
          ref={boxRef}
          onClick={(e) => {
            if (e.target === e.currentTarget) close(); // click on the backdrop closes
          }}
        >
          <img
            src={zoomSrc || src}
            alt={alt || ''}
            draggable={false}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            style={{
              imageRendering: zoomRendering,
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
              cursor: view.s > 1 ? 'grab' : 'zoom-out',
            }}
          />
          <span className="zoom-hint">滚轮缩放 · 拖动平移 · ×/点击空白关闭</span>
          <span
            className="zoom-close"
            aria-label="关闭"
            onClick={(e) => {
              e.stopPropagation();
              close();
            }}
          >
            ×
          </span>
        </div>
      ) : null}
    </>
  );
};

export default ZoomableImage;
