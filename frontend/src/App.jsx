/**
 * Rutas y proveedores.
 *
 * Las secciones son rutas de verdad, con su URL: el tablero base guardaba la
 * seccion activa en un useState, de modo que no se podia enlazar una vista,
 * el boton de atras no funcionaba y recargar devolvia siempre al inicio.
 *
 * Orden de los proveedores: Router → Auth → Catalogos → Campana → Avisos.
 * Catalogos y Campana dependen de la sesion (solo piden datos cuando hay
 * token), y los avisos deben estar disponibles para todos ellos.
 */
import { Navigate, Route, Routes } from 'react-router-dom';
import AuthProvider from './auth/AuthProvider.jsx';
import PrivateRoute from './auth/PrivateRoute.jsx';
import { CatalogsProvider } from './hooks/useCatalogs.js';
import { CampaignProvider } from './hooks/useCampaign.js';
import { ToastProvider } from './components/ToastSystem.jsx';
import Layout from './components/Layout.jsx';

import OverviewPage from './pages/OverviewPage.jsx';
import SentimentPage from './pages/SentimentPage.jsx';
import ContendersPage from './pages/ContendersPage.jsx';
import AgendaPage from './pages/AgendaPage.jsx';
import ContentPage from './pages/ContentPage.jsx';
import AlertsPage from './pages/AlertsPage.jsx';
import ReviewPage from './pages/ReviewPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import CallbackPage from './pages/CallbackPage.jsx';
import UnauthorizedPage from './pages/UnauthorizedPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';

// Roles que el backend reconoce para escribir. Se usan como comodidad de
// interfaz; la autorizacion real la aplica cada servicio contra el token.
const WRITE_ROLES = ['analyst', 'strategist', 'admin', 'owner'];

export function App() {
  return (
    <AuthProvider>
      <CatalogsProvider>
        <CampaignProvider>
          <ToastProvider>
            <Routes>
              <Route path="/acceso" element={<LoginPage />} />
              <Route path="/callback" element={<CallbackPage />} />
              <Route path="/sin-permiso" element={<UnauthorizedPage />} />

              <Route
                element={(
                  <PrivateRoute>
                    <Layout />
                  </PrivateRoute>
                )}
              >
                <Route path="/" element={<Navigate to="/resumen" replace />} />
                <Route path="/resumen" element={<OverviewPage />} />
                <Route path="/sentimiento" element={<SentimentPage />} />
                <Route path="/contendientes" element={<ContendersPage />} />
                <Route path="/agenda" element={<AgendaPage />} />
                <Route path="/contenidos" element={<ContentPage />} />
                <Route path="/alertas" element={<AlertsPage />} />
                <Route
                  path="/revision"
                  element={(
                    <PrivateRoute requiredRoles={WRITE_ROLES}>
                      <ReviewPage />
                    </PrivateRoute>
                  )}
                />
                <Route path="/informes" element={<ReportsPage />} />
                <Route path="/ajustes" element={<SettingsPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </ToastProvider>
        </CampaignProvider>
      </CatalogsProvider>
    </AuthProvider>
  );
}

export default App;
