// Card
export default function Card({ children, style = {} }) {
  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid #e5e7eb',
      borderRadius: 4,
      padding: 16,
      fontFamily: "'Times New Roman', Times, serif",
      ...style,
    }}>
      {children}
    </div>
  );
}
