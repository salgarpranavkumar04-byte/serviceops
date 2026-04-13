/**
 * pages/ConversationsPage.jsx
 */

import { useMemo, useState } from 'react';
import { api }   from '../services/api';
import { useApi } from '../hooks/useApi';
import Alert     from '../components/ui/Alert';
import Btn       from '../components/ui/Btn';
import Card      from '../components/ui/Card';
import { TH, TD } from '../components/ui/Table';
import fmt       from '../utils/fmt';

const inputStyle = {
  background: '#ffffff',
  border: '1px solid #d1d5db',
  borderRadius: 3,
  padding: '7px 10px',
  fontSize: 13,
  color: '#111827',
  outline: 'none',
};

export default function ConversationsPage() {
  const [roleF, setRoleF]   = useState('');
  const [search, setSearch] = useState('');

  const { data, loading, error, refresh } = useApi(
    () => api.get('/admin/conversations'),
    { pollInterval: 15_000 }
  );

  const convs = useMemo(() => {
    let l = data?.conversations || [];
    if (roleF) l = l.filter((c) => c.role === roleF);
    if (search) {
      const q = search.toLowerCase();
      l = l.filter((c) =>
        (c.name  || '').toLowerCase().includes(q) ||
        (c.phone || '').includes(q)
      );
    }
    return l;
  }, [data, search, roleF]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 }}>Conversations</h2>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
            {loading ? 'Loading…' : `${convs.length} active sessions`}
          </div>
        </div>
        <Btn v="secondary" size="sm" onClick={refresh}>↻ Refresh</Btn>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or phone…"
          style={{ ...inputStyle, flex: 1, minWidth: 200 }}
        />
        <select
          value={roleF}
          onChange={(e) => setRoleF(e.target.value)}
          style={{ ...inputStyle, minWidth: 150 }}
        >
          <option value="">All Roles</option>
          <option value="customer">Customers</option>
          <option value="technician">Technicians</option>
        </select>
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="pulse" style={{ height: 52, background: '#e5e7eb', borderRadius: 3 }} />
          ))}
        </div>
      ) : error ? (
        <Alert type="error">{error}</Alert>
      ) : convs.length === 0 ? (
        <Card>
          <div style={{ textAlign: 'center', padding: '36px 0', color: '#9ca3af' }}>No active conversations</div>
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <TH>Name</TH>
                  <TH>Phone</TH>
                  <TH>Role</TH>
                  <TH>State</TH>
                  <TH>Last Message</TH>
                  <TH>Last Active</TH>
                </tr>
              </thead>
              <tbody>
                {convs.map((c, i) => (
                  <tr key={c.id} style={{ borderBottom: '1px solid #e5e7eb', background: i % 2 === 0 ? '#ffffff' : '#fafafa' }}>
                    <TD>
                      <div style={{ fontWeight: 600, color: '#111827' }}>{c.name || '—'}</div>
                    </TD>
                    <TD mono style={{ fontSize: 12 }}>{c.phone}</TD>
                    <TD>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 3,
                        background: c.role === 'customer' ? '#dbeafe' : '#fef9c3',
                        color: c.role === 'customer' ? '#1e40af' : '#78350f',
                        border: c.role === 'customer' ? '1px solid #93c5fd' : '1px solid #fde047',
                      }}>
                        {c.role}
                      </span>
                    </TD>
                    <TD style={{ fontSize: 12, color: '#374151' }}>{fmt.cap(c.state)}</TD>
                    <TD style={{ fontSize: 12, color: '#6b7280', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.lastMsg || '—'}
                    </TD>
                    <TD style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>{fmt.dt(c.lastAt)}</TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
