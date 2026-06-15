import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

interface ModelViewerProps {
  /** the model to display; pass null to clear */
  object: THREE.Object3D | null;
  className?: string;
  /** bump/change this to force a redraw when the scene mutates WITHOUT a new
   *  `object` (e.g. toggling a child mesh's visibility) — render is on-demand */
  revision?: unknown;
}

/**
 * A single, app-wide WebGL renderer. Creating a renderer per mount leaks a GPU
 * context on every unmount (2D/3D toggle, file reload, navigation, StrictMode
 * double-mount); browsers cap live contexts (~16) and, once exceeded, can
 * disable WebGL for the whole tab until a full restart. By sharing ONE renderer
 * and only ever moving its <canvas> between containers, the app uses at most one
 * context for its entire lifetime — the leak is structurally impossible.
 */
let sharedRenderer: THREE.WebGLRenderer | null = null;
let sharedRendererFailed = false;

function getSharedRenderer(): THREE.WebGLRenderer | null {
  if (sharedRenderer) return sharedRenderer;
  if (sharedRendererFailed) return null;
  try {
    const r = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(window.devicePixelRatio);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.15;
    sharedRenderer = r;
    return r;
  } catch (err) {
    sharedRendererFailed = true;
    return null;
  }
}

const ModelViewer: React.FC<ModelViewerProps> = ({ object, className, revision }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const currentObject = useRef<THREE.Object3D | null>(null);
  // render-on-demand flag: draw only when the camera moved or the scene changed
  const invalidate = useRef(true);
  const [glError, setGlError] = useState(false);

  // per-mount scene setup; reuses the shared renderer's canvas
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = getSharedRenderer();
    if (!renderer) {
      setGlError(true);
      return;
    }
    setGlError(false);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1d1d1d);
    sceneRef.current = scene;

    const width = container.clientWidth || 600;
    const height = container.clientHeight || 400;

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000);
    camera.position.set(120, 120, 160);
    cameraRef.current = camera;

    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controlsRef.current = controls;

    // Sky/ground hemisphere fill gives volume even on flat top faces; a strong
    // key plus a softer fill and a back rim light bring out the 3D structure.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x4a4a52, 0.55);
    scene.add(hemi);
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    const key = new THREE.DirectionalLight(0xffffff, 1.15);
    key.position.set(0.7, 1.4, 0.9);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-0.9, 0.4, -0.6);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.45);
    rim.position.set(0.2, 0.6, -1.2);
    scene.add(rim);

    const grid = new THREE.GridHelper(400, 40, 0x555555, 0x333333);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.4;
    scene.add(grid);
    gridRef.current = grid;

    // redraw whenever the camera changes (user drag/zoom, and each damping step)
    controls.addEventListener('change', () => {
      invalidate.current = true;
    });

    let frameId = 0;
    let disposed = false;
    // Render ON DEMAND: the scene is static between interactions, so only draw
    // when something invalidated it. Continuously re-rendering a heavy (100k+
    // triangle) static scene at the display refresh rate pegs the CPU/GPU for
    // no reason. controls.update() still runs each frame to advance damping
    // (which fires 'change' → sets the flag while it keeps moving).
    const animate = () => {
      if (disposed) return;
      frameId = requestAnimationFrame(animate);
      controls.update();
      if (invalidate.current) {
        renderer.render(scene, camera);
        invalidate.current = false;
      }
    };

    // Defer the actual resize work to the next frame. Doing it synchronously
    // inside the ResizeObserver callback can re-trigger layout within the same
    // delivery cycle, which the browser reports as the (benign) error
    // "ResizeObserver loop completed with undelivered notifications" — CRA's
    // dev overlay then surfaces it as an uncaught runtime error.
    let resizeRaf = 0;
    const ro = new ResizeObserver(() => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w && h) {
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
          invalidate.current = true;
        }
      });
    });
    ro.observe(container);

    // rAF is paused while the tab is hidden; redraw once it's visible again so a
    // model that rebuilt in the background isn't left stale.
    const onVisible = () => {
      if (!document.hidden) invalidate.current = true;
    };
    document.addEventListener('visibilitychange', onVisible);

    frameId = requestAnimationFrame(animate);

    return () => {
      disposed = true;
      cancelAnimationFrame(frameId);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      document.removeEventListener('visibilitychange', onVisible);
      ro.disconnect();
      controls.dispose();
      // Detach (but DON'T dispose) the shared renderer so it survives for the
      // next mount — this is what prevents context leaks.
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      // dispose per-mount scene resources (geometries/materials are owned by the
      // caller via the passed-in object, so we only drop our own helpers/lights)
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      sceneRef.current = null;
      cameraRef.current = null;
      controlsRef.current = null;
      gridRef.current = null;
    };
  }, []);

  // swap displayed object + frame the camera to fit it
  useEffect(() => {
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!scene || !camera || !controls) return;

    if (currentObject.current) {
      scene.remove(currentObject.current);
      currentObject.current = null;
    }
    if (!object) return;

    scene.add(object);
    currentObject.current = object;

    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const fov = (camera.fov * Math.PI) / 180;
    const dist = (maxDim / 2 / Math.tan(fov / 2)) * 1.8;

    controls.target.copy(center);
    // default to a straight top-down view (camera directly above, -Z = screen-up)
    camera.up.set(0, 0, -1);
    camera.position.set(center.x, center.y + dist, center.z);
    camera.near = Math.max(0.1, maxDim / 1000);
    camera.far = maxDim * 100;
    camera.updateProjectionMatrix();
    controls.update();

    // scale the floor grid to the model
    if (gridRef.current) {
      scene.remove(gridRef.current);
      gridRef.current.geometry.dispose();
      (gridRef.current.material as THREE.Material).dispose();
    }
    const gsize = Math.ceil((maxDim * 2) / 10) * 10;
    const grid = new THREE.GridHelper(gsize, 40, 0x555555, 0x333333);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.4;
    grid.position.set(center.x, box.min.y, center.z);
    scene.add(grid);
    gridRef.current = grid;
    invalidate.current = true; // new model → draw once
  }, [object]);

  // external scene mutation (e.g. a child mesh's visibility toggled) → redraw
  useEffect(() => {
    invalidate.current = true;
  }, [revision]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        width: '100%',
        height: '100%',
        minHeight: 360,
        display: glError ? 'flex' : undefined,
        alignItems: glError ? 'center' : undefined,
        justifyContent: glError ? 'center' : undefined,
        textAlign: 'center',
        color: '#bbb',
        padding: glError ? 16 : undefined,
        boxSizing: 'border-box',
      }}
    >
      {glError
        ? '无法创建 3D 预览（WebGL 已被浏览器禁用）。这通常发生在之前的 WebGL 错误导致浏览器临时关闭了 GPU 加速——请彻底关闭并重新打开浏览器；若仍失败，请在浏览器设置中开启“使用硬件加速”。'
        : null}
    </div>
  );
};

export default ModelViewer;
