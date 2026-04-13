/**
 * pages/JobsPage.jsx
 *
 * Features:
 *   - List all jobs (GET /jobs)
 *   - Assign technician (POST /admin/jobs/:id/assign)  ← CRITICAL — was missing
 *   - Change job status (PATCH /admin/jobs/:id)
 *   - Cancel job / Force complete via action panel
 *   - Show assigned technician details in row
 *   - Filter by status + search
 */

import { useMemo, useState } from 'react';
import { api }          from '../services/api';
import { useApi }       from '../hooks/useApi';
import Alert            from '../components/ui/Alert';
import Btn              from '../components/ui/Btn';
import Card             from '../components/ui/Card';
import Modal            from '../components/ui/Modal';
import Pager            from '../components/ui/Pager';
import { TH, TD }       from '../components/ui/Table';
import { badgeStyle, ALL_JOB_STATUSES, JOB_TRANSITIONS } from '../constants/statusStyles';
import fmt              from '../utils/fmt';

/* ─── Shared input style ──────────────────────────────────────────────────── */
const inputStyle = {
  background: '#ffffff',
  border: '1px solid #d1d5db',
  borderRadius: 3,
  padding: '7px 10px',
  fontSize: 13,
  color: '#111827',
  outline: 'none',
};

/* ─── Assign Technician Modal ─────────────────────────────────────────────── */
function AssignModal({ job, onClose, onSuccess }) {
  const [techId, setTechId]   = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  // Fetch technician list for dropdown
  const { data, loading: techsLoading } = useApi(() => api.get('/admin/technicians'));
  const technicians = data?.technicians || [];

  const handleSubmit = async () => {
    if (!techId) { setError('Please select a technician'); return; }
    setLoading(true);
    setError('');
    const r = await api.post(`/admin/jobs/${job.id}/assign`, { technician_id: techId });
    setLoading(false);
    if (r.ok) {
      onSuccess(`Job assigned successfully`);
    } else {
      setError(r.error || 'Assignment failed');
    }
  };

  return (
    <Modal open onClose={onClose} title={`Assign Technician — Job ${fmt.uuid(job.id)}`} maxWidth={480}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Job summary */}
        <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 3, padding: '10px 14px', fontSize: 13 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div><span style={{ color: '#6b7280' }}>Service: </span><strong>{job.service_type}</strong></div>
            <div><span style={{ color: '#6b7280' }}>Status: </span><span style={badgeStyle('job', job.status)}>{fmt.cap(job.status)}</span></div>
            <div style={{ gridColumn: '1 / -1' }}><span style={{ color: '#6b7280' }}>Customer: </span><strong>{job.customer_name}</strong> · {fmt.phone(job.customer_phone)}</div>
          </div>
        </div>

        {/* Current assignment */}
        {job.technician_name && (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 3, padding: '8px 12px', fontSize: 12, color: '#78350f' }}>
            Currently assigned to: <strong>{job.technician_name}</strong>. Reassigning will free them.
          </div>
        )}

        {error && <Alert type="error" onClose={() => setError('')}>{error}</Alert>}

        {/* Technician dropdown */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Select Technician</label>
          {techsLoading ? (
            <div className="pulse" style={{ height: 36, background: '#e5e7eb', borderRadius: 3 }} />
          ) : (
            <select
              value={techId}
              onChange={(e) => { setTechId(e.target.value); setError(''); }}
              style={{ ...inputStyle, width: '100%' }}
            >
              <option value="">-- Choose technician --</option>
              {technicians.map((t) => (
                <option key={t.id} value={t.id} disabled={t.status === 'OFFLINE'}>
                  {t.name} · {fmt.phone(t.phone)} · {t.status}{t.status === 'OFFLINE' ? ' (offline)' : ''}
                </option>
              ))}
            </select>
          )}
          <div style={{ fontSize: 11, color: '#9ca3af' }}>Offline technicians cannot be assigned.</div>
        </div>

        {/* Preview selected tech */}
        {techId && (() => {
          const t = technicians.find((x) => x.id === techId);
          if (!t) return null;
          return (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 3, padding: '10px 14px', fontSize: 13 }}>
              <div style={{ fontWeight: 700, color: '#065f46', marginBottom: 4 }}>{t.name}</div>
              <div style={{ display: 'flex', gap: 16, color: '#374151' }}>
                <span>Phone: {fmt.phone(t.phone)}</span>
                <span>Status: <span style={badgeStyle('tech', t.status)}>{t.status}</span></span>
                <span>Jobs done: {t.totalJobs}</span>
              </div>
            </div>
          );
        })()}

        <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
          <Btn v="secondary" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>Cancel</Btn>
          <Btn v="primary" loading={loading} onClick={handleSubmit} style={{ flex: 2, justifyContent: 'center' }}>
            Assign Technician
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Job Detail + Admin Action Panel ────────────────────────────────────── */
function JobDetailModal({ job, onClose, onUpdate }) {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const handle = async (status) => {
    setLoading(true);
    setError('');
    const r = await api.patch(`/admin/jobs/${job.id}`, { status });
    setLoading(false);
    if (r.ok) {
      onUpdate(`Status changed to ${fmt.cap(status)}`);
    } else {
      setError(r.error || 'Update failed');
    }
  };

  const handleResend = async (type) => {
    setLoading(true);
    setError('');
    const r = await api.post(`/admin/jobs/${job.id}/resend-notification`, { type });
    setLoading(false);
    if (r.ok) {
      onUpdate(`Notification resent: ${type.replace(/_/g, ' ')}`);
    } else {
      setError(r.error || 'Resend failed');
    }
  };

  const handleForceCancel = async () => {
    const reason = window.prompt('Reason for cancellation (shown to customer):');
    if (reason === null) return;
    setLoading(true);
    setError('');
    const r = await api.post(`/admin/jobs/${job.id}/force-cancel`, { reason: reason.trim() });
    setLoading(false);
    if (r.ok) {
      onUpdate('Job force-cancelled — both parties notified');
    } else {
      setError(r.error || 'Force cancel failed');
    }
  };

  const Row = ({ label, value }) => (
    <div>
      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, color: '#111827', fontWeight: 500 }}>{value}</div>
    </div>
  );

  const nextStatuses = JOB_TRANSITIONS[job.status] || [];
  const canCancel    = !['COMPLETED', 'CANCELLED'].includes(job.status);
  const canComplete  = !['COMPLETED', 'CANCELLED'].includes(job.status);

  return (
    <Modal open onClose={onClose} title={`Job ${fmt.uuid(job.id)}`} maxWidth={580}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

        {error && <Alert type="error" onClose={() => setError('')}>{error}</Alert>}

        {/* Core details */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Row label="Status"   value={<span style={badgeStyle('job', job.status)}>{fmt.cap(job.status)}</span>} />
          <Row label="Service"  value={job.service_type || '—'} />
          <Row label="Price"    value={fmt.money(job.price)} />
          <Row label="Payment"  value={job.payment_status || '—'} />
          <Row label="Address"  value={job.customer_address || '—'} />
          <Row label="Dispatch Attempts" value={job.dispatch_attempts ?? 0} />
          <Row label="Created"  value={fmt.dt(job.created_at)} />
          <Row label="Updated"  value={fmt.dt(job.updated_at)} />
        </div>

        {/* Customer & Technician */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, borderTop: '1px solid #e5e7eb', paddingTop: 14 }}>
          <div>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Customer</div>
            <div style={{ fontWeight: 600, color: '#111827' }}>{job.customer_name || '—'}</div>
            <div style={{ fontSize: 12, color: '#6b7280', fontFamily: 'monospace' }}>{fmt.phone(job.customer_phone)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>Assigned Technician</div>
            {job.technician_name ? (
              <div style={{ fontWeight: 600, color: '#111827' }}>{job.technician_name}</div>
            ) : (
              <div style={{ color: '#9ca3af', fontStyle: 'italic', fontSize: 13 }}>Not assigned</div>
            )}
          </div>
        </div>

        {/* Admin Action Panel */}
        <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>
            Admin Controls
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {/* Status transitions */}
            {nextStatuses.filter(s => s !== 'CANCELLED' && s !== 'COMPLETED').map((s) => (
              <Btn key={s} v="secondary" size="sm" loading={loading} onClick={() => handle(s)}>
                Set: {fmt.cap(s)}
              </Btn>
            ))}

            {/* Force complete */}
            {canComplete && (
              <Btn v="success" size="sm" loading={loading} onClick={() => handle('COMPLETED')}>
                Force Complete
              </Btn>
            )}

            {/* Cancel */}
            {canCancel && (
              <Btn v="danger" size="sm" loading={loading} onClick={() => handle('CANCELLED')}>
                Cancel Job
              </Btn>
            )}
          </div>

          {(nextStatuses.length > 0 || canCancel) && (
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 8 }}>
              Warning: Admin overrides bypass standard business logic validation.
            </div>
          )}
        </div>

        {/* Resend Notifications (E-2) */}
        <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
            Resend Notifications
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {['CUSTOMER_APPROVAL_PENDING', 'WAITING_FOR_PRICE'].includes(job.status) && (
              <Btn v="secondary" size="sm" loading={loading} onClick={() => handleResend('price_request')}>
                Resend Price Request
              </Btn>
            )}
            {job.status === 'PAYMENT_PENDING' && (
              <Btn v="secondary" size="sm" loading={loading} onClick={() => handleResend('payment_link')}>
                Resend Payment Link
              </Btn>
            )}
            {job.status === 'ACCEPTED' && (
              <Btn v="secondary" size="sm" loading={loading} onClick={() => handleResend('arrival_confirmed')}>
                Resend Arrival Confirmation
              </Btn>
            )}
            {job.status === 'IN_PROGRESS' && (
              <Btn v="secondary" size="sm" loading={loading} onClick={() => handleResend('payment_confirmed')}>
                Resend Payment Confirmed
              </Btn>
            )}
          </div>
        </div>

        {/* Force Cancel with notifications (E-2) */}
        {canCancel && (
          <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 14 }}>
            <Btn v="danger" size="sm" loading={loading} onClick={handleForceCancel}>
              Force Cancel (with notifications)
            </Btn>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
              Cancels the job, frees the technician, and sends WhatsApp messages to both parties.
            </div>
          </div>
        )}

      </div>
    </Modal>
  );
}

/* ─── Jobs Page ───────────────────────────────────────────────────────────── */
const PER = 12;

export default function JobsPage() {
  const [page, setPage]       = useState(1);
  const [search, setSearch]   = useState('');
  const [stF, setStF]         = useState('');
  const [detailJob, setDetailJob] = useState(null);
  const [assignJob, setAssignJob] = useState(null);
  const [toast, setToast]     = useState(null);

  // GET /jobs — backend returns { success, data: [] }
  const { data, loading, error, refresh } = useApi(
    () => api.get('/jobs'),
    { pollInterval: 12_000 }
  );
  const { data: dlqData, refresh: refreshDLQ } = useApi(
    () => api.get('/admin/queues/dlq'),
    { pollInterval: 120_000 }
  );
  const dlqJobs = dlqData?.jobs || [];

  const jobs = useMemo(() => {
    let l = data?.data || [];
    if (stF) l = l.filter((j) => j.status === stF);
    if (search) {
      const q = search.toLowerCase();
      l = l.filter((j) =>
        (j.customer_name   || '').toLowerCase().includes(q) ||
        (j.service_type    || '').toLowerCase().includes(q) ||
        (j.technician_name || '').toLowerCase().includes(q) ||
        (j.id              || '').toLowerCase().includes(q)
      );
    }
    return l;
  }, [data, search, stF]);

  const paged = jobs.slice((page - 1) * PER, page * PER);

  const showToast = (type, msg) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3500);
  };

  const handleUpdate = (message) => {
    setDetailJob(null);
    refresh();
    showToast('success', message);
  };

  const handleAssigned = (message) => {
    setAssignJob(null);
    refresh();
    showToast('success', message);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 }}>Jobs</h2>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
            {loading ? 'Loading…' : `${jobs.length} job${jobs.length !== 1 ? 's' : ''}${stF ? ` · ${fmt.cap(stF)}` : ''}`}
          </div>
        </div>
        <Btn v="secondary" size="sm" onClick={refresh}>↻ Refresh</Btn>
      </div>

      {toast && <Alert type={toast.type} onClose={() => setToast(null)}>{toast.msg}</Alert>}

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search by customer, service, technician, job ID…"
          style={{ ...inputStyle, flex: 1, minWidth: 220 }}
        />
        <select
          value={stF}
          onChange={(e) => { setStF(e.target.value); setPage(1); }}
          style={{ ...inputStyle, minWidth: 160 }}
        >
          <option value="">All Status</option>
          {ALL_JOB_STATUSES.map((s) => (
            <option key={s} value={s}>{fmt.cap(s)}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="pulse" style={{ height: 42, background: '#e5e7eb', borderRadius: 3 }} />
          ))}
        </div>
      ) : error ? (
        <Alert type="error">{error}</Alert>
      ) : jobs.length === 0 ? (
        <Card>
          <div style={{ textAlign: 'center', padding: '36px 0', color: '#9ca3af' }}>No jobs found</div>
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <TH>Job ID</TH>
                  <TH>Customer</TH>
                  <TH>Service</TH>
                  <TH>Technician</TH>
                  <TH>Status</TH>
                  <TH>Amount</TH>
                  <TH>Payment</TH>
                  <TH>Created</TH>
                  <TH>Actions</TH>
                </tr>
              </thead>
              <tbody>
                {paged.map((j, i) => (
                  <tr
                    key={j.id}
                    style={{ borderBottom: '1px solid #e5e7eb', background: i % 2 === 0 ? '#ffffff' : '#fafafa' }}
                  >
                    <TD mono style={{ color: '#6b7280', fontSize: 11 }}>{fmt.uuid(j.id)}</TD>
                    <TD>
                      <div style={{ fontWeight: 600, fontSize: 13, color: '#111827' }}>{j.customer_name || '—'}</div>
                      <div style={{ fontSize: 11, color: '#6b7280', fontFamily: 'monospace' }}>{j.customer_phone_masked || fmt.phone(j.customer_phone)}</div>
                    </TD>
                    <TD style={{ color: '#374151', whiteSpace: 'nowrap' }}>{j.service_type}</TD>
                    <TD>
                      {j.technician_name ? (
                        <div style={{ fontSize: 13, color: '#111827' }}>{j.technician_name}</div>
                      ) : (
                        <span style={{ color: '#d97706', fontSize: 12 }}>Unassigned</span>
                      )}
                    </TD>
                    <TD><span style={badgeStyle('job', j.status)}>{fmt.cap(j.status)}</span></TD>
                    <TD mono style={{ fontWeight: 700, color: '#111827' }}>{fmt.money(j.price)}</TD>
                    <TD style={{ fontSize: 12, color: j.payment_status === 'PAID' ? '#059669' : '#6b7280' }}>
                      {j.payment_status || '—'}
                    </TD>
                    <TD style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>{fmt.dt(j.created_at)}</TD>
                    <TD>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {/* Assign / Reassign button — always visible */}
                        {!['COMPLETED', 'CANCELLED'].includes(j.status) && (
                          <Btn
                            v="secondary"
                            size="sm"
                            onClick={() => setAssignJob(j)}
                          >
                            {j.technician_name ? 'Reassign' : 'Assign'}
                          </Btn>
                        )}
                        <Btn v="ghost" size="sm" onClick={() => setDetailJob(j)}>Detail</Btn>
                      </div>
                    </TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '10px 14px', borderTop: '1px solid #e5e7eb' }}>
            <Pager page={page} total={jobs.length} per={PER} onChange={setPage} />
          </div>
        </Card>
      )}

      {/* Failed Queue Jobs (DLQ) — E-2 */}
      {dlqJobs.length > 0 && (
        <Card style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontWeight: 700, color: '#dc2626', fontSize: 13 }}>
              Failed Queue Jobs (DLQ) — {dlqJobs.length}
            </div>
            <Btn v="secondary" size="sm" onClick={refreshDLQ}>↻</Btn>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {dlqJobs.slice(0, 10).map((j) => (
              <div key={j.id} style={{
                display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                gap: 12, padding: '8px 0', borderBottom: '1px solid #f3f4f6', flexWrap: 'wrap',
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>
                    {j.queue} / {j.name}
                  </div>
                  <div style={{ fontSize: 11, color: '#dc2626', marginTop: 2, fontFamily: 'monospace' }}>
                    {(j.failedReason || j.error || '—').slice(0, 120)}
                  </div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                    {j.timestamp ? fmt.dt(new Date(j.timestamp).toISOString()) : '—'}
                  </div>
                </div>
                <Btn v="secondary" size="sm" onClick={async () => {
                  const r = await api.post('/admin/queues/dlq/retry', { queue: j.queue, jobId: j.id });
                  if (r.ok) refreshDLQ();
                }}>
                  Retry
                </Btn>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Assign Technician Modal */}
      {assignJob && (
        <AssignModal
          job={assignJob}
          onClose={() => setAssignJob(null)}
          onSuccess={handleAssigned}
        />
      )}

      {/* Job Detail + Actions Modal */}
      {detailJob && (
        <JobDetailModal
          job={detailJob}
          onClose={() => setDetailJob(null)}
          onUpdate={handleUpdate}
        />
      )}
    </div>
  );
}
