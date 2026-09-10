import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { AuthProvider } from './Auth.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode><AuthProvider><App /></AuthProvider></React.StrictMode>
);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}
