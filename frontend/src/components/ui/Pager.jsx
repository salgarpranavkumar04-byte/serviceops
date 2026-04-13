export default function Pager({ page, total, per, onChange }) {
  const pages = Math.ceil(total / per);
  if (pages <= 1) return null;
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 12, color: '#6b7280' }}>
      <button
        disabled={page === 1}
        onClick={() => onChange(page - 1)}
        style={{ border: '1px solid #d1d5db', background: '#fff', padding: '3px 9px', borderRadius: 3, cursor: page === 1 ? 'not-allowed' : 'pointer', opacity: page === 1 ? 0.4 : 1, fontFamily: 'inherit' }}
      >‹</button>
      <span style={{ padding: '0 8px' }}>Page {page} of {pages}</span>
      <button
        disabled={page === pages}
        onClick={() => onChange(page + 1)}
        style={{ border: '1px solid #d1d5db', background: '#fff', padding: '3px 9px', borderRadius: 3, cursor: page === pages ? 'not-allowed' : 'pointer', opacity: page === pages ? 0.4 : 1, fontFamily: 'inherit' }}
      >›</button>
    </div>
  );
}
