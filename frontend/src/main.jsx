/** Punto de entrada. */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { applyBrandTheme, brand } from './config/brand.js';
import './styles/design-system.css';
import './styles/app.css';

// El tema ya lo fijo el script en linea de index.html; aqui solo se inyectan
// los colores de marca, que pueden venir del entorno.
applyBrandTheme();
document.title = `${brand.productName} · ${brand.tagline}`;

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
