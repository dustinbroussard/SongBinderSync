/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import MainLayout from "./pages/MainLayout";
import SongsLibrary from "./pages/SongsLibrary";
import SetlistsManager from "./pages/SetlistsManager";
import SetlistDetail from "./pages/SetlistDetail";
import SongEditor from "./pages/SongEditor";
import PerformanceMode from "./pages/PerformanceMode";
import SignIn from "./pages/SignIn";
import { ThemeProvider } from "./components/ThemeProvider";
import { InstallPrompt } from "./components/InstallPrompt";
import { AuthProvider } from "./components/AuthProvider";
import { ToastProvider } from "./components/ToastProvider";
import { ErrorBoundary } from "./components/ErrorBoundary";

export default function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/signin" element={<SignIn />} />
                <Route path="/" element={<MainLayout />}>
                  <Route index element={<SongsLibrary />} />
                  <Route path="setlists" element={<SetlistsManager />} />
                  <Route path="setlists/:id" element={<SetlistDetail />} />
                </Route>
                <Route path="/song/:id" element={<SongEditor />} />
                <Route path="/performance/:mode/:id" element={<PerformanceMode />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
              <InstallPrompt />
            </BrowserRouter>
          </ToastProvider>
        </AuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
