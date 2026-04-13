/**
 * layouts/AppShell.jsx
 */

import { useState } from 'react';
import Sidebar, { NAV } from './Sidebar';
import DashboardPage     from '../pages/DashboardPage';
import JobsPage          from '../pages/JobsPage';
import TechniciansPage   from '../pages/TechniciansPage';
import WalletsPage       from '../pages/WalletsPage';
import ConversationsPage from '../pages/ConversationsPage';
import SettingsPage      from '../pages/SettingsPage';

const PAGES = {
  dashboard:     DashboardPage,
  jobs:          JobsPage,
  technicians:   TechniciansPage,
  wallets:       WalletsPage,
  conversations: ConversationsPage,
  settings:      SettingsPage,
};

const SIDEBAR_W = 210;

export default function AppShell() {
  const [page, setPage]         = useState('dashboard');
  const [sideOpen, setSideOpen] = useState(false);

  const PageComponent = PAGES[page] || (() => <div>Not found</div>);

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#f9fafb', overflow: 'hidden', fontFamily: "'Times New Roman', Times, serif" }}>

      {/* Desktop sidebar */}
      <div style={{
        width: SIDEBAR_W,
        flexShrink: 0,
        background: '#ffffff',
        borderRight: '1px solid #e5e7eb',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        zIndex: 10,
      }}>
        <Sidebar page={page} setPage={setPage} />
      </div>

      {/* Mobile overlay */}
      {sideOpen && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 40 }}
            onClick={() => setSideOpen(false)}
          />
          <div style={{
            position: 'fixed', top: 0, left: 0, height: '100%', width: 220,
            background: '#ffffff', borderRight: '1px solid #e5e7eb',
            zIndex: 50, display: 'flex', flexDirection: 'column',
          }}>
            <Sidebar page={page} setPage={setPage} onClose={() => setSideOpen(false)} />
          </div>
        </>
      )}

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Top bar */}
        <div style={{
          borderBottom: '1px solid #e5e7eb',
          padding: '0 20px',
          height: 50,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: '#ffffff',
          flexShrink: 0,
        }}>
          {/* Mobile menu button */}
          <button
            className="mobile-menu"
            onClick={() => setSideOpen(true)}
            style={{
              display: 'none',
              background: 'none',
              border: 'none',
              color: '#6b7280',
              cursor: 'pointer',
              fontSize: 18,
              padding: 0,
              fontFamily: 'inherit',
            }}
          >☰</button>

          <div style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>
            {NAV.find((n) => n.id === page)?.label || page}
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#059669' }} title="API key active" />
            <span style={{ fontSize: 11, color: '#9ca3af' }}>Connected</span>
          </div>
        </div>

        {/* Page content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>
          <div style={{ maxWidth: 1140, margin: '0 auto' }}>
            <PageComponent />
          </div>
        </div>
      </div>
    </div>
  );
}
