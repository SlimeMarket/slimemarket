// ============ SlimeMarket — PIN Management Hub (.C2) ============
// Dedicated "Wallet Security" surface surfaced from the user dashboard.
// Trusts Circle's hosted UI for the actual PIN change (never builds a
// custom PIN form — that would mean touching the raw PIN in JS, which
// the Circle skill Security Rule forbids).

// Routes used:
//   GET  /api/my/pin-status   → { pinStatus, provisioned, lockedUntil? }
//   POST /api/my/pin-change   → { challengeId } (Circle hosted UI)
//   POST /api/my/pin-restore  → restores via security questions
//   GET  /api/my/ucw-credentials (called internally by executeUcwChallenge)

// Flow:
//   - boot fetches pin-status once → renders ENABLED/UNSET/LOCKED badge card
//   - "Change PIN" → POST /api/my/pin-change → window.executeUcwChallenge(id)
//     → on resolve: success toast; on reject: error toast + Retry; cancel = info
//   - "Reset PIN (Forgot)" → /forgot-pin (email verification flow)
//   - "Restore via Questions" → POST /api/my/pin-restore → executeUcwChallenge

// Design: shadcn/ui-style premium cards (ring borders, hover lift),
// Arc dark theme, 8px-grid spacing. Skeletons during every API call.

const { useState: _pm_useState, useEffect: _pm_useEffect } = React;

// ---- local helpers ----
function _pm_truncAddr(a) {
  if (!a || typeof a !== 'string') return null;
  const s = a.trim();
  if (s.length <= 12) return s;
  return s.slice(0, 6) + '...' + s.slice(-4);
}

// Skeleton block — matches Card padding rhythm (8px grid)
function _pm_Skeleton({ className = '' }) {
  return <div className={'animate-pulse rounded-lg bg-arc-surface2 ' + className} />;
}

// Premium shadcn-style card: ring + hover lift + glow on the accent.
function _pm_SecCard({ icon, title, desc, badge, children, accent = 'arc' }) {
  const accentRing = {
    arc: 'hover:ring-arc-primary/50 hover:shadow-glow',
    emerald: 'hover:ring-emerald-500/50 hover:shadow-glow-emerald',
    amber: 'hover:ring-amber-500/50',
    rose: 'hover:ring-rose-500/50',
    cyan: 'hover:ring-cyan-500/50',
  }[accent] || 'hover:ring-arc-primary/50';
  const iconWrap = {
    arc: 'bg-arc-primary/15 text-arc-accent ring-arc-primary/25',
    emerald: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/25',
    amber: 'bg-amber-500/15 text-amber-300 ring-amber-500/25',
    rose: 'bg-rose-500/15 text-rose-300 ring-rose-500/25',
    cyan: 'bg-cyan-500/15 text-cyan-300 ring-cyan-500/25',
  }[accent] || 'bg-arc-primary/15 text-arc-accent ring-arc-primary/25';
  return (
    <Card className={'p-5 transition-all duration-200 ring-arc-border hover:-translate-y-0.5 ' + accentRing}>
      <div className="flex items-start gap-3">
        <div className={'w-10 h-10 rounded-xl ring-1 flex items-center justify-center shrink-0 ' + iconWrap}>
          <Icon name={icon} size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-semibold text-white">{title}</h3>
            {badge}
          </div>
          <p className="text-[12px] text-arc-muted mt-1 leading-relaxed">{desc}</p>
          {children && <div className="mt-3.5">{children}</div>}
        </div>
      </div>
    </Card>
  );
}

/**
 * <PinManagement />
 * @param {(text:string, type?:'info'|'success'|'error')=>void} notify — toast fn
 * @param {()=>void} [onSetupPin] — optional override for "Set up now"
 * @param {string} [walletAddress] — optional pre-known wallet (avoids extra fetch)
 * @param {()=>Promise<void>} [onChangePin] — optional Change PIN override (app.jsx wrapper)
 * @param {boolean} [pinChangeBusy] — mirrors app.jsx wrapper busy flag
 */
function PinManagement({ notify, onSetupPin, walletAddress, onChangePin, pinChangeBusy }) {
  const API = window.SLIME_API || '';
  const [status, _pm_setStatus] = _pm_useState(null); // { pinStatus, provisioned, lockedUntil, walletAddress, devMode }
  const setStatus = (s) => _pm_setStatus(typeof s === 'function' ? s : s);
  const [loading, setLoading] = _pm_useState(true);
  const [error, setError] = _pm_useState('');

  // per-card loading flags (so each action shows its own skeleton)
  const [busy, setBusy] = _pm_useState({ change: false, restore: false });

  // ---- boot: fetch pin-status once ----
  _pm_useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const r = await fetch(API + '/api/my/pin-status', { credentials: 'include' });
        if (r.status === 401) { setError('Please sign in to manage your PIN.'); return; }
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Failed to load PIN status'); }
        const d = await r.json();
        if (!alive) return;
        setStatus({
          pinStatus: d.pinStatus || 'UNSET',
          provisioned: !!d.provisioned,
          lockedUntil: d.lockedUntil || null,
          walletAddress: walletAddress || (window.ME && window.ME.wallet) || null,
          devMode: !!d.devMode,
          needsReprovision: !!d.needsReprovision,
        });
      } catch (e) {
        if (alive) setError(e.message || 'Failed to load PIN status');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Change PIN via Circle hosted UI ----
  // If the parent (app.jsx) provides onChangePin, prefer it — the wrapper
  // already wires the info/success/error/cancel toasts + session-expiry
  // redirect. Fall back to the internal implementation otherwise.
  const handleChangePin = async () => {
    if (busy.change || pinChangeBusy) return;
    if (typeof onChangePin === 'function') {
      // Delegate to the app.jsx wrapper flow. After it resolves, refresh
      // the local status so the badge reflects the new PIN state.
      try {
        await onChangePin();
      } finally {
        const sr = await fetch(API + '/api/my/pin-status', { credentials: 'include' }).catch(() => null);
        if (sr && sr.ok) { const sd = await sr.json(); setStatus(s => ({ ...s, pinStatus: sd.pinStatus, lockedUntil: sd.lockedUntil })); }
      }
      return;
    }
    if (typeof window.executeUcwChallenge !== 'function') {
      notify && notify(tr('pinchange.noSdk', 'Wallet SDK not loaded — reload and try again'), 'error');
      return;
    }
    setBusy(b => ({ ...b, change: true }));
    try {
      const r = await fetch(API + '/api/my/pin-change', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401) {
          notify && notify(tr('pinchange.sessionExpired', 'Session expired — refreshing...'), 'error');
          if (window.redirectToRefreshSession) window.redirectToRefreshSession();
          return;
        }
        throw new Error(d.error || 'Failed to start PIN change');
      }
      if (!d.challengeId) throw new Error('No challenge returned by server');
      // Open Circle hosted UI (old PIN → new PIN). This Promise resolves
      // on success, rejects on error OR user cancel (err.message carries it).
      try {
        await window.executeUcwChallenge(d.challengeId);
        notify && notify(tr('pinchange.success', 'Your PIN has been updated successfully'), 'success');
        // refresh status so the badge reflects the new state
        const sr = await fetch(API + '/api/my/pin-status', { credentials: 'include' });
        if (sr.ok) { const sd = await sr.json(); setStatus(s => ({ ...s, pinStatus: sd.pinStatus, lockedUntil: sd.lockedUntil })); }
      } catch (chErr) {
        const msg = (chErr && chErr.message) || String(chErr);
        // Circle SDK rejects on cancel too — distinguish by message.
        const cancelled = /cancel|abort|closed|dismiss/i.test(msg);
        if (cancelled) {
          notify && notify(tr('pinchange.cancelled', 'PIN change cancelled'), 'info');
        } else {
          notify && notify(tr('pinchange.failed', 'Failed to change PIN') + ': ' + msg, 'error');
        }
      }
    } catch (e) {
      notify && notify(tr('pinchange.failed', 'Failed to change PIN') + ': ' + (e.message || e), 'error');
    } finally {
      setBusy(b => ({ ...b, change: false }));
    }
  };

  // ---- Restore via security questions ----
  const handleRestore = async () => {
    if (busy.restore) return;
    if (typeof window.executeUcwChallenge !== 'function') {
      notify && notify(tr('pinrestore.noSdk', 'Wallet SDK not loaded — reload and try again'), 'error');
      return;
    }
    setBusy(b => ({ ...b, restore: true }));
    try {
      const r = await fetch(API + '/api/my/pin-restore', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 401) {
          notify && notify(tr('pinrestore.sessionExpired', 'Session expired — refreshing...'), 'error');
          if (window.redirectToRefreshSession) window.redirectToRefreshSession();
          return;
        }
        throw new Error(d.error || 'Failed to start PIN restore');
      }
      if (!d.challengeId) throw new Error('No challenge returned by server');
      try {
        await window.executeUcwChallenge(d.challengeId);
        notify && notify(tr('pinrestore.success', 'PIN restored successfully'), 'success');
        // refresh status
        const sr = await fetch(API + '/api/my/pin-status', { credentials: 'include' });
        if (sr.ok) { const sd = await sr.json(); setStatus(s => ({ ...s, pinStatus: sd.pinStatus, lockedUntil: sd.lockedUntil })); }
      } catch (chErr) {
        const msg = (chErr && chErr.message) || String(chErr);
        const cancelled = /cancel|abort|closed|dismiss/i.test(msg);
        if (cancelled) {
          notify && notify(tr('pinrestore.cancelled', 'PIN restore cancelled'), 'info');
        } else {
          notify && notify(tr('pinrestore.failed', 'Failed to restore PIN') + ': ' + msg, 'error');
        }
      }
    } catch (e) {
      notify && notify(tr('pinrestore.failed', 'Failed to restore PIN') + ': ' + (e.message || e), 'error');
    } finally {
      setBusy(b => ({ ...b, restore: false }));
    }
  };

  // ---- Render loading skeleton for main status card ----
  if (loading) {
    return (
      <div className="space-y-4">
        <_pm_Skeleton className="h-20 w-full" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <_pm_Skeleton className="h-32" />
          <_pm_Skeleton className="h-32" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 bg-rose-500/10 border border-rose-500/30 rounded-xl">
        <div className="flex items-center gap-2 text-rose-400">
          <Icon name="octagon-alert" size={18} />
          <span className="text-sm font-medium">{error}</span>
        </div>
      </div>
    );
  }

  const pinStatus = status?.pinStatus || 'UNSET';
  const wallet = status?.walletAddress || null;

  return (
    <div className="space-y-4">
      {/* Status Card */}
      <Card className="p-5 ring-1 ring-arc-border">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-arc-primary to-arc-accent flex items-center justify-center text-white shadow-glow ring-1 ring-arc-primary/50">
            <Icon name="shield-check" size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-white mb-1">Wallet security</h3>
            <p className="text-[12px] text-arc-muted leading-relaxed">
              Your Slime Wallet is authorised by your email sign-in. Circle manages the wallet
              keys for email accounts, so there is no PIN for you to set, change or reset.
            </p>
          </div>
          <PinStatusBadge status={pinStatus} unlockedAt={status?.lockedUntil} size="sm" showPulse />
        </div>
        {wallet && (
          <div className="mt-4 flex items-center gap-2">
            <Icon name="wallet" size={13} className="text-arc-faint" />
            <CopyChip label="Wallet:" value={wallet} displayValue={_pm_truncAddr(wallet)} />
          </div>
        )}
      </Card>

      {/* Opsi A (2026-09-27) — PIN management removed from the UI.
          Circle auto-provisions the PIN + security questions for authMode EMAIL
          accounts (see Circle docs "Authentication Types > Email"), and email OTP
          is our ONLY sign-in — so every account is EMAIL. The user therefore never
          chose a PIN, which made "Change PIN" / "Reset PIN" / "Restore via security
          questions" unusable: they cannot supply an old PIN or their security
          answers. The handlers (handleChangePin / handleRestore) are kept for a
          future PIN-based auth mode. */}
      <div className="p-4 rounded-xl bg-arc-bg/40 ring-1 ring-arc-border/50">
        <div className="flex items-start gap-2.5">
          <Icon name="info" size={14} className="text-arc-faint mt-0.5 shrink-0" />
          <p className="text-[12px] text-arc-muted leading-relaxed">
            Nothing to set up here. Your Slime Wallet is authorised by your email sign-in, and
            Circle holds the wallet keys for email accounts — so there is no PIN to create,
            change or reset.
          </p>
        </div>
      </div>

      {/* Info Footer */}
      <div className="p-4 bg-arc-bg/40 rounded-xl ring-1 ring-arc-border/50 text-center">
        <div className="flex items-center justify-center gap-2 text-[11px] text-arc-faint">
          <Icon name="info" size={12} />
          <span>
            For security reasons, never share your PIN. Circle's hosted UI ensures your PIN is never exposed to this app.
          </span>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { PinManagement });
