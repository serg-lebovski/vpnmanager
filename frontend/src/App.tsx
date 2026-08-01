import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { BridgePage } from './pages/BridgePage';
import { DashboardLayout } from './pages/DashboardLayout';
import { LoginPage } from './pages/LoginPage';
import { OrganizationsPage } from './pages/OrganizationsPage';
import { PeersPage } from './pages/PeersPage';
import { ServersPage } from './pages/ServersPage';
import { UsersPage } from './pages/UsersPage';

export default function App() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<DashboardLayout />}>
          <Route path="/" element={<PeersPage />} />
          <Route element={<ProtectedRoute allowedRoles={['super_admin']} />}>
            <Route path="/servers" element={<ServersPage />} />
            <Route path="/organizations" element={<OrganizationsPage />} />
            <Route path="/bridge" element={<BridgePage />} />
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['super_admin', 'org_admin']} />}>
            <Route path="/users" element={<UsersPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
