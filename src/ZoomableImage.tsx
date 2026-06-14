import React, { useState } from 'react';
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

/**
 * Click-to-fullscreen image. Shows the image inline; clicking opens a fullscreen
 * lightbox overlay (click anywhere or × to close). Reused by the relief and
 * color modules so previews aren't cramped in the settings panel.
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
  if (!src) return null;
  const rendering = (pixelated ? 'pixelated' : 'auto') as React.CSSProperties['imageRendering'];
  const zoomRendering = ((zoomPixelated ?? pixelated)
    ? 'pixelated'
    : 'auto') as React.CSSProperties['imageRendering'];
  return (
    <>
      <img
        src={src}
        alt={alt || ''}
        className={`zoomable-img ${className || ''}`}
        style={{ imageRendering: rendering }}
        onClick={() => setZoom(true)}
      />
      {zoom ? (
        <div className="zoom-lightbox" onClick={() => setZoom(false)}>
          <img src={zoomSrc || src} alt={alt || ''} style={{ imageRendering: zoomRendering }} />
          <span className="zoom-close" aria-label="关闭">
            ×
          </span>
        </div>
      ) : null}
    </>
  );
};

export default ZoomableImage;
