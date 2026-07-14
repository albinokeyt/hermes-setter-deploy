import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { bootstrapSso } from './sso.js';
import './styles.css';

const root = ReactDOM.createRoot(document.getElementById('root'));

function Splash({ text }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter, system-ui, sans-serif', color: '#64748b', fontSize: 14 }}>
      {text}
    </div>
  );
}

function renderApp() {
  root.render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>
  );
}

async function main() {
  // Si estamos embebidos en GHL (Custom Page), intentamos SSO antes de arrancar
  // para no mostrar el login: la identidad la certifica GHL, no la URL.
  try {
    if (window.self !== window.top) {
      root.render(<Splash text="Conectando con GoHighLevel…" />);
      const r = await bootstrapSso();
      if (r === 'fail') {
        root.render(<Splash text="No pudimos verificar tu identidad con GoHighLevel. Recarga la página o contacta con la agencia." />);
        return;
      }
    }
  } catch {}
  renderApp();
}

main();
