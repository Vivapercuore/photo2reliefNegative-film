import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Card } from '@arco-design/web-react';
import './Home.css';

interface FeatureItem {
  title: string;
  description: string;
  path: string;
  icon: string;
}

const features: FeatureItem[] = [
  {
    title: '照片转浮雕负片',
    description: '将照片转换为3D浮雕深度数据(.dat)和OpenSCAD模型文件(.scad)，用于3D打印制作照片浮雕负片。',
    path: '/photo2relief',
    icon: '🖨️',
  },
  {
    title: '激光刀切转3D模型',
    description: '上传拓竹社区的激光刀切 .lac 文件，自动读取刀路，挤出生成可预览、可下载(STL)的3D模型。',
    path: '/lac2model',
    icon: '🪚',
  },
];

const Home: React.FC = () => {
  const navigate = useNavigate();

  return (
    <div className="home-container">
      <header className="home-header">
        <h2 className="home-title">打印机，就该用来打照片！</h2>
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
