// ============ SlimeMarket — formatting utilities (date / currency / change) ============
// Pure helpers — no React, no globals beyond window. Exposed as window.Fmt.*

// ---- Date formatting ----
// Accepts ISO string, ms epoch, or Date. Returns a normalized Date or null.
const _toDate = (v) => {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') { const d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  if (typeof v === 'string') {
    // Already ISO-ish — let Date parse it. Also handle the app's existing
    // "now" / "·" placeholder strings gracefully (return null).
    if (v === 'now' || v === '·' || !v.trim()) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
};

// "Aug 11, 2025"
function formatDate(iso) {
  const d = _toDate(iso);
  if (!d) return '—';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

// "2:30 PM"
function formatTime(iso) {
  const d = _toDate(iso);
  if (!d) return '—';
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + m + ' ' + ampm;
}

// "2 hours ago", "just now", "3 days ago", "Aug 11" if > 7 days
function formatRelative(iso) {
  const d = _toDate(iso);
  if (!d) return '—';
  const diff = Date.now() - d.getTime();
  if (diff < 0) return formatDate(iso); // future → fall back to date
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return 'just now';
  if (sec < 60) return sec + 's ago';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + (min === 1 ? ' minute ago' : ' minutes ago');
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + (hr === 1 ? ' hour ago' : ' hours ago');
  const day = Math.floor(hr / 24);
  if (day < 7) return day + (day === 1 ? ' day ago' : ' days ago');
  if (day < 365) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[d.getMonth()] + ' ' + d.getDate();
  }
  return formatDate(iso);
}

// ---- USDC currency formatting ----
// Accepts either a micro-USDC integer (6 decimals) or a float USDC amount.
// Heuristic: numbers >= 1e12 are almost certainly micro-units; for smaller
// values we treat floats as whole USDC and large integers as micro. Pass
// {micro:true} to force the micro path on a small integer.
// "$847.50" (always $-prefixed, 2 decimals, USDC implied)
function formatUsdc(value, opts = {}) {
  let v = value;
  if (v == null || v === '' || isNaN(v)) v = 0;
  v = Number(v);
  // Explicit micro flag wins; otherwise detect BigInt-ish micro values.
  const isMicro = opts.micro === true || (opts.micro !== false && Math.abs(v) >= 1e6 && Number.isInteger(v));
  let usd;
  if (isMicro) {
    // micro-USDC (6 decimals) → USDC float
    usd = v / 1e6;
  } else {
    usd = v;
  }
  const sign = usd < 0 ? '-' : '';
  const abs = Math.abs(usd);
  return sign + '$' + abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Compact variant for axis labels / tight spaces: "$847.50", "$1.2k", "$3.4M"
function formatUsdcCompact(value, opts = {}) {
  let v = value;
  if (v == null || v === '' || isNaN(v)) v = 0;
  v = Number(v);
  const isMicro = opts.micro === true || (opts.micro !== false && Math.abs(v) >= 1e6 && Number.isInteger(v));
  const usd = isMicro ? v / 1e6 : v;
  const sign = usd < 0 ? '-' : '';
  const abs = Math.abs(usd);
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return sign + '$' + (abs / 1e3).toFixed(1) + 'k';
  return sign + '$' + abs.toFixed(2);
}

// ---- Percentage change ----
// formatPercentageChange(current, previous) → { value, isPositive, symbol }
//   value: number (e.g. 12.5 for +12.5%, -8.3 for -8.3%)
//   isPositive: true if current >= previous (>= so equal counts as non-negative)
//   symbol: '▲' | '▼' | '—'
// Safe against zero-previous (returns 0/neutral rather than Infinity).
function formatPercentageChange(current, previous) {
  const cur = Number(current || 0);
  const prev = Number(previous || 0);
  if (prev === 0) {
    // No baseline → no meaningful percent. Surface 0 / neutral.
    if (cur === 0) return { value: 0, isPositive: true, symbol: '—', display: '0%' };
    return { value: 100, isPositive: cur > 0, symbol: cur > 0 ? '▲' : '▼', display: (cur > 0 ? '+' : '-') + '100%' };
  }
  const diff = cur - prev;
  const pct = (diff / Math.abs(prev)) * 100;
  const isPositive = pct >= 0;
  const symbol = isPositive ? '▲' : '▼';
  const rounded = Math.round(Math.abs(pct) * 10) / 10;
  const display = (isPositive ? '+' : '-') + rounded + '%';
  return { value: rounded * (isPositive ? 1 : -1), isPositive, symbol, display };
}

// ---- CSV export helper ----
// rows: array of objects. columns: [{key, label}]. filename: string.
// Builds a proper RFC-4180 CSV (quotes fields containing commas/quotes/newlines),
// triggers a download via Blob. Returns the generated CSV string for preview.
function exportToCsv(filename, rows, columns) {
  if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(columns) || columns.length === 0) return '';
  const esc = (v) => {
    const s = (v == null ? '' : String(v));
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const header = columns.map(c => esc(c.label)).join(',');
  const body = rows.map(r => columns.map(c => esc(r[c.key])).join(',')).join('\r\n');
  const csv = header + '\r\n' + body;
  // BOM so Excel opens UTF-8 correctly.
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return csv;
}

Object.assign(window, {
  Fmt: {
    formatDate, formatRelative, formatTime,
    formatUsdc, formatUsdcCompact,
    formatPercentageChange,
    exportToCsv,
  },
});
