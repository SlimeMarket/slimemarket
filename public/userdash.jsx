// ============ View 6: User Dashboard / Profile ============

// Fade-in animation for profile content after data loads.
(function () {
  if (document.getElementById('ud-anim')) return;
  const s = document.createElement('style');
  s.id = 'ud-anim';
  s.textContent =
    '@keyframes udFadeIn { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }' +
    '.ud-fade-in { animation: udFadeIn .32s cubic-bezier(.2,.8,.2,1) both; }';
  document.head.appendChild(s);
})();

// ── Buying Log helpers ───────────────────────────────────────────────
// A raw status string ("CANCELLED", "DONE") tells a buyer nothing, and the
// old row showed only the amount + the raw enum, with no order id, no time,
// and no way to open the order. These map the enum to a readable pill.
const UD_STATUS = {
  PENDING:   { label: 'Pending',   cls: 'bg-amber-500/10 text-amber-300 ring-amber-500/30' },
  PROCESS:   { label: 'Processing',cls: 'bg-indigo-500/10 text-indigo-300 ring-indigo-500/30' },
  SENT:      { label: 'Sent',      cls: 'bg-sky-500/10 text-sky-300 ring-sky-500/30' },
  DONE:      { label: 'Done',      cls: 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/30' },
  REFUNDED:  { label: 'Refunded',  cls: 'bg-amber-500/10 text-amber-300 ring-amber-500/30' },
  DISPUTED:  { label: 'Disputed',  cls: 'bg-orange-500/10 text-orange-300 ring-orange-500/30' },
  DECLINED:  { label: 'Declined',  cls: 'bg-rose-500/10 text-rose-300 ring-rose-500/30' },
  CANCELLED: { label: 'Cancelled', cls: 'bg-arc-surface2 text-arc-faint ring-arc-border' },
};
// 0.05 USDC must not render as "0.05" rounded away or "0.00": keep 2 decimals
// for normal prices, 4 for sub-cent ones.
const udFmtUsdc = (n) => {
  const v = Number(n) || 0;
  if (v === 0) return '0.00';
  return v < 0.01 ? v.toFixed(4) : v.toFixed(2);
};
const udWhen = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
};

function UserDashboard({ notify, avatarImg, onChangePin, pinChangeBusy }) {
  const avatarRef = useRef(null);
  const pickAvatar = async (file) => {
    if (!file || !file.type || !file.type.startsWith('image/')) return;

    try {
      const formData = new FormData();
      formData.append('image', file);

      const API = window.SLIME_API || '';
      const res = await fetch(API + '/api/me/avatar', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      const d = await res.json();

      if (res.ok && d.success) {
        window.location.reload();
        notify && notify('Avatar updated', 'success');
      } else {
        throw new Error(d.error || 'Upload failed');
      }
    } catch (e) {
      notify && notify('Avatar upload failed: ' + (e.message || e), 'error');
    }
  };

  // .C2: navigate to /wallet (same route app.jsx uses; popstate makes
  // the SPA switch views like navTo('balance') would).
  const goWallet = () => {
    window.SlimeRouter.pushPath('balance');
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.scrollTo && window.scrollTo(0, 0);
  };

  const [editMode, setEditMode] = useState(false);
  const [editName, setEditName] = useState(ME.name || '');
  const [editHandle, setEditHandle] = useState(ME.handle || '');
  const [saving, setSaving] = useState(false);
  const [buyOrders, setBuyOrders] = useState([]);
  const [buyOrdersLoading, setBuyOrdersLoading] = useState(false);
  // A failed checkout leaves a CANCELLED order behind, so a buyer who retried a
  // few times saw a wall of identical "CANCELLED" rows and could not find the
  // one order that actually went through. Those attempts are hidden by default,
  // EXCEPT refunds (a refund is stored as CANCELLED too — onChainStatus says so).
  const [showCancelled, setShowCancelled] = useState(false);

  useEffect(() => {
    setBuyOrdersLoading(true);
    const API = window.SLIME_API || '';
    fetch(API + '/api/my/buys', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { buys: [] })
      .then(d => setBuyOrders(d.buys || []))
      .catch(() => setBuyOrders([]))
      .finally(() => setBuyOrdersLoading(false));
  }, []);

  const saveProfile = async () => {
    setSaving(true);
    try {
      const API = window.SLIME_API || '';
      const res = await fetch(API + '/api/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName, handle: editHandle }),
      });
      const d = await res.json();
      if (res.ok) {
        ME.name = editName;
        ME.handle = editHandle;
        setEditMode(false);
        notify && notify(tr('ud.profileSaved','Profile updated successfully'), 'success');
      } else {
        notify && notify(d.error || 'Failed to save', 'error');
      }
    } catch (e) {
      notify && notify('Network error', 'error');
    }
    setSaving(false);
  };

  const stats = {
    balance: ME.usdc || 0,
    // Cancelled/declined rows are logged attempts (every failed checkout leaves
    // one), so counting them made the tile claim 9 "transactions" for a single
    // real purchase.
    transactions: buyOrders.filter(o => o.status !== 'CANCELLED' && o.status !== 'DECLINED').length,
    rating: ME.rating || 0
  };

  // Refunds are stored as CANCELLED with on_chain_status = REFUNDED — they must
  // stay visible even when cancelled attempts are hidden.
  const isRefunded = (o) => o.onChainStatus === 'REFUNDED';
  const isDeadAttempt = (o) =>
    (o.status === 'CANCELLED' || o.status === 'DECLINED') && !isRefunded(o);
  const cancelledCount = buyOrders.filter(isDeadAttempt).length;
  const visibleBuys = showCancelled ? buyOrders : buyOrders.filter(o => !isDeadAttempt(o));

  return (
    <div className="anim-view max-w-3xl mx-auto">
      {/* ── identity ─────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3 mb-8">
        <div className="min-w-0">
          <div className="text-[10px] font-pixel uppercase tracking-[0.22em] text-arc-faint">{tr('ud.profileBadge','PROFILE')}</div>
          <h1 className="mt-1.5 text-lg font-semibold tracking-tight text-white">{tr('ud.title','Dashboard')}</h1>
        </div>
        <button onClick={goWallet}
          className="inline-flex items-center gap-1.5 text-xs text-arc-muted hover:text-arc-text transition-colors">
          <Icon name="wallet" size={14} /> {tr('ud.wallet','Wallet')}
        </button>
      </div>

      {/* avatar + name */}
      <div className="flex items-center gap-4">
        <div className="relative group cursor-pointer w-16 h-16 shrink-0" onClick={() => avatarRef.current && avatarRef.current.click()}>
          <Avatar gradient={ME.avatar} img={avatarImg} name={ME.name} size={64} ring />
          <div className="absolute inset-0 rounded-xl bg-arc-bg/70 opacity-0 group-hover:opacity-100 transition flex items-center justify-center">
            <Icon name="camera" size={16} className="text-white" />
          </div>
          <input ref={avatarRef} type="file" accept="image/*" className="hidden" onChange={e => pickAvatar(e.target.files[0])} />
        </div>

        <div className="min-w-0 flex-1">
          {editMode ? (
            <input value={editName} onChange={e => setEditName(e.target.value)}
              className="w-full text-xl font-bold text-white bg-arc-bg/80 ring-1 ring-arc-border focus:ring-arc-primary/40 rounded-lg px-3 py-1 outline-none transition" />
          ) : (
            <h2 className="text-xl font-bold tracking-tight text-white truncate">{ME.name}</h2>
          )}

          <div className="mt-1 flex items-center gap-2 text-sm text-arc-muted">
            {editMode ? (
              <input value={editHandle.replace('@', '')} onChange={e => setEditHandle(e.target.value.startsWith('@') ? e.target.value : '@' + e.target.value)}
                className="text-sm text-arc-muted bg-arc-bg/80 ring-1 ring-arc-border focus:ring-arc-primary/40 rounded-md px-2 py-0.5 outline-none transition" />
            ) : (
              <span className="truncate">{ME.handle?.replace('@', '') || ME.name}</span>
            )}
            <span className="text-arc-faint/50">·</span>
            <span className="text-arc-faint whitespace-nowrap">
              {tr('ud.memberSince','member since')} {ME.joined ? new Date(ME.joined).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—'}
            </span>
          </div>

          <div className="mt-2"><CopyChip value={ME.uid || '—'} label="UID" /></div>
        </div>
      </div>

      {/* actions */}
      <div className="mt-5 flex flex-wrap gap-2">
        {editMode ? (
          <>
            <Btn variant="outline" size="sm" onClick={() => setEditMode(false)} disabled={saving}>{tr('c.cancel','Cancel')}</Btn>
            <Btn variant="emerald" size="sm" icon="check" onClick={saveProfile} loading={saving}>{tr('c.save','Save')}</Btn>
          </>
        ) : (
          <>
            <Btn variant="outline" size="sm" icon="pencil" onClick={() => { setEditName(ME.name); setEditHandle(ME.handle); setEditMode(true); }}>{tr('ud.editProfile','Edit Profile')}</Btn>
            <Btn variant="ghost" size="sm" icon="share-2" onClick={() => notify('Coming soon', 'info')}>{tr('ud.share','Share')}</Btn>
          </>
        )}
      </div>

      {/* ── inline stats ──────────────────────────────────────────────── */}
      <dl className="mt-8 flex flex-wrap items-baseline gap-x-7 gap-y-2 border-t border-arc-border/60 pt-4 text-[11px]">
        <div className="flex items-baseline gap-1.5">
          <dt className="text-arc-faint">{tr('ud.balanceLower','balance')}</dt>
          <dd className="font-mono tabular-nums text-arc-muted">
            {Number(stats.balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}
          </dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-arc-faint">{tr('ud.transactionsLower','transactions')}</dt>
          <dd className="font-mono tabular-nums text-arc-muted">{stats.transactions}</dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-arc-faint">{tr('ud.ratingLower','rating')}</dt>
          <dd className="font-mono tabular-nums text-arc-muted">{stats.rating.toFixed(1)}</dd>
        </div>
      </dl>

      {/* ── verification + contacts ───────────────────────────────────── */}
      <div className="mt-10">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-arc-faint">{tr('ud.verifStatus','Verification Status')}</h2>
        <div className="mt-1 divide-y divide-arc-border/50 border-t border-arc-border/60">
          <VerifRow label={tr('ud.walletAddress','Wallet Address')} ok={!!ME.wallet} />
          <VerifRow label={tr('ud.twoFa','2FA Authenticator')} ok={false} />
        </div>
      </div>

      <ContactsCard notify={notify} />

      {/* ── buying log ────────────────────────────────────────────────── */}
      <section className="mt-10">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[10px] uppercase tracking-[0.2em] text-arc-faint">{tr('ud.buyingLog','Buying Log')}</h2>
            {!buyOrdersLoading && buyOrders.length > 0 && (
              <span className="text-[10px] font-mono text-arc-faint tabular-nums">{stats.transactions}/{buyOrders.length}</span>
            )}
          </div>
          {cancelledCount > 0 && (
            <button type="button" onClick={() => setShowCancelled(v => !v)}
              className="text-[11px] text-arc-faint hover:text-arc-text transition-colors">
              {showCancelled ? tr('ud.hideCancelled','Hide cancelled') : tr('ud.showCancelled','Show cancelled') + ' (' + cancelledCount + ')'}
            </button>
          )}
        </div>

        {buyOrdersLoading ? (
          <div className="mt-4 space-y-4">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg animate-pulse bg-arc-surface2/40 shrink-0"></div>
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 animate-pulse bg-arc-surface2/40 rounded-lg w-1/2"></div>
                  <div className="h-2.5 animate-pulse bg-arc-surface2/40 rounded-lg w-1/3"></div>
                </div>
                <div className="space-y-1.5 text-right">
                  <div className="h-3 w-16 animate-pulse bg-arc-surface2/40 rounded-lg ml-auto"></div>
                  <div className="h-2 w-10 animate-pulse bg-arc-surface2/40 rounded-lg ml-auto"></div>
                </div>
              </div>
            ))}
          </div>
        ) : visibleBuys.length > 0 ? (
          <div className="mt-1 divide-y divide-arc-border/50 border-t border-arc-border/60">
            {visibleBuys.map(o => {
              const st = UD_STATUS[o.status] || { label: o.status || '—', cls: 'bg-arc-surface2 text-arc-muted ring-arc-border' };
              const dead = isDeadAttempt(o);
              return (
                <button key={o.id} type="button"
                  onClick={() => {
                    // Same route app.jsx uses (pushTo('orderdetail', …)); the
                    // popstate event is what makes the SPA re-render.
                    window.SlimeRouter.pushPath('orderdetail', { id: o.id });
                    window.dispatchEvent(new PopStateEvent('popstate'));
                    window.scrollTo && window.scrollTo(0, 0);
                  }}
                  className={`w-full text-left flex items-center gap-3 py-3 ${dead ? 'opacity-55' : ''}`}>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-arc-text font-medium leading-tight truncate">{o.product_name || 'Product'}</div>
                    <div className="mt-0.5 text-[11px] text-arc-faint truncate">
                      {tr('ud.from','from')} {o.store_name || 'Seller'} · {o.category || 'General'}
                    </div>
                    <div className="mt-0.5 text-[10px] text-arc-faint/70 font-mono truncate">
                      #{String(o.id || '').slice(0, 8)}
                      {udWhen(o.timestamp || o.created_at) ? ' · ' + udWhen(o.timestamp || o.created_at) : ''}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`font-mono text-[13px] tabular-nums ${dead ? 'text-arc-muted' : 'text-emerald-400'}`}>
                      {udFmtUsdc(o.amount)} <span className="text-[10px] text-arc-faint">USDC</span>
                    </div>
                    <div className="mt-0.5 flex justify-end">
                      <span className={`inline-block text-[9px] leading-none px-1.5 py-1 rounded ring-1 uppercase tracking-[0.1em] ${st.cls}`}>{st.label}</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="mt-3 border-t border-arc-border/60 py-10 text-center">
            <div className="text-[13px] text-arc-muted">
              {cancelledCount > 0 ? tr('ud.noCompleted','No completed purchases yet') : tr('ud.noPurchases','No purchases yet')}
            </div>
            <div className="mt-1 text-[11px] text-arc-faint">
              {cancelledCount > 0
                ? cancelledCount + ' ' + tr('ud.cancelledHint','cancelled checkout attempts are hidden')
                : tr('ud.browseHint','Browse the marketplace to find something')}
            </div>
            {cancelledCount > 0 && (
              <button type="button" onClick={() => setShowCancelled(true)}
                className="mt-3 text-[11px] text-arc-accent hover:brightness-125 transition">
                {tr('ud.showCancelled','Show cancelled') + ' (' + cancelledCount + ')'}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );}

function VerifRow({ label, ok, pending }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <span className={`text-[13px] ${ok ? 'text-arc-muted' : 'text-arc-faint'}`}>{label}</span>
      <span className={`text-[10px] uppercase tracking-[0.12em] ${ok ? 'text-emerald-400/80' : pending ? 'text-amber-300/90' : 'text-arc-faint'}`}>
        {ok ? 'OK' : pending ? tr('ud.pending','PENDING') : '—'}
      </span>
    </div>
  );
}

function ContactsCard({ notify }) {
  const [c, setC] = useState({ ...ME.contacts });
  const [edit, setEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const rows = [
    { key: 'discord', label: 'Discord', icon: 'message-square', color: 'text-indigo-300', ring: 'ring-indigo-500/30 bg-indigo-500/10' },
    { key: 'telegram', label: 'Telegram', icon: 'send', color: 'text-sky-300', ring: 'ring-sky-500/30 bg-sky-500/10' },
    { key: 'x', label: 'X', icon: 'at-sign', color: 'text-arc-text', ring: 'ring-arc-border bg-arc-surface2' },
  ];
  const save = async () => {
    setSaving(true);
    try {
      const API = window.SLIME_API || '';
      const res = await fetch(API + '/api/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contacts: c }),
      });
      if (res.ok) {
        ME.contacts = { ...c };
        setEdit(false);
        notify && notify(tr('ud.contactsSaved','Contacts saved'), 'success');
      } else {
        notify && notify('Failed to save', 'error');
      }
    } catch (e) {
      notify && notify('Network error', 'error');
    }
    setSaving(false);
  };
  return (
    <div className="mt-10">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10px] uppercase tracking-[0.2em] text-arc-faint">{tr('ud.contacts','Contacts')}</span>
        <button onClick={() => edit ? save() : setEdit(true)} disabled={saving} className="text-[11px] text-arc-faint hover:text-arc-text transition-colors inline-flex items-center gap-1">
          <Icon name={edit ? 'check' : 'pencil'} size={11} /> {edit ? tr('c.save','Save') : tr('c.edit','Edit')}
        </button>
      </div>
      <div className="mt-1 divide-y divide-arc-border/50 border-t border-arc-border/60">
        {rows.map(r => (
          <div key={r.key} className="flex items-center gap-3 py-2.5">
            <Icon name={r.icon} size={14} className={r.color + ' shrink-0'} />
            <div className="flex-1 min-w-0">
              <div className="text-[10px] uppercase tracking-[0.12em] text-arc-faint">{r.label}</div>
              {edit ? (
                <input value={c[r.key] || ''} onChange={e => setC(prev => ({ ...prev, [r.key]: e.target.value }))}
                  className="w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-lg px-2.5 h-8 text-sm text-arc-text outline-none transition-all duration-200 hover:ring-arc-borderlt mt-0.5" />
              ) : (
                <div className="text-sm text-arc-text truncate">{c[r.key] || <span className="text-arc-faint">—</span>}</div>
              )}
            </div>
            {!edit && c[r.key] && (
              <button onClick={() => { navigator.clipboard?.writeText(c[r.key]); notify && notify(r.label + ' ' + tr('ud.copied','copied'), 'info'); }}
                className="text-arc-faint hover:text-arc-text transition-colors"><Icon name="copy" size={13} /></button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { UserDashboard });
