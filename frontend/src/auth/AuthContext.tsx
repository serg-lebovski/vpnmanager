import { createContext, ReactNode, useContext, useState } from 'react';
import { login as loginRequest } from '../api/auth';
import { AuthUser } from '../api/types';
import { tokenStorage } from './tokenStorage';

interface AuthContextValue {
  user: AuthUser | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(tokenStorage.getUser());

  async function login(email: string, password: string) {
    const response = await loginRequest(email, password);
    tokenStorage.setSession(response.accessToken, response.refreshToken, response.user);
    setUser(response.user);
  }

  function logout() {
    tokenStorage.clear();
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth должен использоваться внутри AuthProvider');
  }
  return ctx;
}
