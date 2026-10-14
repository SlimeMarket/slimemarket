// ============ SlimeMarket — PIN Status Badge (.C2) ============
// Reusable at-a-glance indicator for the user's Circle UCW PIN state.
// Mounts in headers/navbars/profile rows. Self-contained: no fetch logic,
// it just renders whatever { status } you hand it (caller pulls
// /api/my/pin-status and maps pinStatus → ENABLED | UNSET | LOCKED).

// Usage:
//   <PinStatusBadge status="ENABLED" />            → ✅ Enabled + green
//   <PinStatusBadge status="UNSET" />              → ⚠️ Not Set + amber
//   <PinStatusBadge status="LOCKED" unlockedAt={Date} /> → 🔒 Locked + red + countdown
//   <PinStatusBadge status="ENABLED" size="sm" />  → compact pill (badge)
//   <PinStatusBadge status="ENABLED" size="md" />  → medium card-style row
//   <PinStatusBadge isLoading />                   → animated skeleton placeholder

// Design: Arc dark theme, premium ring borders, 8px grid spacing.
// Counts down in-place when LOCKED (re-renders every 1s) so the user sees
// the lock lift in real time without re-fetching the status endpoint.

const { useState: _psb_useState, useEffect: _psb_useEffect } = React;

// ---- helpers (module-local, not exported) ----
function _psb_pad(n) { return String(n).padStart(2, '0'); }

// ISO/ms/Date → ms remaining vs "now". Negative → 0 (already unlocked).
function _psb_msRemaining(unlockedAt) {
  if (unlockedAt == null) return 0;
  const t = new Date(unlockedAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, t - Date.now());
}

// Format ms → "2h:30m:12s" (compact) or "30m:12s" / "12s" as it shrinks.
function _psb_fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const hours = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hours > 0) return `${hours}h:${_psb_pad(mins)}m:${_psb_pad(secs)}s`;
  if (mins > 0) return `${mins}m:${_psb_pad(secs)}s`;
  return `${secs}s`;
}

// Local icon (module-safe; falls back to global if present)
function _psb_Icon({ name, size = 16, className = '' }) {
  const lib = (window.lucide && window.lucide.icons) || {};
  const pascal = name.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join('');
  const node = lib[pascal] || lib[name];
  if (!node) return null;
  const children = (Array.isArray(node) && Array.isArray(node[2])) ? node[2] : (node.children || []);
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round',
    strokeLinejoin: 'round', className,
  }, children.map((c, i) => React.createElement(c[0], { key: i, ...c[1] })));
}

// Animated skeleton placeholder for loading state
function _psb_Skeleton({ size = 'md' }) {
  const dims = size === 'sm' ? 'w-24 h-6' : 'w-40 h-10';
  return (
    <div className={`${dims} bg-arc-surface2 rounded-lg animate-pulse ring-1 ring-arc-border/50`}></div>
  );
}

/**
 * <PinStatusBadge />
 * @param {('ENABLED'|'UNSET'|'LOCKED')} status
 * @param {number|string|Date} [unlockedAt] — ISO / epoch / Date when LOCKED ends
 * @param {('sm'|'md')} [size] — sm = compact pill (badge), md = card-style row
 * @param {string} [className] — extra classes (merge)
 * @param {boolean} [compact] — drop the label text (icon-only pill)
 * @param {boolean} [isLoading] — render animated skeleton placeholder
 * @param {boolean} [showPulse] — subtle pulse on the dot (default true for LOCKED)
 */
function PinStatusBadge({
  status = 'ENABLED',
  unlockedAt,
  size = 'sm',
  className = '',
  compact = false,
  isLoading = false,
  showPulse,
}) {
  // Live countdown for LOCKED — re-render every second so the timer ticks.
  const [now, setNow] = _psb_useState(Date.now());
  _psb_useEffect(() => {
    if (status !== 'LOCKED') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  // Skeleton placeholder while loading (no spinner — animated pulse only)
  if (isLoading) return <_psb_Skeleton size={size} />;

  const meta = {
    ENABLED: {
      icon: 'shield-check',
      glyph: '✅',
      label: tr('pinbadge.enabled', 'Enabled'),
      ring: 'ring-emerald-500/40 bg-emerald-500/10 text-emerald-300',
      dot: 'bg-emerald-400',
      pulse: false,
    },
    UNSET: {
      icon: 'alert-triangle',
      glyph: '⚠️',
      label: tr('pinbadge.notSet', 'Not Set'),
      ring: 'ring-amber-500/40 bg-amber-500/10 text-amber-300',
      dot: 'bg-amber-400',
      pulse: false,
    },
    LOCKED: {
      icon: 'lock',
      glyph: '🔒',
      label: tr('pinbadge.locked', 'Locked'),
      ring: 'ring-rose-500/40 bg-rose-500/10 text-rose-300',
      dot: 'bg-rose-400',
      pulse: showPulse !== false,
    },
  }[status] || {
    icon: 'help-circle',
    glyph: '•',
    label: status || 'Unknown',
    ring: 'ring-arc-border bg-arc-surface2 text-arc-muted',
    dot: 'bg-arc-faint',
    pulse: false,
  };

  const ms = _psb_msRemaining(unlockedAt);
  const stillLocked = status === 'LOCKED' && ms > 0;
  // Guard against stale "now" dependency warning — used to force recompute.
  void now;

  // Medium (card) size: premium row with icon + label + countdown line
  if (size === 'md') {
    return (
      <div
        className={`flex items-center gap-2.5 rounded-xl ring-1 backdrop-blur px-3 py-2 h-14 ${meta.ring} ${className}`}
        role="status"
        aria-label={`PIN ${meta.label}`}
        title={stillLocked ? tr('pinbadge.lockedUntil', 'Locked until') + ' ' + new Date(Number(unlockedAt)).toLocaleTimeString() : undefined}
      >
        <span className="relative flex items-center justify-center shrink-0" style={{ width: 22, height: 22 }}>
          {meta.pulse && (
            <span className={`animate-ping absolute inline-flex h-3.5 w-3.5 rounded-full ${meta.dot} opacity-60`}></span>
          )}
          <span className={`relative inline-flex items-center justify-center rounded-full h-5 w-5 ${meta.dot}/20`}>
            <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${meta.dot}`}></span>
          </span>
        </span>
        <div className="flex-1 min-w-0">
          {!compact && (
            <div className="text-sm font-semibold leading-none">{meta.label}</div>
          )}
          {stillLocked && (
            <div className="text-[10px] text-arc-faint mt-1 flex items-center gap-1">
              <_psb_Icon name="clock" size={9} />
              {tr('pinbadge.unlockIn', 'Unlock in')} {_psb_fmtDuration(ms)}
            </div>
          )}
          {!stillLocked && !compact && status === 'ENABLED' && (
            <div className="text-[10px] text-arc-faint mt-1">{tr('pinbadge.secured', 'Wallet secured')}</div>
          )}
          {!stillLocked && !compact && status === 'UNSET' && (
            <div className="text-[10px] text-arc-faint mt-1">{tr('pinbadge.setupNeeded', 'Setup required')}</div>
          )}
        </div>
      </div>
    );
  }

  // Default: compact pill (sm badge)
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg ring-1 px-2.5 py-1 text-[11px] font-medium leading-none ${meta.ring} ${className}`}
      role="status"
      aria-label={`PIN ${meta.label}`}
      title={stillLocked ? tr('pinbadge.lockedUntil', 'Locked until') + ' ' + new Date(Number(unlockedAt)).toLocaleTimeString() : undefined}
    >
      <span className="relative flex items-center justify-center" style={{ width: 14, height: 14 }}>
        {meta.pulse && (
          <span className={`animate-ping absolute inline-flex h-2.5 w-2.5 rounded-full ${meta.dot} opacity-60`}></span>
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${meta.dot}`}></span>
      </span>
      {!compact && (
        <span className="inline-flex items-center gap-1">
          {stillLocked
            ? tr('pinbadge.lockedFor', 'Locked') + ' ' + _psb_fmtDuration(ms)
            : meta.label}
        </span>
      )}
    </span>
  );
}

Object.assign(window, { PinStatusBadge });
