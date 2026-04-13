/**
 * pages/SettingsPage.jsx
 */

import { useState } from 'react';
import { api }   from '../services/api';
import { useApi } from '../hooks/useApi';
import Alert     from '../components/ui/Alert';
import Btn       from '../components/ui/Btn';
import Card      from '../components/ui/Card';
import { SMETA, SETTING_GROUPS } from '../constants/statusStyles';

const inputStyle = {
  background: '#ffffff',
  border: '1px solid #d1d5db',
  borderRadius: 3,
  padding: '7px 10px',
  fontSize: 13,
  color: '#111827',
  outline: 'none',
  width: '100%',
};

function SettingRow({ label, description, unit, isBoolean, value, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const startEdit = () => {
    setDraft(value ?? '');
    setEditing(true);
    setError('');
  };

  const save = async () => {
    setLoading(true);
    setError('');
    const r = await onSave(draft);
    setLoading(false);
    if (r.ok) {
      setEditing(false);
    } else {
      setError(r.error || 'Save failed');
    }
  };

  return (
    <div style={{ borderBottom: '1px solid #e5e7eb', padding: '12px 0' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, color: '#111827', fontSize: 13 }}>
            {label} {unit && <span style={{ color: '#9ca3af', fontWeight: 400 }}>({unit})</span>}
          </div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{description}</div>
          {error && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 4 }}>{error}</div>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {editing ? (
            <>
              {isBoolean ? (
                <select value={draft} onChange={(e) => setDraft(e.target.value)} style={{ ...inputStyle, width: 100 }}>
                  <option value="true">Enabled</option>
                  <option value="false">Disabled</option>
                </select>
              ) : (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
                  style={{ ...inputStyle, width: 130 }}
                />
              )}
              <Btn v="primary" size="sm" loading={loading} onClick={save}>Save</Btn>
              <Btn v="secondary" size="sm" onClick={() => setEditing(false)}>Cancel</Btn>
            </>
          ) : (
            <>
              <span style={{ fontFamily: 'monospace', fontWeight: 700, color: '#111827', fontSize: 14, minWidth: 60, textAlign: 'right' }}>
                {isBoolean ? (value === 'true' ? 'Enabled' : 'Disabled') : (value ?? '—')}
                {!isBoolean && unit ? ` ${unit}` : ''}
              </span>
              <Btn v="ghost" size="sm" onClick={startEdit}>Edit</Btn>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [toast, setToast] = useState(null);

  const { data, loading, error, refresh } = useApi(() => api.get('/admin/settings'));
  const settings = data?.settings || {};

  const showToast = (type, msg) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3000);
  };

  const handleSave = (key) => async (value) => {
    const r = await api.patch(`/admin/settings/${key}`, { value });
    if (r.ok) { refresh(); showToast('success', `${SMETA[key]?.l || key} updated`); }
    else showToast('error', r.error);
    return r;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 }}>Settings</h2>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>System configuration</div>
        </div>
        <Btn v="secondary" size="sm" onClick={refresh}>↻ Refresh</Btn>
      </div>

      {toast && <Alert type={toast.type} onClose={() => setToast(null)}>{toast.msg}</Alert>}

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="pulse" style={{ height: 56, background: '#e5e7eb', borderRadius: 3 }} />
          ))}
        </div>
      ) : error ? (
        <Alert type="error">{error}</Alert>
      ) : (
        SETTING_GROUPS.map((group) => (
          <Card key={group.title}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
              {group.title}
            </div>
            {group.keys.map((key) => {
              const meta = SMETA[key] || { l: key, u: '', d: '' };
              return (
                <SettingRow
                  key={key}
                  label={meta.l}
                  description={meta.d}
                  unit={meta.u}
                  isBoolean={meta.bool}
                  value={settings[key]}
                  onSave={handleSave(key)}
                />
              );
            })}
          </Card>
        ))
      )}
    </div>
  );
}
