import { StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { App } from './pages/App.js';

const root = document.getElementById('root');
if (!root) {
  throw new Error('client: #root not found in DOM');
}

hydrateRoot(
  root,
  <StrictMode>
    <App pathname={window.location.pathname} />
  </StrictMode>,
);
