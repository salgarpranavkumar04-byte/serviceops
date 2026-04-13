import Spinner from './Spinner';

const VARIANTS = {
  primary:   { background: '#111827', color: '#ffffff', border: '1px solid #111827' },
  secondary: { background: '#ffffff', color: '#374151', border: '1px solid #d1d5db' },
  danger:    { background: '#dc2626', color: '#ffffff', border: '1px solid #dc2626' },
  warning:   { background: '#d97706', color: '#ffffff', border: '1px solid #d97706' },
  ghost:     { background: 'transparent', color: '#6b7280', border: '1px solid transparent' },
  success:   { background: '#059669', color: '#ffffff', border: '1px solid #059669' },
};

const SIZES = {
  sm: { padding: '4px 10px', fontSize: 12 },
  md: { padding: '7px 14px', fontSize: 13 },
  lg: { padding: '10px 20px', fontSize: 14 },
};

export default function Btn({
  children, onClick, v = 'primary', size = 'md',
  disabled, loading, style = {}, type = 'button',
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        display:    'inline-flex',
        alignItems: 'center',
        gap:        5,
        borderRadius: 3,
        cursor:     disabled || loading ? 'not-allowed' : 'pointer',
        opacity:    disabled || loading ? 0.55 : 1,
        fontFamily: "'Times New Roman', Times, serif",
        fontWeight: 600,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        ...VARIANTS[v] || VARIANTS.secondary,
        ...SIZES[size] || SIZES.md,
        ...style,
      }}
    >
      {loading && <Spinner size={12} color={v === 'primary' || v === 'danger' || v === 'success' ? '#fff' : '#374151'} />}
      {children}
    </button>
  );
}
