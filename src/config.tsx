/*
 * @Author: error: error: git config user.name & please set dead value or install git && error: git config user.email & please set dead value or install git & please set dead value or install git
 * @Date: 2024-06-25 22:47:01
 * @LastEditors: error: error: git config user.name & please set dead value or install git && error: git config user.email & please set dead value or install git & please set dead value or install git
 * @LastEditTime: 2024-06-26 02:18:08
 * @FilePath: \photo2reliefNegativeFilm\src\config.tsx
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import React from "react";
import "./config.css";
import { List, Radio, InputNumber } from "@arco-design/web-react";

function Config() {
  return (
    <div className="config">
      <h3 className="header"></h3>
      <List style={{ width: '80vw' }} size={"large"} header="填写参数生成数据文件">
        <List.Item>
          <div className="title">使用哪种预设</div>
          <div className="describe">
            使用预设，直接下载对应3mf,替换模型后切片打印
          </div>
          <div className="content">
            0.4喷嘴标准配置 0.2喷嘴高细腻配置 自定义配置
          </div>
        </List.Item>

        <List.Item>
          <div className="title">首层层高(mm)</div>
          <div className="describe">
            打印机中的设置必须和此处严格一致，设置这里，再修改打印机
          </div>
          <div className="content">0.2</div>
        </List.Item>

        <List.Item>
          <div className="title">单层层高(mm) </div>
          <div className="describe">
            打印机中的设置必须和此处严格一致，设置这里，再修改打印机
          </div>
          <div className="content">0.08</div>
        </List.Item>

        <List.Item>
          <div className="title">成像区域长边长度(mm) </div>
          <div className="describe">不含边框，短边会自动缩放适应</div>
          <div className="content">127</div>
        </List.Item>

        <List.Item>
          <div className="title">成像区域最大厚度(mm)</div>
          <div className="describe">
            包括首层，不含边框，请根据自己的材料透光性设置
          </div>
          <div className="content"></div>
        </List.Item>


        <List.Item>
          <div className="title">精细度</div>
          <div className="describe">增加模型精细程度，会导致OpenScad生成Stl的时间和切片时间大幅上升</div>
          <div className="content"></div>
        </List.Item>

        <List.Item>
          <div className="title">是否开启边框</div>
          <div className="describe">在边缘生成一圈边框</div>
          <div className="content"></div>
        </List.Item>

        <List.Item>
          <div className="title">边框宽度(mm)</div>

          <div className="content"></div>
        </List.Item>

        <List.Item>
          <div className="title">边框附加高度(mm)</div>
          <div className="describe">
          边框比最大厚度更厚x mm 
          </div>
          <div className="content"></div>
        </List.Item>

        <List.Item>
          <div className="title">选择图像</div>
          <div className="describe">
            上传图片文件，支持jpg/png/jpeg
          </div>
          <div className="content"></div>
        </List.Item>


        <List.Item>
          <div className="title">生成dat数据</div>
          <div className="describe">
            检查配置无误后开始生成
          </div>
          <div className="content"></div>
        </List.Item>

        <List.Item>
          <div className="title">生成进度</div>
          <div className="describe">
            修改配置会清空数据缓存
          </div>
          <div className="content"></div>
        </List.Item>


        <List.Item>
          <div className="title">下载dat文件</div>
          <div className="describe">
            每次生成后下载新的数据文件
          </div>
          <div className="content"></div>
        </List.Item>

        <List.Item>
          <div className="title">下载scad</div>
          <div className="describe">
            修改精细度后需要下载新的scad，不修改精细度不需要更新
          </div>
          <div className="content"></div>
        </List.Item>

      </List>

      <div className="bottom"></div>
    </div>
  );
}

export default Config;
