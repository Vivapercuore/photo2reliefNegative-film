import React, { useRef } from 'react';

interface Props {
  /** called with the picked/dropped File (read locally, never uploaded) */
  onFile: (file: File) => void;
  /** show the "already loaded" state */
  loaded?: boolean;
  /** sub-line hint under the main text */
  hint?: string;
}

/** Click-or-drag photo loader. Reads the file locally only — no "上传" wording,
 *  nothing leaves the device. Shared by the calibrate page and the CMYK module. */
const PhotoDropZone: React.FC<Props> = ({
  onFile,
  loaded,
  hint = '仅支持图片 · 全程本地读取，不会离开你的设备',
}) => {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = ''; // 允许再次选同一文件
        }}
      />
      <div
        className="cmykcal-drop"
        onClick={() => ref.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          e.currentTarget.classList.add('is-over');
        }}
        onDragLeave={(e) => e.currentTarget.classList.remove('is-over')}
        onDrop={(e) => {
          e.preventDefault();
          e.currentTarget.classList.remove('is-over');
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
      >
        <div className="cmykcal-drop-plus">＋</div>
        <div className="cmykcal-drop-main">
          {loaded ? '已载入 · 点击或拖拽可更换' : '点击选择，或把照片拖拽到此处'}
        </div>
        <div className="cmykcal-drop-sub">{hint}</div>
      </div>
    </>
  );
};

export default PhotoDropZone;
