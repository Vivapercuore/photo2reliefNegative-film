import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useDocumentTitle } from './useDocumentTitle';
import './Home.css';

interface FeatureItem {
  title: string;
  description: string;
  path: string;
  /** 变换标签右段（左段固定 PHOTO）：四工具皆为「照片 → 物质」的一种变换 */
  transform: string;
  icon: React.ReactNode;
}

/**
 * Laser-cutting icon: a laser head emits a beam down onto a sheet of material
 * that carries a cut contour and a bored hole, with a spark at the impact
 * point. Line-art (currentColor) so the parent can ignite it to a warm
 * backlight glow on hover.
 */
const LaserCutIcon: React.FC = () => (
  <svg
    width="44"
    height="44"
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
 * (currentColor) so the parent can ignite it to a warm backlight glow on hover.
 */
const ReliefIcon: React.FC = () => (
  <svg
    width="44"
    height="44"
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

const features: FeatureItem[] = [
  {
    title: '照片转浮雕负片',
    description: '上传照片，浏览器内实时生成可预览、可下载(STL)的3D浮雕负片模型，直接切片打印，无需 OpenSCAD。',
    path: '/photo2relief',
    transform: 'RELIEF',
    icon: <ReliefIcon />,
  },
  {
    title: '激光刀切转3D模型',
    description: '上传拓竹社区的激光刀切 .lac 文件，自动读取刀路，挤出生成可预览、可下载(STL)的3D模型。',
    path: '/lac2model',
    transform: 'LAC → 3D',
    icon: <LaserCutIcon />,
  },
];

const Home: React.FC = () => {
  const navigate = useNavigate();
  useDocumentTitle();

  return (
    <div className="home">
      <div className="home-inner">
        <header className="home-hero lx-rise">
          <div className="home-eyebrow">PHOTO → MATTER</div>
          <h1 className="home-brand">
            <span className="home-brand-mark">viva 的 3D 打印小工具</span>
          </h1>
          <p className="home-tagline">
            浏览器内 3D 制造
            <span className="home-tagline-arrow">·</span>
            照片
            <span className="home-tagline-arrow">→</span>
            <span className="home-tagline-dim">靠厚度与分色控制光的实体</span>
          </p>
        </header>

        <div className="home-grid">
          {features.map((feature, i) => (
            <button
              key={feature.path}
              type="button"
              className="home-plate lx-rise"
              style={
                { '--lx-rise-delay': `${80 + i * 50}ms` } as React.CSSProperties
              }
              onClick={() => navigate(feature.path)}
            >
              <div className="home-plate-head">
                <span className="home-plate-index">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="home-plate-transform">
                  PHOTO
                  <span className="home-plate-arrow">→</span>
                  {feature.transform}
                </span>
              </div>

              <span className="home-plate-icon">{feature.icon}</span>

              <h2 className="home-plate-title">{feature.title}</h2>
              <p className="home-plate-desc">{feature.description}</p>

              <span className="home-plate-cta">
                进入
                <span className="home-plate-cta-arrow" aria-hidden="true">
                  →
                </span>
              </span>
            </button>
          ))}
        </div>

        <div className="home-foot lx-rise" style={{ '--lx-rise-delay': '260ms' } as React.CSSProperties}>
          IN-BROWSER · NO UPLOAD · WATERTIGHT STL / 3MF
        </div>
      </div>
    </div>
  );
};

export default Home;
