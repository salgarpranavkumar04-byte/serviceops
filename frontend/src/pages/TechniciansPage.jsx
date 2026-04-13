/**
 * pages/TechniciansPage.jsx
 *
 * Features:
 *   - List technicians (GET /admin/technicians)
 *   - Register new technician (POST /admin/technicians/register)
 *   - Toggle verified (PATCH /admin/technicians/:id/verified)
 *   - Change status: AVAILABLE / OFFLINE (PATCH /admin/technicians/:id/status)
 *   - Delete technician (DELETE /admin/technicians/:id)
 *   - Wallet top-up via detail modal
 */

import { useMemo, useState } from 'react';
import { api }      from '../services/api';
import { useApi }   from '../hooks/useApi';
import Alert        from '../components/ui/Alert';
import Btn          from '../components/ui/Btn';
import Card         from '../components/ui/Card';
import Input        from '../components/ui/Input';
import Modal        from '../components/ui/Modal';
import Pager        from '../components/ui/Pager';
import { TH, TD }  from '../components/ui/Table';
import { badgeStyle } from '../constants/statusStyles';
import fmt          from '../utils/fmt';

const inputStyle = {
  background: '#ffffff',
  border: '1px solid #d1d5db',
  borderRadius: 3,
  padding: '7px 10px',
  fontSize: 13,
  color: '#111827',
  outline: 'none',
};

const SERVICE_OPTIONS = [
  { value: 'PLUMBER',     label: 'Plumber'     },
  { value: 'ELECTRICIAN', label: 'Electrician' },
  { value: 'AC_REPAIR',   label: 'AC Repair'   },
];

/* ─── Register Technician Modal ───────────────────────────────────────────── */
function RegisterModal({ open, onClose, onSuccess }) {
  const [form, setForm]       = useState({ name: '', phone: '', service_type: 'PLUMBER' });
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const set = (field) => (e) => {
    setForm((f) => ({ ...f, [field]: e.target.value }));
    setError('');
  };

  const handleClose = () => {
    setForm({ name: '', phone: '', service_type: 'PLUMBER' });
    setError('');
    onClose();
  };

  const handleSubmit = async () => {
    const name  = form.name.trim();
    const phone = form.phone.trim();

    if (!name)  { setError('Name is required');  return; }
    if (!phone) { setError('Phone is required'); return; }
    // Accept 10-digit (6-9XXXXXXXXX) or full 12-digit with country code (91XXXXXXXXXX)
    const digits = phone.replace(/\D/g, '');
    const normalized = digits.length === 12 && digits.startsWith('91')
      ? digits.slice(2)
      : digits;
    if (!/^[6-9]\d{9}$/.test(normalized)) {
      setError('Enter a valid 10-digit Indian mobile number (with or without 91 prefix)');
      return;
    }
    setLoading(true);
    const r = await api.post('/admin/technicians/register', {
      name,
      phone: normalized,
      service_types: [form.service_type],
    });
    setLoading(false);
    if (r.ok) {
      onSuccess(`${name} registered successfully`);
      handleClose();
    } else {
      setError(r.error || 'Registration failed');
    }
  };

  return (
    <Modal open={open} onClose={handleClose} title="Register New Technician" maxWidth={460}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {error && <Alert type="error" onClose={() => setError('')}>{error}</Alert>}

        <Input label="Full Name" placeholder="e.g. Rajesh Kumar" value={form.name} onChange={set('name')} autoFocus />
        <Input
          label="Phone Number"
          placeholder="10-digit mobile number"
          value={form.phone}
          onChange={set('phone')}
          hint="Indian mobile number — digits only (e.g. 9876543210 or 919876543210)"
        />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Service Type</label>
          <select value={form.service_type} onChange={set('service_type')} style={{ ...inputStyle, width: '100%' }}>
            {SERVICE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
          <Btn v="secondary" onClick={handleClose} style={{ flex: 1, justifyContent: 'center' }}>Cancel</Btn>
          <Btn v="primary" loading={loading} onClick={handleSubmit} style={{ flex: 2, justifyContent: 'center' }}>
            Register Technician
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Technician Detail Modal ─────────────────────────────────────────────── */
function TechDetailModal({ tech, onClose, onRefresh }) {
  const [topup, setTopup]     = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  const doTopup = async () => {
    const a = parseFloat(topup);
    if (isNaN(a) || a <= 0) { setError('Enter a valid positive amount'); return; }
    setLoading(true);
    setError('');
    const r = await api.post('/admin/wallets/topup', { technicianId: tech.id, amount: a });
    setLoading(false);
    if (r.ok) {
      setTopup('');
      setSuccess(`Cleared ₹${a} from ${tech.name}'s wallet`);
      onRefresh();
    } else {
      setError(r.error || 'Top-up failed');
    }
  };

  const Row = ({ label, value }) => (
    <div>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, color: '#111827', fontWeight: 500 }}>{value}</div>
    </div>
  );

  return (
    <Modal open onClose={onClose} title={`Technician — ${tech.name}`} maxWidth={500}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Row label="Status"   value={<span style={badgeStyle('tech', tech.status)}>{tech.status}</span>} />
          <Row label="Verified" value={tech.verified ? '✓ Verified' : '✗ Not verified'} />
          <Row label="Phone"    value={<span style={{ fontFamily: 'monospace' }}>{fmt.phone(tech.phone)}</span>} />
          <Row label="Joined"   value={fmt.dt(tech.joinedAt)} />
          <Row label="Jobs Done" value={tech.totalJobs || 0} />
          <Row label="Rating"   value={tech.rating ? `★ ${tech.rating}` : '—'} />
          <Row label="Active Job" value={tech.activeJobId ? <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{fmt.uuid(tech.activeJobId)}</span> : 'None'} />
          <Row label="Wallet Balance" value={
            <span style={{ fontWeight: 700, color: parseFloat(tech.walletBalance) > 500 ? '#dc2626' : '#059669' }}>
              {fmt.money(tech.walletBalance)}
            </span>
          } />
        </div>

        {(tech.skills || []).length > 0 && (
          <div>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 6 }}>Skills</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {tech.skills.map((s) => (
                <span key={s} style={{
                  fontSize: 12, background: '#f3f4f6', border: '1px solid #d1d5db',
                  color: '#374151', padding: '2px 10px', borderRadius: 3,
                }}>{s}</span>
              ))}
            </div>
          </div>
        )}

        {/* Wallet management */}
        <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
            Clear Commission Dues
          </div>
          {error   && <Alert type="error"   onClose={() => setError('')} style={{ marginBottom: 8 }}>{error}</Alert>}
          {success && <Alert type="success" onClose={() => setSuccess('')} style={{ marginBottom: 8 }}>{success}</Alert>}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="number"
              placeholder="Amount (₹)"
              value={topup}
              onChange={(e) => setTopup(e.target.value)}
              style={{ ...inputStyle, flex: 1 }}
            />
            <Btn v="success" loading={loading} onClick={doTopup}>Clear Dues</Btn>
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
            Credits payment against outstanding commission dues.
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Technicians Page ────────────────────────────────────────────────────── */
const PER = 10;

export default function TechniciansPage() {
  const [search, setSearch]         = useState('');
  const [stF, setStF]               = useState('');
  const [page, setPage]             = useState(1);
  const [toast, setToast]           = useState(null);
  const [showRegister, setShowRegister] = useState(false);
  const [detailTech, setDetailTech] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const { data, loading, error, refresh } = useApi(
    () => api.get('/admin/technicians'),
    { pollInterval: 15_000 }
  );

  const techs = useMemo(() => {
    let l = data?.technicians || [];
    if (stF) l = l.filter((t) => t.status === stF);
    if (search) {
      const q = search.toLowerCase();
      l = l.filter((t) =>
        (t.name  || '').toLowerCase().includes(q) ||
        (t.phone || '').includes(q)
      );
    }
    return l;
  }, [data, search, stF]);

  const paged = techs.slice((page - 1) * PER, page * PER);

  const showToast = (type, msg) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3500);
  };

  const toggleVerify = async (tech) => {
    const r = await api.patch(`/admin/technicians/${tech.id}/verified`, { verified: !tech.verified });
    if (r.ok) { refresh(); showToast('success', `${tech.name} ${!tech.verified ? 'verified' : 'unverified'}`); }
    else showToast('error', r.error);
  };

  const setStatus = async (tech, status) => {
    const r = await api.patch(`/admin/technicians/${tech.id}/status`, { status });
    if (r.ok) { refresh(); showToast('success', `${tech.name} set to ${status}`); }
    else showToast('error', r.error);
  };

  const doDelete = async (tech) => {
    setDeleteLoading(true);
    const r = await api.del(`/admin/technicians/${tech.id}`);
    setDeleteLoading(false);
    setConfirmDelete(null);
    if (r.ok) { refresh(); showToast('success', `${tech.name} removed`); }
    else showToast('error', r.error);
  };

  const handleSendMessage = async (techId, techName) => {
    const message = window.prompt(`Send WhatsApp message to ${techName}:`);
    if (!message || !message.trim()) return;
    const r = await api.post(`/admin/technicians/${techId}/message`, { message: message.trim() });
    if (r.ok) {
      showToast('success', `Message sent to ${techName}`);
    } else {
      showToast('error', r.error || 'Send failed');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 }}>Technicians</h2>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
            {loading ? 'Loading…' : `${techs.length} technician${techs.length !== 1 ? 's' : ''}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn v="primary" size="sm" onClick={() => setShowRegister(true)}>+ Add Technician</Btn>
          <Btn v="secondary" size="sm" onClick={refresh}>↻ Refresh</Btn>
        </div>
      </div>

      {toast && <Alert type={toast.type} onClose={() => setToast(null)}>{toast.msg}</Alert>}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search name or phone…"
          style={{ ...inputStyle, flex: 1, minWidth: 200 }}
        />
        <select
          value={stF}
          onChange={(e) => { setStF(e.target.value); setPage(1); }}
          style={{ ...inputStyle, minWidth: 150 }}
        >
          <option value="">All Status</option>
          {['AVAILABLE', 'BUSY', 'OFFLINE'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="pulse" style={{ height: 42, background: '#e5e7eb', borderRadius: 3 }} />
          ))}
        </div>
      ) : error ? (
        <Alert type="error">{error}</Alert>
      ) : techs.length === 0 ? (
        <Card>
          <div style={{ textAlign: 'center', padding: '36px 0' }}>
            <div style={{ color: '#9ca3af', marginBottom: 12 }}>No technicians registered</div>
            <Btn v="primary" size="sm" onClick={() => setShowRegister(true)}>+ Add First Technician</Btn>
          </div>
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <TH>Name</TH>
                  <TH>Phone</TH>
                  <TH>Status</TH>
                  <TH>Verified</TH>
                  <TH>Jobs Done</TH>
                  <TH>Wallet Due</TH>
                  <TH>Skills</TH>
                  <TH>Actions</TH>
                </tr>
              </thead>
              <tbody>
                {paged.map((t, i) => (
                  <tr
                    key={t.id}
                    style={{ borderBottom: '1px solid #e5e7eb', background: i % 2 === 0 ? '#ffffff' : '#fafafa' }}
                  >
                    <TD>
                      <div style={{ fontWeight: 600, color: '#111827' }}>{t.name}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>{fmt.uuid(t.id)}</div>
                    </TD>
                    <TD mono style={{ fontSize: 12 }}>{fmt.phone(t.phone)}</TD>
                    <TD><span style={badgeStyle('tech', t.status)}>{t.status}</span></TD>
                    <TD style={{ color: t.verified ? '#059669' : '#9ca3af', fontSize: 12 }}>
                      {t.verified ? '✓ Yes' : '— No'}
                    </TD>
                    <TD>{t.totalJobs || 0}</TD>
                    <TD style={{ fontWeight: parseFloat(t.walletBalance) > 0 ? 700 : 400, color: parseFloat(t.walletBalance) > 500 ? '#dc2626' : '#374151' }}>
                      {fmt.money(t.walletBalance)}
                    </TD>
                    <TD>
                      <div style={{ fontSize: 12, color: '#6b7280' }}>
                        {(t.skills || []).join(', ') || '—'}
                      </div>
                    </TD>
                    <TD>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                        <Btn v="ghost" size="sm" onClick={() => setDetailTech(t)}>Details</Btn>
                        <Btn
                          v={t.verified ? 'secondary' : 'success'}
                          size="sm"
                          onClick={() => toggleVerify(t)}
                        >
                          {t.verified ? 'Unverify' : 'Verify'}
                        </Btn>
                        {t.status === 'OFFLINE' && (
                          <Btn v="secondary" size="sm" onClick={() => setStatus(t, 'AVAILABLE')}>Set Online</Btn>
                        )}
                        {t.status === 'AVAILABLE' && (
                          <Btn v="secondary" size="sm" onClick={() => setStatus(t, 'OFFLINE')}>Set Offline</Btn>
                        )}
                        <Btn v="secondary" size="sm" onClick={() => handleSendMessage(t.id, t.name)}>Message</Btn>
                        <Btn v="danger" size="sm" onClick={() => setConfirmDelete(t)}>Delete</Btn>
                      </div>
                    </TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '10px 14px', borderTop: '1px solid #e5e7eb' }}>
            <Pager page={page} total={techs.length} per={PER} onChange={setPage} />
          </div>
        </Card>
      )}

      {/* Register Modal */}
      <RegisterModal
        open={showRegister}
        onClose={() => setShowRegister(false)}
        onSuccess={(msg) => { refresh(); showToast('success', msg); }}
      />

      {/* Detail Modal */}
      {detailTech && (
        <TechDetailModal
          tech={detailTech}
          onClose={() => setDetailTech(null)}
          onRefresh={refresh}
        />
      )}

      {/* Confirm Delete Modal */}
      {confirmDelete && (
        <Modal open onClose={() => setConfirmDelete(null)} title="Confirm Delete" maxWidth={400}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Alert type="warning">
              Are you sure you want to delete <strong>{confirmDelete.name}</strong>? This cannot be undone.
            </Alert>
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn v="secondary" onClick={() => setConfirmDelete(null)} style={{ flex: 1, justifyContent: 'center' }}>Cancel</Btn>
              <Btn v="danger" loading={deleteLoading} onClick={() => doDelete(confirmDelete)} style={{ flex: 1, justifyContent: 'center' }}>
                Delete Technician
              </Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
