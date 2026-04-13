export function TH({ children, style = {} }) {
  return (
    <th style={{
      padding: '9px 12px',
      textAlign: 'left',
      fontSize: 11,
      fontWeight: 700,
      color: '#6b7280',
      background: '#f9fafb',
      borderBottom: '1px solid #e5e7eb',
      whiteSpace: 'nowrap',
      textTransform: 'uppercase',
      letterSpacing: '0.05em',
      fontFamily: "'Times New Roman', Times, serif",
      ...style,
    }}>
      {children}
    </th>
  );
}

export function TD({ children, style = {}, mono = false }) {
  return (
    <td style={{
      padding: '9px 12px',
      fontSize: 13,
      color: '#374151',
      verticalAlign: 'middle',
      fontFamily: mono ? "ui-monospace, 'Courier New', monospace" : "'Times New Roman', Times, serif",
      ...style,
    }}>
      {children}
    </td>
  );
}
