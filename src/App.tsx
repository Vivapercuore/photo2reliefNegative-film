import React from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import Home from './Home';
import Relief from './relief/Relief';
import LaserCut from './laser/LaserCut';
import ColorPositive from './colorPositive/ColorPositive';
import ColorCmyk from './colorCmyk/ColorCmyk';
import './App.css';

function App() {
  return (
    <div className="App">
      <HashRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/photo2relief" element={<Relief />} />
          <Route path="/lac2model" element={<LaserCut />} />
          <Route path="/color-positive" element={<ColorPositive />} />
          <Route path="/color-cmyk" element={<ColorCmyk />} />
        </Routes>
      </HashRouter>
    </div>
  );
}

export default App;
