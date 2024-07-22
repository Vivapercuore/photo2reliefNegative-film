/*
 * @Author: chenguofeng chenguofeng@bytedance.com
 * @Date: 2024-06-26 03:42:59
 * @LastEditors: chenguofeng chenguofeng@bytedance.com
 * @LastEditTime: 2024-07-20 22:12:51
 * @FilePath: \photo2reliefNegativeFilm\src\App.tsx
 * @Description: 这是默认设置,请设置`customMade`, 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 */
import React from 'react';
import './App.css';
import Config from './config';

function App() {
  return (
    <div className="App">
      <header className="App-header">
        打印机，就该用来打照片！
      </header>
      <Config/>
    </div>
  );
}

export default App;
