import * as THREE from 'three';

/** 支持的最大色带数（shader 数组上限；UI 限 8，留裕量） */
export const MAX_BANDS = 16;

const VERT = `
varying vec3 vNormal;
varying float vY;
void main() {
  vNormal = normalMatrix * normal;
  vY = position.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = `
uniform float uBandTop[${MAX_BANDS}];
uniform vec3 uBandColor[${MAX_BANDS}];
uniform int uBandCount;
varying vec3 vNormal;
varying float vY;
void main() {
  vec3 c = uBandColor[0];
  for (int i = 0; i < ${MAX_BANDS}; i++) {
    if (i >= uBandCount) break;
    if (vY <= uBandTop[i] + 1e-4) {
      c = uBandColor[i];
      break;
    }
  }
  vec3 n = normalize(vNormal);
  // 相机侧固定方向光 + 环境项：配色所见即所得，明暗只用来读出台阶结构
  float diff = max(dot(n, normalize(vec3(0.35, 0.75, 0.55))), 0.0);
  vec3 col = c * (0.5 + 0.55 * diff);
  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * 按局部 y 高度分带着色的预览材质：片元落在哪个色带区间就取哪带的纯色，
 * 顶面与台阶侧壁都严格由高度决定 —— 预览语义 = 打印语义。
 */
export function createBandMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uBandTop: { value: new Float32Array(MAX_BANDS).fill(1e9) },
      uBandColor: { value: Array.from({ length: MAX_BANDS }, () => new THREE.Color(1, 1, 1)) },
      uBandCount: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.DoubleSide,
  });
}

/** 更新色带边界与颜色（tops/colors 底→顶，一一对应）。 */
export function updateBandMaterial(mat: THREE.ShaderMaterial, tops: number[], colors: string[]): void {
  const t = mat.uniforms.uBandTop.value as Float32Array;
  const c = mat.uniforms.uBandColor.value as THREE.Color[];
  const n = Math.min(tops.length, MAX_BANDS);
  for (let i = 0; i < MAX_BANDS; i++) {
    t[i] = i < n ? tops[i] : 1e9;
    if (i < n) {
      const v = parseInt(colors[i].replace('#', ''), 16);
      // setRGB 默认不做色彩空间转换（three r160）：sRGB 数值直出，
      // 与色板色块 / 2D 量化预览的颜色一致
      c[i].setRGB(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
    }
  }
  mat.uniforms.uBandCount.value = n;
}
