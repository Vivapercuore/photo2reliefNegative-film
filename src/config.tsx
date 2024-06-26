/*
 * @Author: error: error: git config user.name & please set dead value or install git && error: git config user.email & please set dead value or install git & please set dead value or install git
 * @Date: 2024-06-25 22:47:01
 * @LastEditors: error: error: git config user.name & please set dead value or install git && error: git config user.email & please set dead value or install git & please set dead value or install git
 * @LastEditTime: 2024-06-26 02:18:08
 * @FilePath: \photo2reliefNegativeFilm\src\config.tsx
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import React, { useState, useEffect } from 'react';
import './config.css';
import {
  List,
  Radio,
  InputNumber,
  Switch,
  Upload,
  Message,
  Button,
  Progress,
} from '@arco-design/web-react';

import {
  getDataDeep,
  getScad,
  downloadFile,
} from './image2DataDeep/image2DataDeep';

const RadioGroup = Radio.Group;

enum PresetMode {
  'default' = 'default',
  'precision' = 'precision',
  'custom' = 'custom',
}

function Config() {
  const [Preset, setPreset] = useState(PresetMode.default);
  useEffect(() => {
    if (Preset === PresetMode.default) {
      setBaseDeep(0.16);
      setLayerDeep(0.08);
    }
    if (Preset === PresetMode.precision) {
      setBaseDeep(0.08);
      setLayerDeep(0.04);
    }
  }, [Preset]);

  const [BaseDeep, setBaseDeep] = useState(0.16);
  const [LayerDeep, setLayerDeep] = useState(0.08);
  const [MaxLength, setMaxLength] = useState(127);
  const [MaxDeep, setMaxDeep] = useState(2.6);
  const [Quality, setQuality] = useState(4);
  const [AddBorder, setAddBorder] = useState(true);
  const [BorderWidth, setBorderWidth] = useState(2);
  const [BorderHeightExtra, setBorderHeightExtra] = useState(1);

  const [ImageUrlData, setImageUrlData] = useState<string>('');
  const [ImagePreview, setImagePreview] = useState<string>('');
  const fileRequest = (file: any) => {
    const reader = new FileReader();
    if (!file?.originFile) {
      setImageUrlData('');
    } else {
      reader.readAsDataURL(file.originFile);
      reader.onload = (event) => {
        const fileDataUrl = event.target?.result as string;
        setImageUrlData(fileDataUrl);
        file.percent = 100;
        file.status = 'done';
      };
    }
  };

  const [ParamOnReady, setParamOnReady] = useState(false);
  useEffect(() => {
    const numerReady = [
      BaseDeep && LayerDeep && MaxLength && MaxDeep && Quality,
    ].every((i: number) => i >= 0);
    let borderReady = !AddBorder;
    if (AddBorder) {
      borderReady = [BorderWidth && BorderHeightExtra].every(
        (i: number) => i >= 0
      );
    }
    setParamOnReady(Boolean(numerReady && borderReady && ImageUrlData));

    setDataDeep('');
    setScadFile('');
    setProgress(0);
    setProgressInfo('');
  }, [
    BaseDeep,
    LayerDeep,
    MaxLength,
    MaxDeep,
    Quality,
    AddBorder,
    BorderWidth,
    BorderHeightExtra,
    ImageUrlData,
  ]);

  const [ProgressData, setProgress] = useState(0);
  const [ProgressText, setProgressInfo] = useState('');

  // 生成中
  const [LoadingImage, setLoadingImage] = useState(false);
  // 深度图
  const [DataDeep, setDataDeep] = useState('');
  // scad
  const [ScadFile, setScadFile] = useState('');
  useEffect(() => {
    setLoadingImage(Boolean(DataDeep) && Boolean(ScadFile));
  }, [DataDeep, ScadFile]);

  const generateDataDeep = async () => {
    const dataDeepMapDat = await getDataDeep(
      ImageUrlData,
      {
        BaseDeep,
        LayerDeep,
        MaxLength,
        MaxDeep,
        Quality,
        AddBorder,
        BorderWidth,
        BorderHeightExtra,
      },
      setProgress,
      setProgressInfo,
      setImagePreview
    );
    setProgressInfo('生成DataDeep文件');
    setProgress(90);
    setDataDeep(dataDeepMapDat);
    setProgressInfo('生成Scad文件');
    setProgress(95);
    const dataScad = getScad(Quality);
    setScadFile(dataScad);
    setProgressInfo('成功');
    setProgress(100);
  };

  return (
    <div className="config">
      {/* <h3 className="header"></h3> */}
      <List
        style={{ width: '80vw' }}
        size={'large'}
        header="填写参数生成数据文件"
      >
        <List.Item>
          <div className="title">使用哪种预设</div>
          <div className="describe">
            使用预设，直接下载对应3mf,替换模型后切片打印
          </div>
          <div className="content">
            <RadioGroup
              type="button"
              name="lang"
              defaultValue={PresetMode.default}
              value={Preset}
              style={{ marginRight: 20, marginBottom: 20 }}
              onChange={(e: keyof typeof PresetMode) => {
                setPreset(PresetMode[e]);
              }}
            >
              <Radio value={PresetMode.default}>0.4喷嘴标准配置</Radio>
              <Radio value={PresetMode.precision}>0.2喷嘴高细腻配置</Radio>
              <Radio value={PresetMode.custom}>自定义配置</Radio>
            </RadioGroup>
          </div>
        </List.Item>

        <List.Item>
          <div className="title">首层层高(mm)</div>
          <div className="describe">
            打印机中的设置必须和此处严格一致，设置这里，再修改打印机
          </div>
          <div className="content">
            {Preset !== PresetMode.custom ? (
              <div style={{ width: 300, marginRight: 10 }}>
                使用3mf预设,不需要调整
              </div>
            ) : null}

            <InputNumber
              style={{ margin: '10px 24px 10px 0' }}
              size="large"
              mode="button"
              suffix="mm"
              disabled={Preset !== PresetMode.custom}
              max={2}
              min={0.04}
              step={0.04}
              precision={2}
              value={BaseDeep}
              onChange={(value) => {
                setBaseDeep(value);
              }}
            />
          </div>
        </List.Item>

        <List.Item>
          <div className="title">单层层高(mm) </div>
          <div className="describe">
            打印机中的设置必须和此处严格一致，设置这里，再修改打印机
          </div>
          <div className="content">
            {Preset !== PresetMode.custom ? (
              <div style={{ width: 300, marginRight: 10 }}>
                使用3mf预设,不需要调整
              </div>
            ) : null}
            <InputNumber
              style={{ margin: '10px 24px 10px 0' }}
              size="large"
              mode="button"
              suffix="mm"
              disabled={Preset !== PresetMode.custom}
              max={1}
              min={0.04}
              step={0.02}
              precision={2}
              value={LayerDeep}
              onChange={(value) => {
                setLayerDeep(value);
              }}
            />
          </div>
        </List.Item>

        <List.Item>
          <div className="title">成像区域长边长度(mm) </div>
          <div className="describe">不含边框，短边会自动缩放适应</div>
          <div className="content">
            <InputNumber
              style={{ margin: '10px 24px 10px 0' }}
              size="large"
              mode="button"
              suffix="mm"
              max={1000}
              min={1}
              step={1}
              precision={1}
              value={MaxLength}
              onChange={(value) => {
                setMaxLength(value);
              }}
            />
          </div>
        </List.Item>

        <List.Item>
          <div className="title">成像区域最大厚度(mm)</div>
          <div className="describe">
            包括首层，不含边框，请根据自己的材料透光性设置
          </div>
          <div className="content">
            <InputNumber
              style={{ margin: '10px 24px 10px 0' }}
              size="large"
              mode="button"
              suffix="mm"
              max={20}
              min={1}
              step={0.5}
              precision={1}
              value={MaxDeep}
              onChange={(value) => {
                setMaxDeep(value);
              }}
            />
          </div>
        </List.Item>

        <List.Item>
          <div className="title">精细度(整数)</div>
          <div className="describe">
            每mm有多少个像素,和打印机的xy分辨率有关
          </div> 
          <div className="describe">
            建议A1/P1/X1 设置分别为: 4/8/10
            ,不建议过高,和打印机的,质量-精度-分辨率,有关
          </div>
          <div className="describe">
            增加模型精细程度，会导致OpenScad生成Stl的时间和切片时间大幅上升
          </div>
          <div className="content">
            <InputNumber
              style={{ margin: '10px 24px 10px 0' }}
              size="large"
              mode="button"
              max={100}
              min={1}
              step={1}
              precision={0}
              value={Quality}
              onChange={(value) => {
                setQuality(value);
              }}
            />
          </div>
        </List.Item>

        <List.Item>
          <div className="title">是否开启边框</div>
          <div className="describe">在边缘生成一圈边框</div>
          <div className="content">
            <Switch
              type="round"
              checked={AddBorder}
              onChange={(value) => {
                setAddBorder(value);
              }}
            />
          </div>
        </List.Item>
        {AddBorder ? (
          <>
            <List.Item>
              <div className="title">边框宽度(mm)</div>
              <div className="describe">这个不用解释吧</div>
              <div className="content">
                <InputNumber
                  style={{ margin: '10px 24px 10px 0' }}
                  size="large"
                  mode="button"
                  max={10}
                  min={0.1}
                  step={0.1}
                  precision={1}
                  value={BorderWidth}
                  onChange={(value) => {
                    setBorderWidth(value);
                  }}
                />
              </div>
            </List.Item>

            <List.Item>
              <div className="title">边框附加高度(mm)</div>
              <div className="describe">边框比最大厚度更厚x mm</div>
              <div className="content">
                <InputNumber
                  style={{ margin: '10px 24px 10px 0' }}
                  size="large"
                  mode="button"
                  max={10}
                  min={0}
                  step={0.1}
                  precision={0}
                  value={BorderHeightExtra}
                  onChange={(value) => {
                    setBorderHeightExtra(value);
                  }}
                />
              </div>
            </List.Item>
          </>
        ) : null}
        <List.Item>
          <div className="title">选择图像</div>
          <div className="describe">上传图片文件，支持jpg/png/jpeg</div>
          <div className="">
            <Upload
              style={{ width: '100%' }}
              drag
              // multiple
              accept="image/*"
              listType="text"
              limit={1}
              onChange={(e) => {
                fileRequest(e[0]);
                e[0].percent = 100;
                e[0].status = 'done';
              }}
              tip="仅支持图片"
            />
            {ImageUrlData ? (
              <div>
                <div className="title">预览图</div>
                <div className="describe">并非效果图</div>
                {/* eslint-disable-next-line jsx-a11y/alt-text */}
                <img className="previewImage" src={ImageUrlData} />
              </div>
            ) : null}
          </div>
        </List.Item>

        <List.Item>
          <div className="title">生成dat数据</div>
          <div className="describe">检查配置无误后开始生成</div>
          <div className="content">
            <Button
              style={{ width: '100%', height: '50px' }}
              disabled={!ParamOnReady}
              type="primary"
              onClick={generateDataDeep}
            >
              生成dat数据
            </Button>
          </div>
        </List.Item>

        <List.Item>
          <div className="title">生成进度</div>
          <div className="describe">修改配置会清空数据缓存</div>
          <div className="content">
            <Progress
              percent={ProgressData}
              color="#5289e9"
              formatText={() => ProgressText}
              // style={{ marginBottom: 20 }}
            />
          </div>
        </List.Item>

        <List.Item>
          <div className="title">下载dat文件</div>
          <div className="describe">每次生成后下载新的数据文件</div>
          <div className="describe">
            下载文件之前,记得吧旧文件删了,要不文件名多个(n),会读到旧文件上
          </div>
          <div className="content">
            <Button
              style={{ width: '100%', height: '50px' }}
              disabled={!LoadingImage}
              type="primary"
              onClick={() => {
                downloadFile(DataDeep, 'DataDeep.dat');
              }}
            >
              下载dat文件
            </Button>
          </div>
        </List.Item>

        <List.Item>
          <div className="title">下载scad文件</div>
          <div className="describe">
            修改精细度后需要下载新的scad，不修改精细度不需要更新
          </div>
          <div className="content">
            <Button
              style={{ width: '100%', height: '50px' }}
              disabled={!LoadingImage}
              type="primary"
              onClick={() => {
                downloadFile(ScadFile, 'photo2stl.scad');
              }}
            >
              下载scad文件
            </Button>
          </div>
        </List.Item>
      </List>

      <div className="bottom"></div>
    </div>
  );
}

export default Config;
