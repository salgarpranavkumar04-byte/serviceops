export default function Input({ label, hint, style = {}, ...props }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {label && (
        <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', fontFamily: "'Times New Roman', Times, serif" }}>
          {label}
        </label>
      )}
      <input
        {...props}
        style={{
          background: '#ffffff',
          border: '1px solid #d1d5db',
          borderRadius: 3,
          padding: '8px 11px',
          fontSize: 13,
          color: '#111827',
          width: '100%',
          fontFamily: "'Times New Roman', Times, serif",
          ...style,
        }}
      />
      {hint && (
        <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: "'Times New Roman', Times, serif" }}>{hint}</div>
      )}
    </div>
  );
}
