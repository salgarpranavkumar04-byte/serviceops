/**
 * utils/fmt.js — Formatting helpers
 */

const fmt = {
  dt(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' })
      + ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  },
  money(n) {
    if (n == null || n === '') return '—';
    const num = parseFloat(n);
    if (isNaN(num)) return '—';
    return '₹' + num.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  },
  uuid(id) {
    if (!id) return '—';
    return id.slice(0, 8).toUpperCase();
  },
  phone(p) {
    if (!p) return '—';
    const d = p.replace(/\D/g, '');
    return d.length === 12 ? `+${d.slice(0, 2)} ${d.slice(2, 7)} ${d.slice(7)}` :
           d.length === 10 ? `${d.slice(0, 5)} ${d.slice(5)}` : p;
  },
  cap(str) {
    if (!str) return '';
    return str.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  },
};

export default fmt;
