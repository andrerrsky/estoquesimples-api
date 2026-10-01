import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@estoquesimples/design/tokens.css';

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <div>Estoque Simples</div>
  </StrictMode>,
);
