import { useEffect } from 'react';

export default function Modal({ open, onClose, title, children, maxWidth = 560 }) {
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (!open) return null;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      padding: '48px 16px',
      background: 'rgba(0,0,0,0.40)',
    }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0 }} />
      <div style={{
        position: 'relative', width: '100%', maxWidth,
        background: '#ffffff',
        border: '1px solid #d1d5db',
        borderRadius: 4,
        maxHeight: '82vh', overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        fontFamily: "'Times New Roman', Times, serif",
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px',
          borderBottom: '1px solid #e5e7eb',
          flexShrink: 0,
          background: '#f9fafb',
        }}>
          <div style={{ fontWeight: 700, color: '#111827', fontSize: 15 }}>{title}</div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: '#6b7280',
            cursor: 'pointer', fontSize: 20, lineHeight: 1, padding: '0 4px',
          }}>×</button>
        </div>
        {/* Body */}
        <div style={{ padding: '18px', overflowY: 'auto' }}>{children}</div>
      </div>
    </div>
  );
}
