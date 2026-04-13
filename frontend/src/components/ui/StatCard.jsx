export default function StatCard({ label, value, sub, icon, clr = '#111827', loading }) {
  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid #e5e7eb',
      borderRadius: 4,
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      fontFamily: "'Times New Roman', Times, serif",
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          {label}
        </span>
        {icon && <span style={{ fontSize: 16 }}>{icon}</span>}
      </div>
      {loading ? (
        <div className="pulse" style={{ height: 28, background: '#e5e7eb', borderRadius: 3 }} />
      ) : (
        <div style={{ fontSize: 22, fontWeight: 700, color: clr, lineHeight: 1.2 }}>
          {value ?? '—'}
        </div>
      )}
      {sub && <div style={{ fontSize: 11, color: '#9ca3af' }}>{sub}</div>}
    </div>
  );
}
