/**
 * pages/DashboardPage.jsx
 */

import { api }      from '../services/api';
import { useApi }   from '../hooks/useApi';
import Btn          from '../components/ui/Btn';
import Card         from '../components/ui/Card';
import StatCard     from '../components/ui/StatCard';
import { badgeStyle } from '../constants/statusStyles';
import fmt          from '../utils/fmt';

export default function DashboardPage() {
  const { data, loading, refresh } = useApi(
    () => api.get('/admin/stats'),
    { pollInterval: 15_000 }
  );
  const { data: hd, loading: hl } = useApi(
    () => api.get('/admin/health'),
    { pollInterval: 30_000 }
  );
  const { data: stuckData, refresh: refreshStuck } = useApi(
    () => api.get('/admin/jobs/stuck'),
    { pollInterval: 60_000 }
  );
  const { data: dlqData } = useApi(
    () => api.get('/admin/queues/dlq'),
    { pollInterval: 60_000 }
  );

  const s        = data  || {};
  const h        = hd   || {};
  const stuckJobs = stuckData?.jobs || [];
  const dlqCount  = dlqData?.total  || 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 }}>Dashboard</h2>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>Live operational overview</div>
        </div>
        <Btn v="secondary" size="sm" onClick={refresh}>↻ Refresh</Btn>
      </div>

      {/* Stuck jobs alert panel (E-1) */}
      {stuckJobs.length > 0 && (
        <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '12px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontWeight: 700, color: '#991b1b', fontSize: 14 }}>
              ⚠ {stuckJobs.length} stuck job{stuckJobs.length !== 1 ? 's' : ''} — action required
            </div>
            <Btn v="secondary" size="sm" onClick={refreshStuck}>↻</Btn>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {stuckJobs.map((j) => (
              <div key={j.id} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: '#fff', border: '1px solid #fecaca', borderRadius: 4,
                padding: '8px 12px', fontSize: 13, gap: 12, flexWrap: 'wrap',
              }}>
                <div>
                  <span style={{ fontFamily: 'monospace', color: '#6b7280', fontSize: 11 }}>
                    {j.id.slice(0,8).toUpperCase()}
                  </span>
                  {' · '}
                  <strong>{j.customerName}</strong>
                  {' · '}
                  <span style={badgeStyle('job', j.status)}>{j.status}</span>
                  {' · '}
                  <span style={{ color: '#6b7280' }}>{j.minutesStuck}m ago</span>
                </div>
                <div style={{ fontSize: 12, color: '#7f1d1d', flex: 1, minWidth: 200 }}>
                  {j.suggestedAction}
                </div>
                <Btn v="secondary" size="sm" onClick={() => { window.location.hash = '#/jobs'; }}>
                  View Job
                </Btn>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stats row 1 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
        <StatCard label="Total Jobs"      value={s.totalJobs?.toLocaleString()}  sub="All time"  loading={loading} />
        <StatCard label="Active Jobs"     value={s.activeJobs}                   sub="Right now" clr="#1d4ed8" loading={loading} />
        <StatCard label="Today Revenue"   value={s.todayRevenue != null ? fmt.money(s.todayRevenue) : null} clr="#059669" loading={loading} />
        <StatCard label="Completion Rate" value={s.completionRate != null ? `${s.completionRate}%` : null} clr="#7c3aed" loading={loading} />
      </div>

      {/* Stats row 2 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
        <StatCard label="Technicians"      value={s.totalTechs}  sub={`${s.availableTechs ?? '—'} available`} loading={loading} />
        <StatCard label="Pending Payments" value={s.pendingPayments} clr="#be185d" loading={loading} />
        <StatCard label="Commission Due"   value={s.pendingCommission != null ? fmt.money(s.pendingCommission) : null} clr="#dc2626" loading={loading} />
        <StatCard label="Customers"        value={s.totalCustomers?.toLocaleString()} clr="#1d4ed8" loading={loading} />
      </div>

      {/* System health + queues */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 16 }}>

        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>
            System Health
          </div>
          {hl ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[0,1,2,3,4].map((i) => (
                <div key={i} className="pulse" style={{ height: 20, background: '#e5e7eb', borderRadius: 3 }} />
              ))}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { l: 'PostgreSQL Database', ok: h.db },
                { l: 'Redis / BullMQ',      ok: h.redis },
                { l: 'Message Worker',      ok: h.workers?.message },
                { l: 'WhatsApp Worker',     ok: h.workers?.whatsapp },
                { l: 'Job Worker',          ok: h.workers?.job },
              ].map(({ l, ok }) => (
                <div key={l} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 13 }}>
                  <span style={{ color: '#374151' }}>{l}</span>
                  <span style={badgeStyle('tech', ok ? 'AVAILABLE' : 'OFFLINE')}>
                    {ok ? 'Healthy' : 'Down'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>
            Queue Status
          </div>
          {hl ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[0,1,2].map((i) => (
                <div key={i} className="pulse" style={{ height: 32, background: '#e5e7eb', borderRadius: 3 }} />
              ))}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {[
                { l: 'Incoming Messages', q: h.queues?.incoming },
                { l: 'WhatsApp Send',     q: h.queues?.send },
                { l: 'Job Processing',    q: h.queues?.jobs },
              ].map(({ l, q }) => (
                <div key={l}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                    <span style={{ color: '#6b7280' }}>{l}</span>
                    <span style={{ fontFamily: 'monospace', color: '#374151', fontSize: 11 }}>
                      {q?.waiting ?? 0} waiting · {q?.active ?? 0} active
                    </span>
                  </div>
                  <div style={{ height: 4, background: '#e5e7eb', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      background: (q?.active || 0) > 0 ? '#d97706' : '#d1d5db',
                      borderRadius: 2,
                      width: `${Math.min(100, ((q?.active || 0) / 5) * 100)}%`,
                    }} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {dlqCount > 0 && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #e5e7eb' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: '#dc2626', fontWeight: 700 }}>Failed jobs (DLQ)</span>
                <span style={{ fontFamily: 'monospace', color: '#dc2626', fontSize: 11 }}>{dlqCount} total</span>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
