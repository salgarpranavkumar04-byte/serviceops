import './spinner.css';

export default function Spinner({ size = 18, color = '#374151' }) {
  return (
    <span
      className="spin"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        border: `2px solid ${color}30`,
        borderTopColor: color,
        borderRadius: '50%',
        flexShrink: 0,
      }}
    />
  );
}
