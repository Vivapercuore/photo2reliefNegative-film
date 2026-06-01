import React from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import Home from './Home';
import Config from './config';
import LaserCut from './laser/LaserCut';
import './App.css';

function App() {
  return (
    <div className="App">
      <HashRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/photo2relief" element={<Config />} />
          <Route path="/lac2model" element={<LaserCut />} />
        </Routes>
      </HashRouter>
    </div>
  );
}

export default App;
