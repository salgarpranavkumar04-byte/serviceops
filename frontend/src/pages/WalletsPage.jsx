/**
 * pages/WalletsPage.jsx
 */

import { useMemo, useState } from 'react';
import { api }      from '../services/api';
import { useApi }   from '../hooks/useApi';
import Alert        from '../components/ui/Alert';
import Btn          from '../components/ui/Btn';
import Card         from '../components/ui/Card';
import Pager        from '../components/ui/Pager';
import StatCard     from '../components/ui/StatCard';
import { TH, TD }  from '../components/ui/Table';
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

const TYPE_COLOR = {
  'job-earning':        '#059669',
  'commission-due':     '#d97706',
  'commission-payment': '#7c3aed',
  'cancellation-fine':  '#dc2626',
  'manual-adjustment':  '#1d4ed8',
};

// Commission-payment reduces the technician's outstanding balance (a payment out)
// job-earning and manual-adjustment increase earnings (credits in)
const CREDIT_TYPES = ['job-earning', 'manual-adjustment'];
const DEBIT_TYPES  = ['commission-due', 'commission-payment', 'cancellation-fine'];

const PER = 15;

export default function WalletsPage() {
  const [typeF, setTypeF] = useState('');
  const [page, setPage]   = useState(1);

  const { data, loading, error, refresh } = useApi(() => api.get('/admin/wallets'));

  const allTxns = data?.transactions || [];

  const txns = useMemo(() => {
    if (!typeF) return allTxns;
    return allTxns.filter((t) => t.type === typeF);
  }, [allTxns, typeF]);

  const paged = txns.slice((page - 1) * PER, page * PER);

  const totalCredits = allTxns.filter((t) => CREDIT_TYPES.includes(t.type)).reduce((s, t) => s + (t.amount || 0), 0);
  const totalDebits  = allTxns.filter((t) => DEBIT_TYPES.includes(t.type)).reduce((s, t) => s + (t.amount || 0), 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#111827', margin: 0 }}>Wallets & Transactions</h2>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{txns.length} transactions</div>
        </div>
        <Btn v="secondary" size="sm" onClick={refresh}>↻ Refresh</Btn>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <StatCard label="Total Credits" value={fmt.money(totalCredits)} clr="#059669" loading={loading} />
        <StatCard label="Total Debits"  value={fmt.money(totalDebits)}  clr="#dc2626" loading={loading} />
      </div>

      <select
        value={typeF}
        onChange={(e) => { setTypeF(e.target.value); setPage(1); }}
        style={{ ...inputStyle, maxWidth: 220 }}
      >
        <option value="">All Types</option>
        {Object.keys(TYPE_COLOR).map((t) => (
          <option key={t} value={t}>{fmt.cap(t)}</option>
        ))}
      </select>

      {loading ? (
        <div className="pulse" style={{ height: 200, background: '#e5e7eb', borderRadius: 3 }} />
      ) : error ? (
        <Alert type="error">{error}</Alert>
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <TH>ID</TH>
                  <TH>Technician</TH>
                  <TH>Type</TH>
                  <TH>Amount</TH>
                  <TH>Balance After</TH>
                  <TH>Job</TH>
                  <TH>Date</TH>
                </tr>
              </thead>
              <tbody>
                {paged.map((t, i) => {
                  const clr      = TYPE_COLOR[t.type] || '#6b7280';
                  const isCredit = CREDIT_TYPES.includes(t.type);
                  return (
                    <tr key={t.id} style={{ borderBottom: '1px solid #e5e7eb', background: i % 2 === 0 ? '#ffffff' : '#fafafa' }}>
                      <TD mono style={{ color: '#9ca3af', fontSize: 11 }}>{String(t.id).slice(0, 8)}</TD>
                      <TD>{t.techName}</TD>
                      <TD>
                        <span style={{
                          fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 3,
                          background: `${clr}15`, color: clr, border: `1px solid ${clr}30`,
                        }}>
                          {fmt.cap(t.type)}
                        </span>
                      </TD>
                      <TD mono style={{ fontWeight: 700, color: isCredit ? '#059669' : '#dc2626' }}>
                        {isCredit ? '+' : '-'}{fmt.money(t.amount)}
                      </TD>
                      <TD mono style={{ color: '#6b7280', fontSize: 12 }}>{fmt.money(t.balanceAfter)}</TD>
                      <TD mono style={{ color: '#9ca3af', fontSize: 11 }}>{t.jobId ? fmt.uuid(t.jobId) : '—'}</TD>
                      <TD style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' }}>{fmt.dt(t.createdAt)}</TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '10px 14px', borderTop: '1px solid #e5e7eb' }}>
            <Pager page={page} total={txns.length} per={PER} onChange={setPage} />
          </div>
        </Card>
      )}
    </div>
  );
}
