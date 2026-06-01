import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';
import "@arco-design/web-react/dist/css/arco.css";

// "ResizeObserver loop completed with undelivered notifications" is a benign
// browser notice (no event is lost, nothing breaks). CRA's dev error overlay
// otherwise surfaces it as an uncaught runtime error. Swallow just this one
// message so it doesn't trigger the red overlay; everything else is untouched.
const RESIZE_OBSERVER_MSG = 'ResizeObserver loop';
window.addEventListener('error', (e) => {
  if (e.message && e.message.includes(RESIZE_OBSERVER_MSG)) {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
});

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
document.body.setAttribute('arco-theme', 'dark');
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
