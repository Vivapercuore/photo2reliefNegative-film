import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@arco-design/web-react';
import { useDocumentTitle } from './useDocumentTitle';
import './Home.css';

interface FeatureItem {
  title: string;
  description: string;
  path: string;
  icon: React.ReactNode;
}

/**
 * Laser-cutting icon: a laser head emits a beam down onto a sheet of material
 * that carries a cut contour and a bored hole, with a spark at the impact
 * point. Line-art (currentColor) to match the dark Arco theme and the emoji
 * icons next to it.
 */
const LaserCutIcon: React.FC = () => (
  <svg
    width="48"
    height="48"
    viewBox="0 0 48 48"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {/* laser head / nozzle */}
    <path d="M18 4 h12 l-2 6 h-8 z" />
    {/* beam (dashed, fading toward the sheet) */}
    <path d="M24 10 V22" strokeDasharray="2 3" opacity="0.85" />
    {/* spark at the cut point */}
    <path d="M24 23.5 l0 -2 M24 23.5 l1.8 -0.9 M24 23.5 l-1.8 -0.9" opacity="0.9" />
    {/* material sheet */}
    <rect x="6" y="26" width="36" height="16" rx="2" />
    {/* cut contour (a rounded part) on the sheet */}
    <rect x="11" y="30" width="9" height="8" rx="2" opacity="0.9" />
    {/* bored hole */}
    <circle cx="32" cy="34" r="3" opacity="0.9" />
  </svg>
);

/**
 * Relief / backlit-lithophane icon: a backlight glow with rays at the top, a
 * relief plate below whose interior bars rise to different heights to read as
 * the light/dark relief surface (the light shining through it). Line-art
 * (currentColor) to match the laser-cut icon.
 */
const ReliefIcon: React.FC = () => (
  <svg
    width="48"
    height="48"
    viewBox="0 0 48 48"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {/* backlight source */}
    <circle cx="24" cy="9" r="3.5" />
    {/* light rays */}
    <path d="M24 2.5 V0.5 M30 5 l1.4 -1.4 M18 5 l-1.4 -1.4 M31.5 11 l1.8 0 M16.5 11 l-1.8 0" opacity="0.85" />
    {/* relief plate */}
    <rect x="7" y="22" width="34" height="20" rx="2" />
    {/* relief surface: bars of varying height = light/dark profile */}
    <path
      d="M13 38 V32 M18 38 V27 M23 38 V30 M28 38 V25 M33 38 V33"
      opacity="0.9"
    />
  </svg>
);

/**
 * Color-positive icon: a backlight glow over a panel filled with R/G/B dither
 * dots (additive color) — the dithered color print read by light.
 */
const ColorPositiveIcon: React.FC = () => (
  <svg
    width="48"
    height="48"
    viewBox="0 0 48 48"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {/* backlight source + rays */}
    <circle cx="24" cy="9" r="3.5" />
    <path d="M24 2.5 V0.5 M30 5 l1.4 -1.4 M18 5 l-1.4 -1.4" opacity="0.85" />
    {/* panel */}
    <rect x="8" y="22" width="32" height="20" rx="2" />
    {/* RGB dither dots */}
    <g stroke="none">
      <circle cx="15" cy="29" r="2" fill="#f53f3f" />
      <circle cx="22" cy="29" r="2" fill="#00b42a" />
      <circle cx="29" cy="29" r="2" fill="#3491fa" />
      <circle cx="18" cy="35" r="2" fill="#3491fa" />
      <circle cx="25" cy="35" r="2" fill="#f53f3f" />
      <circle cx="32" cy="35" r="2" fill="#00b42a" />
    </g>
  </svg>
);

/**
 * CMYK thickness icon: four stacked ink layers (C/M/Y/K) of varying length —
 * thickness carries the tone.
 */
const ColorCmykIcon: React.FC = () => (
  <svg
    width="48"
    height="48"
    viewBox="0 0 48 48"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {/* backlight source + rays */}
    <circle cx="24" cy="8" r="3.5" />
    <path d="M24 1.5 V-0.5 M30 4 l1.4 -1.4 M18 4 l-1.4 -1.4" opacity="0.85" />
    {/* stacked ink layers, lengths vary like channel thickness */}
    <g stroke="none">
      <rect x="10" y="20" width="28" height="5" rx="1.5" fill="#fff200" />
      <rect x="13" y="26" width="22" height="5" rx="1.5" fill="#ec008c" />
      <rect x="11" y="32" width="26" height="5" rx="1.5" fill="#00aeef" />
      <rect x="16" y="38" width="16" height="5" rx="1.5" fill="#555" />
    </g>
  </svg>
);

const features: FeatureItem[] = [
  {
    title: '照片转浮雕负片',
    description: '上传照片，浏览器内实时生成可预览、可下载(STL)的3D浮雕负片模型，直接切片打印，无需 OpenSCAD。',
    path: '/photo2relief',
    icon: <ReliefIcon />,
  },
  {
    title: '激光刀切转3D模型',
    description: '上传拓竹社区的激光刀切 .lac 文件，自动读取刀路，挤出生成可预览、可下载(STL)的3D模型。',
    path: '/lac2model',
    icon: <LaserCutIcon />,
  },
  {
    title: '彩色照片转正片',
    description:
      '上传彩色照片，Floyd-Steinberg 抖动到 RGB+黑，按喷嘴物理分辨率生成「颜色分布直接决定色彩」的多色正片（测试版，多色 3MF 导出开发中）。',
    path: '/color-positive',
    icon: <ColorPositiveIcon />,
  },
  {
    title: '彩色照片转CMYK透光画',
    description:
      'RGB 转 CMYK 四通道，通道厚度控制明度（越厚越深），四层半透明耗材堆叠透光显色。4 色 AMS 即可打印，无需暂停换料（测试版）。',
    path: '/color-cmyk',
    icon: <ColorCmykIcon />,
  },
];

const Home: React.FC = () => {
  const navigate = useNavigate();
  useDocumentTitle();

  return (
    <div className="home-container">
      <header className="home-header">
        <h2 className="home-title">viva的3D打印小工具</h2>
        <p className="home-subtitle">选择一个功能开始使用</p>
      </header>
      <div className="feature-grid">
        {features.map((feature) => (
          <Card
            key={feature.path}
            className="feature-card"
            hoverable
            bordered
            onClick={() => navigate(feature.path)}
          >
            <div className="feature-icon">{feature.icon}</div>
            <h5 className="feature-title">{feature.title}</h5>
            <p className="feature-desc">{feature.description}</p>
          </Card>
        ))}
      </div>
    </div>
  );
};

export default Home;
