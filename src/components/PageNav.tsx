import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@arco-design/web-react';
import './PageNav.css';

export interface PageNavProps {
  /** 中文工具名 */
  title: string;
  /** 技术代码眉标，如 "RELIEF" / "LAC→3D" / "CMYK" */
  code?: string;
  /** 返回目标路由，默认 '/' */
  backTo?: string;
  /** 右侧操作区（页面自带的按钮塞这里） */
  actions?: React.ReactNode;
}

/**
 * LUMEN 全站共享顶栏（DESIGN.md §6）。
 * 渲染：[← 返回] [◆品牌glyph] 工具名 ·CODE ——(弹性)—— [actions]
 * 高 48px，bg-0 半透明 + backdrop-blur，底部 1px 光谱发丝线（§4 预算 1）。
 */
const PageNav: React.FC<PageNavProps> = ({
  title,
  code,
  backTo = '/',
  actions,
}) => {
  const navigate = useNavigate();

  return (
    <header className="lx-pagenav">
      <Button
        className="lx-pagenav-back"
        type="text"
        size="small"
        onClick={() => navigate(backTo)}
      >
        <span className="lx-pagenav-back-arrow" aria-hidden="true">
          ←
        </span>
        返回
      </Button>

      <span className="lx-pagenav-glyph" aria-hidden="true" />

      <h1 className="lx-pagenav-title">
        {title}
        {code && <span className="lx-pagenav-code">·{code}</span>}
      </h1>

      <span className="lx-pagenav-spacer" />

      {actions && <div className="lx-pagenav-actions">{actions}</div>}
    </header>
  );
};

export default PageNav;
