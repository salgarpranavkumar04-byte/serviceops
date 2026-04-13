/**
 * layouts/Sidebar.jsx
 */

import { clearApiKey } from '../services/api';

export const NAV = [
  { id: 'dashboard',     label: 'Dashboard',      icon: '▤' },
  { id: 'jobs',          label: 'Jobs',            icon: '⚙' },
  { id: 'technicians',   label: 'Technicians',     icon: '◉' },
  { id: 'wallets',       label: 'Wallets',         icon: '₹' },
  { id: 'conversations', label: 'Conversations',   icon: '◈' },
  { id: 'settings',      label: 'Settings',        icon: '◧' },
];

export default function Sidebar({ page, setPage, onClose }) {
  const handleNav = (id) => {
    setPage(id);
    onClose?.();
  };

  const handleLogout = () => {
    clearApiKey();
    window.location.reload();
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      fontFamily: "'Times New Roman', Times, serif",
    }}>
      {/* Logo */}
      <div style={{
        padding: '18px 20px',
        borderBottom: '1px solid #e5e7eb',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>ServiceOps</div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>Admin Dashboard</div>
      </div>

      {/* Nav links */}
      <nav style={{ flex: 1, padding: '10px 0', overflowY: 'auto' }}>
        {NAV.map((item) => {
          const active = page === item.id;
          return (
            <button
              key={item.id}
              onClick={() => handleNav(item.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                padding: '10px 20px',
                border: 'none',
                background: active ? '#f3f4f6' : 'transparent',
                color: active ? '#111827' : '#6b7280',
                fontSize: 14,
                fontWeight: active ? 700 : 400,
                cursor: 'pointer',
                textAlign: 'left',
                borderLeft: active ? '3px solid #111827' : '3px solid transparent',
                fontFamily: "'Times New Roman', Times, serif",
              }}
            >
              <span style={{ fontSize: 15, width: 18, textAlign: 'center', flexShrink: 0 }}>{item.icon}</span>
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Footer */}
      <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', flexShrink: 0 }}>
        <button
          onClick={handleLogout}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: 'none',
            border: 'none',
            color: '#9ca3af',
            fontSize: 13,
            cursor: 'pointer',
            padding: '4px 0',
            fontFamily: "'Times New Roman', Times, serif",
          }}
        >
          ⏏ Change API Key
        </button>
      </div>
    </div>
  );
}
