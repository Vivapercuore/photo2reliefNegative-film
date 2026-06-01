import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';

interface ModelViewerProps {
  /** the model to display; pass null to clear */
  object: THREE.Object3D | null;
  className?: string;
}

interface ViewerRefs {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  grid: THREE.GridHelper;
  frameId: number;
  ro: ResizeObserver;
}

const ModelViewer: React.FC<ModelViewerProps> = ({ object, className }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const refs = useRef<ViewerRefs | null>(null);
  const currentObject = useRef<THREE.Object3D | null>(null);

  // one-time scene setup
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1d1d1d);

    const width = container.clientWidth || 600;
    const height = container.clientHeight || 400;

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100000);
    camera.position.set(120, 120, 160);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(1, 1.5, 1);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.4);
    fill.position.set(-1, -0.5, -1);
    scene.add(fill);

    const grid = new THREE.GridHelper(400, 40, 0x555555, 0x333333);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.4;
    scene.add(grid);

    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      if (refs.current) refs.current.frameId = requestAnimationFrame(animate);
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
        }
      });
    });
    ro.observe(container);

    refs.current = { renderer, scene, camera, controls, grid, frameId: 0, ro };
    refs.current.frameId = requestAnimationFrame(animate);

    return () => {
      if (refs.current) cancelAnimationFrame(refs.current.frameId);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      refs.current = null;
    };
  }, []);

  // swap displayed object + frame the camera to fit it
  useEffect(() => {
    const r = refs.current;
    if (!r) return;

    if (currentObject.current) {
      r.scene.remove(currentObject.current);
      currentObject.current = null;
    }
    if (!object) return;

    r.scene.add(object);
    currentObject.current = object;

    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const fov = (r.camera.fov * Math.PI) / 180;
    const dist = (maxDim / 2 / Math.tan(fov / 2)) * 1.8;

    r.controls.target.copy(center);
    r.camera.position.set(center.x + dist * 0.7, center.y + dist * 0.7, center.z + dist);
    r.camera.near = Math.max(0.1, maxDim / 1000);
    r.camera.far = maxDim * 100;
    r.camera.updateProjectionMatrix();
    r.controls.update();

    // scale the floor grid to the model
    r.scene.remove(r.grid);
    const gsize = Math.ceil((maxDim * 2) / 10) * 10;
    const grid = new THREE.GridHelper(gsize, 40, 0x555555, 0x333333);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.4;
    grid.position.set(center.x, box.min.y, center.z);
    r.scene.add(grid);
    r.grid = grid;
  }, [object]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: '100%', height: '100%', minHeight: 360 }}
    />
  );
};

export default ModelViewer;
