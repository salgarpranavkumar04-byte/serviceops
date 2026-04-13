const STYLES = {
  error:   { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b' },
  success: { background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#14532d' },
  warning: { background: '#fffbeb', border: '1px solid #fde68a', color: '#78350f' },
  info:    { background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1e40af' },
};

export default function Alert({ type = 'info', children, onClose, style = {} }) {
  const s = STYLES[type] || STYLES.info;
  return (
    <div style={{
      ...s,
      borderRadius: 4,
      padding: '10px 14px',
      fontSize: 13,
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
      fontFamily: "'Times New Roman', Times, serif",
      ...style,
    }}>
      <span style={{ flex: 1, lineHeight: 1.5 }}>{children}</span>
      {onClose && (
        <button
          onClick={onClose}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: s.color, fontSize: 16, lineHeight: 1, padding: 0, flexShrink: 0,
          }}
        >×</button>
      )}
    </div>
  );
}
