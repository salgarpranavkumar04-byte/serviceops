export default function Select({ label, options = [], style = {}, ...props }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {label && (
        <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', fontFamily: "'Times New Roman', Times, serif" }}>
          {label}
        </label>
      )}
      <select
        {...props}
        style={{
          background: '#ffffff',
          border: '1px solid #d1d5db',
          borderRadius: 3,
          padding: '8px 11px',
          fontSize: 13,
          color: '#111827',
          width: '100%',
          cursor: 'pointer',
          fontFamily: "'Times New Roman', Times, serif",
          ...style,
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}
