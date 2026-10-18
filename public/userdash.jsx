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
    <div className="anim-view">
      <div className="flex items-center gap-2.5 mb-5 flex-wrap">
        <h1 className="text-2xl font-bold tracking-tight text-white">{tr('ud.title','Dashboard')}</h1>
        <PixBadge color="blue">{tr('ud.profileBadge','PROFILE')}</PixBadge>
        <button onClick={goWallet}
          className="ml-auto text-sm text-arc-accent hover:brightness-125 inline-flex items-center gap-1.5 transition-all duration-200 hover:-translate-y-0.5">
          <Icon name="wallet" size={15} /> {tr('ud.wallet','Wallet')} <Icon name="chevron-right" size={14} />
        </button>
      </div>

      {/* profile header */}
      <div className="relative overflow-hidden rounded-3xl ring-1 ring-arc-border bg-gradient-to-br from-arc-surface to-arc-surface2/50 mb-5 transition-all duration-300 hover:shadow-glow">
        <div className="px-6 py-5 flex flex-col sm:flex-row sm:items-end gap-4 relative z-20">
          <div className="relative group cursor-pointer w-20 h-20" onClick={() => avatarRef.current && avatarRef.current.click()}>
            <Avatar gradient={ME.avatar} img={avatarImg} name={ME.name} size={80} ring />
            <div className="absolute inset-0 rounded-xl bg-arc-bg/60 opacity-0 group-hover:opacity-100 transition flex flex-col items-center justify-center gap-0.5">
              <Icon name="camera" size={18} className="text-white" />
              <span className="text-[9px] text-white font-medium">{tr('ud.changePhoto','Change Photo')}</span>
            </div>
            <input ref={avatarRef} type="file" accept="image/*" className="hidden" onChange={e => pickAvatar(e.target.files[0])} />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2.5 flex-wrap">
              {editMode ? (
                <input value={editName} onChange={e => setEditName(e.target.value)}
                  className="text-xl font-bold text-white bg-arc-bg/80 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-lg px-3 py-1 outline-none z-30 relative transition-all duration-200 hover:ring-arc-borderlt" />
              ) : (
                <h2 className="text-2xl font-bold tracking-tight text-white">{ME.name}</h2>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              {editMode ? (
                <input value={editHandle.replace('@', '')} onChange={e => setEditHandle(e.target.value.startsWith('@') ? e.target.value : '@' + e.target.value)}
                  className="text-sm text-arc-muted bg-arc-bg/80 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-lg px-2 py-0.5 outline-none z-30 relative transition-all duration-200 hover:ring-arc-borderlt" />
              ) : (
                <span className="text-base text-arc-muted">{ME.handle?.replace('@', '') || ME.name}</span>
              )}
              <span className="text-sm text-arc-faint">· {tr('ud.memberSince','member since')} {ME.joined ? new Date(ME.joined).toLocaleDateString('en-US',{month:'short',year:'numeric'}) : '—'}</span>
            </div>
            {/* .C2: UID row */}
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <CopyChip value={ME.uid || '—'} label="UID" />
            </div>
          </div>
          <div className="flex gap-2 relative z-30">
            {editMode ? (
              <>
                <Btn variant="outline" size="sm" onClick={() => setEditMode(false)} disabled={saving} className="transition-all duration-200 hover:-translate-y-0.5">{tr('c.cancel','Cancel')}</Btn>
                <Btn variant="emerald" size="sm" icon="check" onClick={saveProfile} loading={saving} className="transition-all duration-200 hover:shadow-glow">{tr('c.save','Save')}</Btn>
              </>
            ) : (
              <>
                <Btn variant="outline" size="sm" icon="pencil" onClick={() => { setEditName(ME.name); setEditHandle(ME.handle); setEditMode(true); }} className="transition-all duration-200 hover:-translate-y-0.5">{tr('ud.editProfile','Edit Profile')}</Btn>
                <Btn variant="outline" size="sm" icon="share-2" onClick={() => notify('Coming soon', 'info')} className="transition-all duration-200 hover:-translate-y-0.5">{tr('ud.share','Share')}</Btn>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Stats grid — premium gradient cards with hover lift */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-5 ud-fade-in">
        {/* Balance card */}
        <Card className="p-5 bg-gradient-to-br from-arc-primary/10 to-arc-surface ring-1 ring-arc-primary/30 shadow-glow-emerald transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glow hover:ring-arc-primary/50">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center ring-1 ring-emerald-500/30">
              <Icon name="wallet" size={20} className="text-emerald-400" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-arc-muted">{tr('ud.walletBalance','Wallet Balance')}</div>
              <div className="text-2xl font-bold text-emerald-400 font-mono tabular-nums">
                {Number(stats.balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}
                <span className="text-xs text-arc-faint ml-1">USDC</span>
              </div>
            </div>
          </div>
        </Card>

        {/* Transaction count card */}
        <Card className="p-5 bg-gradient-to-br from-arc-surface to-arc-surface2/50 ring-1 ring-arc-border transition-colors duration-200 hover:ring-arc-borderlt">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-10 h-10 rounded-xl bg-arc-accent/15 flex items-center justify-center ring-1 ring-arc-accent/30">
              <Icon name="history" size={20} className="text-arc-accent" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-arc-muted">{tr('ud.transactions','Transactions')}</div>
              <div className="text-2xl font-bold text-arc-text">{stats.transactions}</div>
            </div>
          </div>
        </Card>

        {/* Rating card */}
        <Card className="p-5 bg-gradient-to-br from-arc-surface to-arc-surface2/50 ring-1 ring-arc-border transition-colors duration-200 hover:ring-arc-borderlt">
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center ring-1 ring-amber-500/30">
              <Icon name="star" size={20} className="text-amber-400" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-arc-muted">{tr('ud.rating','Rating')}</div>
              <div className="flex items-center gap-1 mt-0.5">
                <Stars value={stats.rating} size={14} />
                <span className="text-2xl font-bold text-arc-text">{stats.rating.toFixed(1)}</span>
              </div>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* LEFT: verification + contacts */}
        <div className="space-y-5">
          {/* Verification */}
          <Card className="p-5 bg-arc-surface/70 transition-colors duration-200">
            <div className="flex items-center gap-2 mb-3">
              <Icon name="user-check" size={16} className="text-arc-accent" />
              <span className="text-base font-semibold text-arc-text">{tr('ud.verifStatus','Verification Status')}</span>
            </div>
            <div className="space-y-2.5">
              <VerifRow label={tr('ud.walletAddress','Wallet Address')} ok={!!ME.wallet} />
              <VerifRow label={tr('ud.twoFa','2FA Authenticator')} ok={false} />
            </div>
          </Card>

          {/* Opsi A (2026-09-27) — "Wallet PIN Security" hub REMOVED.
              Circle auto-provisions PIN + security questions for authMode EMAIL,
              which is every account (email OTP is the only sign-in), so there was
              never a user-chosen PIN to change or restore. PinManagement is still
              defined (public/pin-management.jsx) for a future PIN-based auth mode. */}

          {/* Contacts */}
          <ContactsCard notify={notify} />
        </div>

        {/* RIGHT: buying log */}
        <div className="lg:col-span-2">
          {/* Buying Log */}
          <Card className="overflow-hidden bg-gradient-to-br from-arc-surface to-arc-surface2/50 ud-fade-in">
            <div className="flex items-center gap-2 px-5 py-3.5 border-b border-arc-border">
              <Icon name="shopping-bag" size={16} className="text-emerald-400" />
              <span className="text-sm font-semibold text-arc-text">{tr('ud.buyingLog','Buying Log')}</span>
              {!buyOrdersLoading && buyOrders.length > 0 && (
                <span className="text-[10px] font-pixel text-arc-faint ml-1">
                  {stats.transactions}/{buyOrders.length} {tr('ud.orders','ORDERS')}
                </span>
              )}
              {cancelledCount > 0 && (
                <button type="button" onClick={() => setShowCancelled(v => !v)}
                  className="ml-auto text-[10px] text-arc-faint hover:text-arc-accent transition-colors">
                  {showCancelled
                    ? tr('ud.hideCancelled','Hide cancelled')
                    : tr('ud.showCancelled','Show cancelled') + ' (' + cancelledCount + ')'}
                </button>
              )}
            </div>
            <div className="divide-y divide-arc-border/60">
              {buyOrdersLoading ? (
                <div className="px-5 py-4 space-y-4">
                  {[...Array(4)].map((_, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-xl animate-pulse bg-arc-surface2/40 shrink-0 rounded-lg"></div>
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
              ) : visibleBuys.length > 0 ? visibleBuys.map(o => {
                const refunded = isRefunded(o);
                const st = UD_STATUS[refunded ? 'REFUNDED' : o.status] || { label: o.status || '—', cls: 'bg-arc-surface2 text-arc-muted ring-arc-border' };
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
                    className={`w-full text-left flex items-center gap-3 px-5 py-3.5 hover:bg-arc-surface2/40 transition-all duration-200 hover-lift-row ${dead ? 'opacity-55' : ''}`}>
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 rounded-lg ${dead ? 'bg-arc-surface2 text-arc-faint' : 'bg-emerald-500/15 text-emerald-400'}`}>
                      <Icon name="package" size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-arc-text font-medium leading-tight truncate">{o.product_name || 'Product'}</div>
                      <div className="text-xs text-arc-faint truncate">
                        {tr('ud.from','from')} {o.store_name || 'Seller'} · {o.category || 'General'}
                      </div>
                      <div className="text-[11px] text-arc-faint/80 font-mono truncate">
                        #{String(o.id || '').slice(0, 8)}
                        {udWhen(o.timestamp || o.created_at) ? ' · ' + udWhen(o.timestamp || o.created_at) : ''}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={`font-mono text-base ${dead ? 'text-arc-muted' : 'text-emerald-400'}`}>
                        {udFmtUsdc(o.amount)} <span className="text-[11px] text-arc-faint">USDC</span>
                      </div>
                      <span className={`inline-block mt-1 text-[11px] px-2 py-1 rounded-md ring-1 ${st.cls}`}>{st.label}</span>
                    </div>
                    <Icon name="chevron-right" size={14} className="text-arc-faint shrink-0" />
                  </button>
                );
              }) : (
                <div className="py-16 flex flex-col items-center gap-4 text-center ud-fade-in">
                  <div className="w-20 h-20 rounded-2xl bg-arc-surface2/60 ring-1 ring-arc-border flex items-center justify-center transition-transform duration-300 hover:scale-110">
                    <Icon name="shopping-bag" size={32} className="text-arc-faint" />
                  </div>
                  <div>
                    <div className="text-base font-semibold text-arc-text">
                      {cancelledCount > 0
                        ? tr('ud.noCompleted','No completed purchases yet')
                        : tr('ud.noPurchases','No purchases yet')}
                    </div>
                    <div className="text-xs text-arc-faint mt-1">
                      {cancelledCount > 0
                        ? cancelledCount + ' ' + tr('ud.cancelledHint','cancelled checkout attempts are hidden')
                        : tr('ud.browseHint','Browse the marketplace to find something')}
                    </div>
                  </div>
                  {cancelledCount > 0 && (
                    <button type="button" onClick={() => setShowCancelled(true)}
                      className="text-xs text-arc-accent hover:brightness-125 transition-all">
                      {tr('ud.showCancelled','Show cancelled') + ' (' + cancelledCount + ')'}
                    </button>
                  )}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function VerifRow({ label, ok, pending }) {
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <div className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 ${ok ? 'bg-emerald-500/20 text-emerald-400' : pending ? 'bg-amber-500/20 text-amber-400' : 'bg-arc-surface2 text-arc-faint'} rounded-lg`}>
        <Icon name={ok ? 'check' : pending ? 'loader' : 'minus'} size={13} className={pending ? 'animate-spin' : ''} />
      </div>
      <span className={`text-sm ${ok ? 'text-arc-muted' : 'text-arc-faint'}`}>{label}</span>
      {ok && <span className="ml-auto text-[11px] text-emerald-400/80 font-pixel">OK</span>}
      {pending && <span className="ml-auto text-[11px] text-amber-400/80 font-pixel">{tr('ud.pending','PENDING')}</span>}
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
    <Card className="p-5 bg-arc-surface/70 transition-colors duration-200">
      <div className="flex items-center gap-2 mb-3">
        <Icon name="contact" size={16} className="text-arc-accent" />
        <span className="text-base font-semibold text-arc-text">{tr('ud.contacts','Contacts')}</span>
        <button onClick={() => edit ? save() : setEdit(true)} disabled={saving} className="ml-auto text-xs text-arc-accent hover:brightness-125 inline-flex items-center gap-1 transition-all duration-200 hover:-translate-y-0.5">
          <Icon name={edit ? 'check' : 'pencil'} size={12} /> {edit ? tr('c.save','Save') : tr('c.edit','Edit')}
        </button>
      </div>
      <div className="space-y-3">
        {rows.map(r => (
          <div key={r.key} className="flex items-center gap-2.5">
            <div className={`w-8 h-8 rounded-lg ring-1 flex items-center justify-center shrink-0 ${r.ring} rounded-xl`}><Icon name={r.icon} size={15} className={r.color} /></div>
            <div className="flex-1 min-w-0">
              <div className="text-xs uppercase tracking-wide text-arc-faint">{r.label}</div>
              {edit ? (
                <input value={c[r.key] || ''} onChange={e => setC(prev => ({ ...prev, [r.key]: e.target.value }))}
                  className="w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-lg px-2.5 h-8 text-sm text-arc-text outline-none transition-all duration-200 hover:ring-arc-borderlt mt-0.5" />
              ) : (
                <div className="text-base text-arc-text truncate">{c[r.key] || <span className="text-arc-faint">—</span>}</div>
              )}
            </div>
            {!edit && c[r.key] && (
              <button onClick={() => { navigator.clipboard?.writeText(c[r.key]); notify && notify(r.label + ' ' + tr('ud.copied','copied'), 'info'); }}
                className="text-arc-faint hover:text-arc-text transition-all duration-200 hover:-translate-y-0.5"><Icon name="copy" size={14} /></button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

Object.assign(window, { UserDashboard });
