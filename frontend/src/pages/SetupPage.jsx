/**
 * pages/SetupPage.jsx — API key configuration screen
 */

import { useState } from 'react';
import { saveApiKey } from '../services/api';

export default function SetupPage({ onConfigured }) {
  const [key, setKey]       = useState('');
  const [error, setError]   = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) { setError('API key is required'); return; }
    saveApiKey(trimmed);
    onConfigured();
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#f9fafb',
    }}>
      <div style={{
        width: '100%',
        maxWidth: 400,
        background: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: 4,
        padding: 32,
      }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: '0 0 6px 0' }}>
            ServiceOps Admin
          </h1>
          <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
            Enter your API key to access the admin dashboard.
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                API Key
              </label>
              <input
                type="password"
                value={key}
                onChange={(e) => { setKey(e.target.value); setError(''); }}
                placeholder="Enter admin API key"
                autoFocus
                style={{
                  width: '100%',
                  background: '#ffffff',
                  border: `1px solid ${error ? '#fca5a5' : '#d1d5db'}`,
                  borderRadius: 3,
                  padding: '9px 12px',
                  fontSize: 13,
                  color: '#111827',
                  outline: 'none',
                }}
              />
              {error && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 5 }}>{error}</div>}
            </div>

            <button
              type="submit"
              style={{
                background: '#111827',
                color: '#ffffff',
                border: 'none',
                borderRadius: 3,
                padding: '10px 0',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
                width: '100%',
              }}
            >
              Access Dashboard
            </button>
          </div>
        </form>

        <div style={{ marginTop: 18, fontSize: 12, color: '#9ca3af', borderTop: '1px solid #e5e7eb', paddingTop: 14 }}>
          The key is stored locally in your browser and sent as <code>x-api-key</code> with each request.
        </div>
      </div>
    </div>
  );
}
