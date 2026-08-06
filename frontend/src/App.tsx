import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { BackendStatusBanner } from './components/BackendStatusBanner';
import { AuditLogPage } from './pages/AuditLogPage';
import { BridgePage } from './pages/BridgePage';
import { ClientDetailPage } from './pages/ClientDetailPage';
import { DashboardLayout } from './pages/DashboardLayout';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { OrganizationsPage } from './pages/OrganizationsPage';
import { PeersPage } from './pages/PeersPage';
import { ServersPage } from './pages/ServersPage';
import { SettingsPage } from './pages/SettingsPage';
import { UsersPage } from './pages/UsersPage';

export default function App() {
  const { user } = useAuth();

  return (
    <>
      <BackendStatusBanner />
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />

        <Route element={<ProtectedRoute />}>
          <Route element={<DashboardLayout />}>
            <Route path="/" element={<PeersPage />} />
            <Route element={<ProtectedRoute allowedRoles={['super_admin']} />}>
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/servers" element={<ServersPage />} />
              <Route path="/organizations" element={<OrganizationsPage />} />
              <Route path="/organizations/:id" element={<ClientDetailPage />} />
              <Route path="/bridge" element={<BridgePage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/audit-log" element={<AuditLogPage />} />
            </Route>
            <Route element={<ProtectedRoute allowedRoles={['super_admin', 'org_admin']} />}>
              <Route path="/users" element={<UsersPage />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
