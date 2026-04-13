/**
 * App.jsx
 * Auth: API key stored in localStorage. Missing key → SetupPage.
 */

import { useState, useEffect } from 'react';
import { isApiKeySet, setUnauthorizedHandler, clearApiKey } from './services/api';
import AppShell  from './layouts/AppShell';
import SetupPage from './pages/SetupPage';

export default function App() {
  const [configured, setConfigured] = useState(null); // null = checking

  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearApiKey();
      setConfigured(false);
    });
    setConfigured(isApiKeySet());
  }, []);

  if (configured === null) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f9fafb',
        fontFamily: "'Times New Roman', Times, serif",
        color: '#9ca3af',
        fontSize: 14,
      }}>
        Loading…
      </div>
    );
  }

  if (!configured) {
    return <SetupPage onConfigured={() => setConfigured(true)} />;
  }

  return <AppShell />;
}
