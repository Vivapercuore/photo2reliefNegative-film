import React, { useEffect, useRef } from 'react';
import { LacModel, Plate, Pt } from '../lac/parseLac';
import { engraveColorAt, engraveProcessOrder } from '../lac/buildMesh';

interface Props {
  model: LacModel;
  /** selected plate index (1-based), or 0 for all plates tiled in a grid */
  plateSel: number;
  /** flip Y to match the 3D preview orientation */
  flipY: boolean;
  /** color engrave paths by their energy (matches the 3D color hint) */
  showEngraveColors: boolean;
  /** gap (mm) between plates when tiling all of them */
  plateGap?: number;
  className?: string;
}

const CUT_COLOR = '#d8d8d8';
const ENGRAVE_FALLBACK = '#8a8a8a';
const PADDING = 24; // px border kept around the drawing when auto-fitting

/**
 * Flat, top-down 2D preview of the laser paths. Cut contours are drawn light;
 * engrave contours are colored by their energy (same palette as the 3D hint and
 * the parameter table). Supports wheel-zoom and drag-to-pan.
 */
const PathPreview: React.FC<Props> = ({ model, plateSel, flipY, showEngraveColors, plateGap = 20, className }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // view transform: world(mm) → screen(px) is scale*world + offset; user pan/zoom
  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0, fitted: false });

  useEffect(() => {
    // recompute fit whenever the drawing inputs change
    viewRef.current.fitted = false;
  }, [model, plateSel, flipY, showEngraveColors]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Map each distinct engrave process type → its palette color (energy order).
    const order = engraveProcessOrder(model);
    const colorOf = (piece: { process: string; laser: { processType: string } }) => {
      if (piece.process !== 'engrave') return CUT_COLOR;
      if (!showEngraveColors) return ENGRAVE_FALLBACK;
      const idx = order.indexOf(piece.laser.processType);
      return idx >= 0 ? engraveColorAt(idx) : ENGRAVE_FALLBACK;
    };

    // Plates to draw, and their world-space (mm) placement (grid, centered).
    const selected: Plate[] =
      plateSel === 0 ? model.plates : model.plates.filter((p) => p.index === plateSel);
    const n = selected.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    const rows = Math.ceil(n / cols);
    const cellW = Math.max(...selected.map((p) => p.bbox.width), 1) + plateGap;
    const cellH = Math.max(...selected.map((p) => p.bbox.height), 1) + plateGap;

    // Build world-space polylines once, accumulating the overall bbox.
    type Line = { pts: Pt[]; color: string; closed: boolean };
    const lines: Line[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    selected.forEach((plate, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const offX = (col - (cols - 1) / 2) * cellW;
      const offY = (row - (rows - 1) / 2) * cellH;
      const cx = (plate.bbox.minX + plate.bbox.maxX) / 2;
      const cy = (plate.bbox.minY + plate.bbox.maxY) / 2;
      for (const piece of plate.pieces) {
        const color = colorOf(piece);
        for (const lp of piece.loops) {
          const pts = lp.map((p) => {
            const x = p.x - cx + offX;
            const y = (flipY ? -(p.y - cy) : p.y - cy) + offY;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            return { x, y };
          });
          if (pts.length >= 2) lines.push({ pts, color, closed: piece.closed });
        }
      }
    });

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const W = Math.max(1, Math.floor(rect.width));
      const H = Math.max(1, Math.floor(rect.height));
      if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
        canvas.width = W * dpr;
        canvas.height = H * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return;

      const view = viewRef.current;
      if (!view.fitted) {
        const bw = maxX - minX;
        const bh = maxY - minY;
        const fit = Math.min((W - PADDING * 2) / bw, (H - PADDING * 2) / bh);
        view.zoom = fit > 0 && Number.isFinite(fit) ? fit : 1;
        // center the drawing
        const midX = (minX + maxX) / 2;
        const midY = (minY + maxY) / 2;
        view.panX = W / 2 - midX * view.zoom;
        view.panY = H / 2 - midY * view.zoom;
        view.fitted = true;
      }

      const sx = (x: number) => x * view.zoom + view.panX;
      const sy = (y: number) => y * view.zoom + view.panY;

      ctx.lineWidth = 1;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const ln of lines) {
        ctx.beginPath();
        ctx.moveTo(sx(ln.pts[0].x), sy(ln.pts[0].y));
        for (let k = 1; k < ln.pts.length; k++) ctx.lineTo(sx(ln.pts[k].x), sy(ln.pts[k].y));
        if (ln.closed) ctx.closePath();
        ctx.strokeStyle = ln.color;
        ctx.stroke();
      }
    };

    draw();

    // interactions: wheel-zoom (anchored at cursor) and drag-to-pan
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const view = viewRef.current;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const newZoom = Math.min(1e5, Math.max(1e-4, view.zoom * factor));
      // keep the point under the cursor stationary
      view.panX = mx - (mx - view.panX) * (newZoom / view.zoom);
      view.panY = my - (my - view.panY) * (newZoom / view.zoom);
      view.zoom = newZoom;
      draw();
    };
    const onDown = (e: MouseEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onMove = (e: MouseEvent) => {
      if (!dragging) return;
      const view = viewRef.current;
      view.panX += e.clientX - lastX;
      view.panY += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      draw();
    };
    const onUp = () => {
      dragging = false;
    };

    const ro = new ResizeObserver(() => {
      viewRef.current.fitted = false;
      draw();
    });
    ro.observe(canvas);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    return () => {
      ro.disconnect();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [model, plateSel, flipY, showEngraveColors, plateGap]);

  return <canvas ref={canvasRef} className={className} style={{ cursor: 'grab' }} />;
};

export default PathPreview;
