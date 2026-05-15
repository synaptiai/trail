import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import '@/design/fonts.css';
import '@/design/tokens.css';
import '@/design/global.css';
import '@/design/motion.css';

const container = document.getElementById('root');
if (!container) throw new Error('Trail UI: #root element missing from index.html');
const root = createRoot(container);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
