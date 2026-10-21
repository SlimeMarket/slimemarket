// ============ SlimeMarket — shared UI (Arc navy design system) ============
const { useState, useEffect, useRef } = React;

// ---- Lucide icon as React component ----
function Icon({ name, size = 18, stroke = 2, className = '', style }) {
  const lib = (window.lucide && window.lucide.icons) || {};
  const pascal = name.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join('');
  const node = lib[pascal] || lib[name];
  if (!node) return React.createElement('span', { className, style: { width: size, height: size, display: 'inline-block' } });
  const children = (Array.isArray(node) && Array.isArray(node[2])) ? node[2] : (node.children || []);
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round',
    strokeLinejoin: 'round', className, style,
  }, children.map((c, i) => React.createElement(c[0], { key: i, ...c[1] })));
}

// ---- Pixel slime mascot (SVG, grid art) — recolored to Arc blue/cyan ----
function SlimeLogo({ size = 36 }) {
  const map = [
    '...bb...',
    '..bbbb..',
    '.baawwb.',
    'bawkwkab',
    'bbwwwwbb',
    'bbbbbbbb',
    'dbdbdbdb',
    '.d.d.d.d',
  ];
  const C = { b: '#2F6BFF', d: '#1E4FD9', a: '#38BDF8', w: '#EAF2FF', k: '#0A1830', '.': null };
  const u = size / 8;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="pixelated blob-float" shapeRendering="crispEdges">
      {map.flatMap((row, y) => row.split('').map((ch, x) => {
        const fill = C[ch];
        if (!fill) return null;
        return <rect key={x + '-' + y} x={x * u} y={y * u} width={u} height={u} fill={fill} />;
      }))}
    </svg>
  );
}

// ---- Pixel-font label ----
function Pixel({ children, className = '' }) {
  return <span className={'font-pixel ' + className} style={{ letterSpacing: '0.02em' }}>{children}</span>;
}

// ---- Button ----
function Btn({ children, variant = 'primary', size = 'md', icon, iconRight, className = '', full, ...rest }) {
  const sizes = { sm: 'h-8 px-3 text-xs', md: 'h-10 px-4 text-sm', lg: 'h-12 px-6 text-[15px]' };
  const variants = {
    primary: 'bg-arc-primary hover:bg-arc-primarydk text-white shadow-glow active:translate-y-px',
    accent: 'bg-arc-accent hover:brightness-110 text-arc-bg font-semibold shadow-glow-accent active:translate-y-px',
    emerald: 'bg-emerald-500 hover:bg-emerald-400 text-emerald-950 shadow-glow-emerald font-semibold active:translate-y-px',
    ghost: 'bg-transparent hover:bg-arc-surface2 text-arc-muted hover:text-arc-text border border-arc-border',
    outline: 'bg-arc-surface hover:bg-arc-surface2 text-arc-text border border-arc-borderlt',
    danger: 'bg-rose-600/15 hover:bg-rose-600/25 text-rose-300 border border-rose-700/50',
    subtle: 'bg-arc-surface2 hover:bg-arc-border text-arc-text',
  };
  return (
    <button {...rest} className={`inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all duration-150 disabled:opacity-40 disabled:pointer-events-none ${sizes[size]} ${variants[variant] || variants.primary} ${full ? 'w-full' : ''} ${className}`}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 17} />}
      {children}
      {iconRight && <Icon name={iconRight} size={size === 'sm' ? 14 : 17} />}
    </button>
  );
}

// ---- Pixel badge (status / tag pill) ----
function PixBadge({ children, color = 'blue', className = '' }) {
  const colors = {
    blue: 'bg-arc-primary/15 text-arc-accent ring-arc-primary/30',
    violet: 'bg-arc-primary/15 text-arc-accent ring-arc-primary/30',
    emerald: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
    amber: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
    rose: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
    slate: 'bg-arc-surface2 text-arc-muted ring-arc-border',
    cyan: 'bg-cyan-500/15 text-cyan-300 ring-cyan-500/30',
  };
  return (
    <span className={`inline-flex items-center font-pixel text-[8px] leading-none px-2 py-1.5 rounded ring-1 ${colors[color] || colors.blue} ${className}`}>
      {children}
    </span>
  );
}

// ---- Delivery badge ----
function DeliveryBadge({ type, est }) {
  if (type === 'instant')
    return <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-300 bg-emerald-500/10 ring-1 ring-emerald-500/25 rounded-md px-2 py-1"><Icon name="zap" size={12} className="text-emerald-400" /> Instant</span>;
  return <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-300 bg-amber-500/10 ring-1 ring-amber-500/25 rounded-md px-2 py-1"><Icon name="clock" size={12} className="text-amber-400" /> Manual{est ? ` · ~${est}m` : ''}</span>;
}

// ---- Status colors map ----
const STATUS_META = {
  PENDING: { color: 'slate', icon: 'loader', label: 'Pending' },
  PROCESS: { color: 'amber', icon: 'cog', label: 'Processing' },
  SENT: { color: 'cyan', icon: 'send', label: 'Sent' },
  DONE: { color: 'emerald', icon: 'check-check', label: 'Done' },
  DISPUTED: { color: 'rose', icon: 'gavel', label: 'Disputed' },
  REFUNDED: { color: 'rose', icon: 'undo-2', label: 'Refunded' },
  CANCELLED: { color: 'slate', icon: 'x-circle', label: 'Cancelled' },
  DECLINED: { color: 'rose', icon: 'ban', label: 'Declined' },
  WAITING: { color: 'amber', icon: 'gavel', label: 'Waiting' },
  ESCROW: { color: 'blue', icon: 'lock', label: 'In Escrow' },
  COMPLETED: { color: 'emerald', icon: 'check-check', label: 'Completed' },
  // NOTE: the escrow terminal state is now `CANCELLED` (was `BATAL`), which
  // COLLIDES with the order status of the same name — hence one entry, not two.
  // The deal room still explains the refund in its own copy, so nothing is lost.
};
function StatusPill({ status }) {
  const m = STATUS_META[status] || STATUS_META.PENDING;
  // Render the LABEL, not the raw status. `STATUS_META` exists precisely so the
  // internal enum never reaches the UI — but this used to print `{status}`, so
  // any caller showed the raw value (e.g. "WAITING") instead of "Waiting".
  return <PixBadge color={m.color}>{m.label}</PixBadge>;
}

// ---- Avatar ----
function Avatar({ gradient = 'from-arc-primary to-arc-accent', name = '?', size = 36, ring = false, img = null }) {
  return (
    <div className={`bg-gradient-to-br ${gradient} rounded-xl flex items-center justify-center text-white font-bold shrink-0 overflow-hidden bg-cover bg-center ${ring ? 'ring-2 ring-arc-bg' : ''}`}
      style={{ width: size, height: size, fontSize: size * 0.4, ...(img ? { backgroundImage: `url(${img})` } : {}) }}>
      {!img && String(name || '?').charAt(0).toUpperCase()}
    </div>
  );
}

// ---- Detect image URL vs Tailwind gradient class (banner/avatar fields) ----
const isImgUrl = v => typeof v === 'string' && /^data:|^https?:/.test(v);

// ---- ImageUpload (FileReader → dataURL) ----
function ImageUpload({ value, onChange, aspect = '16 / 9', round = 'rounded-xl', recommend, hint, gradient, glyph, name, height }) {
  const inputRef = useRef(null);
  const [drag, setDrag] = useState(false);
  const readFile = (file) => {
    if (!file || !file.type || !file.type.startsWith('image/')) return;
    const r = new FileReader();
    r.onload = e => onChange(e.target.result);
    r.readAsDataURL(file);
  };
  return (
    <div>
      <div
        onClick={() => inputRef.current && inputRef.current.click()}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); readFile(e.dataTransfer.files[0]); }}
        className={`relative ${round} overflow-hidden cursor-pointer ring-2 transition group ${drag ? 'ring-arc-accent' : 'ring-arc-border hover:ring-arc-primary/50'}`}
        style={{ aspectRatio: height ? undefined : aspect, height }}>
        {value
          ? <img src={value} alt="" className="w-full h-full object-cover" />
          : <div className={`w-full h-full bg-gradient-to-br ${gradient || 'from-arc-surface2 to-arc-surface'} grid-noise flex items-center justify-center`}>{glyph && <span className="text-3xl opacity-80">{glyph}</span>}</div>}
        <div className={`absolute inset-0 flex flex-col items-center justify-center gap-1 transition ${value ? 'bg-arc-bg/0 group-hover:bg-arc-bg/60 opacity-0 group-hover:opacity-100' : 'bg-arc-bg/30'}`}>
          <Icon name="image-up" size={20} className="text-white" />
          <span className="text-[11px] font-medium text-white">{value ? 'Change image' : 'Upload image'}</span>
        </div>
        {value && (
          <button onClick={e => { e.stopPropagation(); onChange(null); }} className="absolute top-2 right-2 w-7 h-7 rounded-lg bg-arc-bg/70 hover:bg-rose-600 text-white flex items-center justify-center transition opacity-0 group-hover:opacity-100"><Icon name="trash-2" size={13} /></button>
        )}
        <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={e => readFile(e.target.files[0])} />
      </div>
      {(recommend || hint) && (
        <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-arc-faint">
          <Icon name="info" size={11} className="text-arc-faint shrink-0" />
          {recommend && <span>Recommended <span className="text-arc-muted font-medium">{recommend}</span></span>}
          {hint && <span>{hint}</span>}
        </div>
      )}
    </div>
  );
}

// ---- Stars ----
function Stars({ value, size = 12 }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-amber-400">
      {[0, 1, 2, 3, 4].map(i => (
        <Icon key={i} name="star" size={size} className={i < Math.round(value) ? 'fill-amber-400' : 'fill-arc-border text-arc-border'} stroke={0} />
      ))}
    </span>
  );
}

// ---- Modal shell ----
function Modal({ open, onClose, children, width = 'max-w-md' }) {
  useEffect(() => {
    if (!open) return;
    const h = e => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 anim-fade">
      <div className="absolute inset-0 bg-arc-bg/80 backdrop-blur-sm" onClick={onClose}></div>
      <div className={`relative w-full ${width} anim-modal`}>{children}</div>
    </div>
  );
}

// ---- Card ----
// NOTE: `...rest` is REQUIRED — modals rely on <Card onClick={e => e.stopPropagation()}>
// to keep backdrop-click-to-close from firing on every click inside the modal.
// Without the spread the prop was silently dropped and every modal closed itself.
function Card({ children, className = '', ...rest }) {
  return <div className={`bg-arc-surface/70 ring-1 ring-arc-border rounded-2xl ${className}`} {...rest}>{children}</div>;
}

// ---- Copy chip ----
function CopyChip({ value, label, displayValue }) {
  const [copied, setCopied] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      className="group inline-flex items-center gap-2 font-mono text-xs text-arc-text bg-arc-bg/60 ring-1 ring-arc-border hover:ring-arc-primary/40 rounded-lg px-2.5 py-1.5 transition-colors">
      {label && <span className="text-arc-faint">{label}</span>}
      <span className="text-arc-accent">{displayValue || value}</span>
      <Icon name={copied ? 'check' : 'copy'} size={13} className={copied ? 'text-emerald-400' : 'text-arc-faint group-hover:text-arc-text'} />
    </button>
  );
}

// ---- USDC amount ----
function Usdc({ value, className = '', sign = '', size = '' }) {
  return (
    <span className={`font-mono tabular-nums ${className}`}>
      {sign}{Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      <span className={`text-emerald-400/70 ml-1 ${size ? size : 'text-[0.7em]'}`}>USDC</span>
    </span>
  );
}


// ---------- Presence ----------
// "Online" is derived from users.last_seen_at (lib/presence/window.ts): the SPA
// pings /api/presence every 60s while the tab is visible, and anything older
// than two minutes reads as offline. The label is relative on purpose —
// "Active 2h ago" tells a buyer whether a message will land today, which a bare
// grey dot does not.
function presenceLabel(lastSeenAt, online) {
  if (online) return tr('presence.online', 'Online now');
  if (!lastSeenAt) return tr('presence.never', 'Not active yet');
  const t = Date.parse(lastSeenAt);
  if (Number.isNaN(t)) return tr('presence.never', 'Not active yet');
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return tr('presence.justNow', 'Active just now');
  if (mins < 60) return tr('presence.minsAgo', 'Active {n}m ago').replace('{n}', String(mins));
  const hours = Math.round(mins / 60);
  if (hours < 24) return tr('presence.hoursAgo', 'Active {n}h ago').replace('{n}', String(hours));
  const days = Math.round(hours / 24);
  if (days < 7) return tr('presence.daysAgo', 'Active {n}d ago').replace('{n}', String(days));
  const on = new Date(t).toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
  return tr('presence.lastOn', 'Last active {d}').replace('{d}', on);
}

function PresenceDot({ online, size = 8, ring = true, className = '' }) {
  return (
    <span className={'relative inline-flex shrink-0 ' + className} style={{ width: size, height: size }} aria-hidden="true">
      {online && ring && (
        <span className="absolute inset-0 rounded-full bg-emerald-400/60 animate-ping" />
      )}
      <span
        className={'relative inline-block rounded-full ' + (online ? 'bg-emerald-400' : 'bg-arc-faint/50')}
        style={{ width: size, height: size }}
      />
    </span>
  );
}

function PresencePill({ online, lastSeenAt, className = '' }) {
  const label = presenceLabel(lastSeenAt, online);
  return (
    <span
      className={
        'inline-flex items-center gap-2 rounded-full px-2.5 py-1 ring-1 text-[11px] font-medium ' +
        (online
          ? 'bg-emerald-400/10 ring-emerald-400/30 text-emerald-300'
          : 'bg-arc-surface2/60 ring-arc-border text-arc-muted') +
        ' ' + className
      }
    >
      <PresenceDot online={online} size={7} />
      <span className="whitespace-nowrap">{label}</span>
    </span>
  );
}

Object.assign(window, { presenceLabel, PresenceDot, PresencePill });

Object.assign(window, {
  Icon, SlimeLogo, Pixel, Btn, PixBadge, DeliveryBadge, STATUS_META,
  StatusPill, Avatar, Stars, Modal, Card, CopyChip, Usdc, ImageUpload,
  isImgUrl,
});
