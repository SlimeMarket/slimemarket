// ============ View: Chat (DM) — conversations + thread ============

// type → [pixBadgeColor, shortLabel].
//
// Keys MUST match the `chat_threads.type` CHECK constraint, which allows
// normal | escrow | forum | dispute. A `product` key used to sit here and was
// unreachable — no code creates that type and no row has ever had it.
const TYPE_BADGE = {
  normal: ['slate', 'Direct'],
  escrow: ['blue', 'Escrow'],
  dispute: ['rose', 'Tribunal'],
  forum: ['violet', 'Forum'],
};
const STATUS_BADGE = { active: ['emerald', 'Active'], disrupted: ['rose', 'Disrupted'], closed: ['slate', 'Closed'], resolved: ['emerald', 'Resolved'] };

// Short label for an order-bound (non-DM) normal thread (Order Chat).
function threadBadge(t) {
  if (!t) return ['slate', 'Direct'];
  if (t.type === 'dispute') return ['rose', 'Tribunal'];
  if (t.type === 'escrow') return ['blue', 'Escrow'];
  if (t.type === 'normal' && t.order) return ['cyan', 'Order'];
  return TYPE_BADGE[t.type] || ['slate', 'Direct'];
}

function ChatDM({ threads, onSend, onViewProfile, onOpenOrder, notify, selectedThreadId, onClearSelected }) {
  const safeThreads = Array.isArray(threads) ? threads : [];
  const [sel, setSel] = useState(null);
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [newOpen, setNewOpen] = useState(false);

  // Auto-open a thread passed from outside (e.g. via openOrderChat navigation).
  useEffect(() => {
    if (selectedThreadId) { setSel(selectedThreadId); }
  }, [selectedThreadId]);
  // Clear the externally-passed id once consumed, so back/forward works cleanly.
  useEffect(() => {
    if (selectedThreadId && onClearSelected) {
      const id = setTimeout(() => onClearSelected(), 0);
      return () => clearTimeout(id);
    }
  }, [selectedThreadId, onClearSelected]);

  const list = safeThreads.filter(t =>
    (type === 'all' || t.type === type) &&
    (status === 'all' || t.status === status) &&
    ((t.user || '').toLowerCase().includes(q.toLowerCase()) || (t.order && t.order.id.toLowerCase().includes(q.toLowerCase())))
  );

  const selThread = safeThreads.find(t => t.id === sel);
  if (selThread) return <ChatThread thread={selThread} onBack={() => setSel(null)} onSend={onSend} onViewProfile={onViewProfile} onOpenOrder={onOpenOrder} notify={notify} />;

  return (
    <div className="anim-view">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
        <h1 className="text-xl font-bold text-white">{tr('chat.title','Chat')}</h1>
        <Btn variant="primary" icon="plus" onClick={() => setNewOpen(true)}>{tr('chat.new','New Chat')}</Btn>
      </div>

      {/* search + filters */}
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="relative flex-1">
          <Icon name="search" size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-arc-faint" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={tr('chat.searchPh','Search by username or order number…')}
            className="w-full bg-arc-surface/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl pl-10 pr-3 h-11 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
        </div>
        <div className="flex gap-2">
          <Dropdown label={tr('chat.type','Type')} value={type} setValue={setType} options={CHAT_TYPES} />
          <Dropdown label={tr('chat.status','Status')} value={status} setValue={setStatus} options={CHAT_STATUSES} />
          <Btn size="lg" className="px-5">{tr('c.search','Search')}</Btn>
        </div>
      </div>

      {/* notice */}
      <div className="flex items-start gap-3 rounded-xl ring-1 ring-amber-500/30 bg-amber-500/5 px-4 py-3 mb-4">
        <Icon name="triangle-alert" size={16} className="text-amber-400 mt-0.5 shrink-0" />
        <div className="text-xs">
          <div className="font-semibold text-amber-300">{tr('chat.noticeTitle','Important Information')}</div>
          <div className="text-arc-muted mt-0.5">{tr('chat.noticePre','Chats with no activity for')} <span className="font-semibold text-arc-text">{tr('chat.noticeSpan','2 weeks')}</span> {tr('chat.noticePost','are automatically deleted by the system.')}</div>
        </div>
      </div>

      {/* list */}
      <div className="space-y-2.5">
        {list.map(t => {
          const tb = threadBadge(t) || ['slate', 'Direct'];
          const [tc, tl] = Array.isArray(tb) ? tb : ['slate', 'Direct'];
          const sb = STATUS_BADGE[t.status] || STATUS_BADGE.active || ['slate', 'Active'];
          const [sc] = Array.isArray(sb) ? sb : ['slate', 'Active'];
          const isOrderThread = !!(t.order);
          const headerName = t.type === 'dispute'
            ? (tr('chat.tribunal','Tribunal Chat') + (t.order ? ' · ' + t.order.id : ''))
            : t.type === 'escrow'
              ? (tr('chat.escrowDeal','Escrow Deal') + (t.order ? ' · ' + t.order.id : ''))
              : isOrderThread
                ? (tr('chat.orderChat','Order Chat') + ' · ' + t.order.id)
                : t.user;
          return (
            <button key={t.id} onClick={() => setSel(t.id)} className="w-full text-left">
              <Card className="p-4 hover:ring-arc-primary/40 transition group">
                <div className="flex items-start gap-3">
                  <div className="relative shrink-0">
                    <Avatar gradient={isImgUrl(t.avatar) ? '' : (t.avatar || 'from-slate-600 to-slate-800')} img={isImgUrl(t.avatar) ? t.avatar : null} name={t.user} size={44} />
                    <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-arc-surface ${t.status === 'active' ? 'bg-emerald-400' : t.status === 'disrupted' ? 'bg-rose-400' : 'bg-arc-faint'}`}></span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-arc-text group-hover:text-arc-accent transition truncate">{headerName}</span>
                      {t.type !== 'dispute' && t.type !== 'escrow' && t.role && <span className="text-[11px] text-emerald-400">{t.role}</span>}
                      {t.type !== 'dispute' && t.type !== 'escrow' && t.uid && <span className="text-[11px] text-arc-faint">· {t.uid}</span>}
                    </div>
                    {isOrderThread && <div className="text-[11px] text-arc-faint mt-0.5">{tr('chat.order','Order')}: <span className="font-mono text-arc-muted">{t.order.id}</span></div>}
                    <div className="text-sm text-arc-muted mt-1 truncate">{t.last || tr('chat.noMessagesYet','No messages yet.')}</div>
                    <div className="text-[11px] text-arc-faint mt-0.5">{t.lastTime || ''}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    {isOrderThread && <PixBadge color="cyan">ORDER</PixBadge>}
                    <PixBadge color={tc}>{tl.toUpperCase()}</PixBadge>
                    {t.status !== 'active' && <PixBadge color={sc}>{(STATUS_BADGE[t.status] || STATUS_BADGE.active)[1].toUpperCase()}</PixBadge>}
                  </div>
                </div>
              </Card>
            </button>
          );
        })}
        {list.length === 0 && <div className="text-center text-arc-faint py-16 text-sm">{tr('chat.none','No conversations match this filter.')}</div>}
      </div>

      <NewChatModal open={newOpen} onClose={() => setNewOpen(false)} onStart={async (uid) => {
        setNewOpen(false);
        try {
          const API = window.SLIME_API || '';
          const r = await fetch(API + '/api/chats', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ participantId: uid, type: 'normal' }),
            credentials: 'include'
          });
          if (r.ok) { const d = await r.json(); notify && notify('Chat started', 'success'); if (d.id) setSel(d.id); }
          else { notify && notify('Failed to start chat', 'error'); }
        } catch (e) { notify && notify('Failed to start chat', 'error'); }
      }} />
    </div>
  );
}

function Dropdown({ label, value, setValue, options }) {
  const [open, setOpen] = useState(false);
  const cur = options.find(o => o.id === value);
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)} className="inline-flex items-center gap-2 h-11 px-3.5 rounded-xl bg-arc-surface/60 ring-1 ring-arc-border hover:ring-arc-borderlt text-sm text-arc-text transition whitespace-nowrap">
        {cur ? cur.label : label} <Icon name="chevron-down" size={14} className="text-arc-faint" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)}></div>
          <div className="absolute right-0 mt-1.5 z-20 w-40 bg-arc-surface ring-1 ring-arc-borderlt rounded-xl shadow-2xl py-1 anim-fade">
            {options.map(o => (
              <button key={o.id} onClick={() => { setValue(o.id); setOpen(false); }}
                className={`w-full text-left px-3 py-2 text-sm transition ${value === o.id ? 'text-arc-accent bg-arc-primary/10' : 'text-arc-muted hover:bg-arc-surface2'}`}>{o.label}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ChatThread({ thread, onBack, onSend, onViewProfile, onOpenOrder, notify }) {
  const [draft, setDraft] = useState('');
  const [msgs, setMsgs] = useState(thread.messages || []);
  const ref = useRef(null);
  const closed = thread.status === 'closed';

  // Fetch messages from backend when thread opens + poll for new messages
  useEffect(() => {
    const API = window.SLIME_API || '';
    const fetchMsgs = async () => {
      try {
        const r = await fetch(API + '/api/chats/' + thread.id, { credentials: 'include' });
        if (r.ok) { const d = await r.json(); if (Array.isArray(d.messages)) setMsgs(d.messages); }
      } catch (e) { /* keep existing */ }
    };
    fetchMsgs();
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') fetchMsgs();
    }, 5000);
    return () => clearInterval(poll);
  }, [thread.id]);

  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [msgs.length, thread.id]);
  const send = async () => {
    if (!draft.trim() || closed) return;
    const text = draft;
    // Optimistic add — rolled back below if the send fails.
    const optimistic = { from: 'me', text, time: 'now' };
    setMsgs(m => [...m, optimistic]);
    setDraft('');
    try {
      await onSend(thread.id, text);
    } catch (e) {
      // onSend already notified; revert the bubble so it matches the server.
      setMsgs(m => m.filter(x => x !== optimistic));
    }
  };

  const [tc, tl] = threadBadge(thread) || ['slate', 'Direct'];
  const statusBadge = STATUS_BADGE[thread.status] || STATUS_BADGE.active || ['slate', 'Active'];
  const [sc, sl] = Array.isArray(statusBadge) ? statusBadge : ['slate', 'Active'];

  // Header customization by thread type
  const isDispute = thread.type === 'dispute';
  const isEscrow = thread.type === 'escrow';
  const isOrderThread = thread.type === 'normal' && !!thread.order;
  const headerIcon = isDispute ? 'gavel' : isEscrow ? 'shield' : isOrderThread ? 'receipt' : null;
  const headerTitle = isDispute
    ? tr('chat.tribunalChat','Tribunal Chat')
    : isEscrow
      ? tr('chat.escrowDealChat','Escrow Deal Chat')
      : isOrderThread
        ? tr('chat.orderChat','Order Chat')
        : thread.user;
  const headerSub = isDispute
    ? (thread.order ? tr('chat.disputeFor','Dispute for order') + ' ' + thread.order.id : tr('chat.disputeResolution','Dispute resolution thread'))
    : isEscrow
      ? (thread.order ? tr('chat.escrowFor','Escrow for deal') + ' ' + thread.order.id : tr('chat.escrowMonitored','Escrow · monitored by Middleman'))
      : isOrderThread
        ? (tr('chat.order','Order') + ' ' + thread.order.id + (thread.order.title ? ' · ' + thread.order.title : ''))
        : (thread.online || 'Active');

  return (
    <div className="anim-view">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-arc-muted hover:text-arc-text mb-4 transition"><Icon name="arrow-left" size={16} /> {tr('chat.back','Back to Chat')}</button>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* thread */}
        <Card className={`overflow-hidden flex flex-col h-[600px] ${thread.order ? 'lg:col-span-2' : 'lg:col-span-3'}`}>
          <div className="flex items-center gap-3 px-4 py-3 border-b border-arc-border">
            {headerIcon
              ? <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isDispute ? 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/30' : isEscrow ? 'bg-arc-primary/15 text-arc-accent ring-1 ring-arc-primary/30' : 'bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/30'}`}><Icon name={headerIcon} size={18} /></div>
              : <button onClick={() => onViewProfile(thread.user)}><Avatar gradient={isImgUrl(thread.avatar) ? '' : (thread.avatar || 'from-slate-600 to-slate-800')} img={isImgUrl(thread.avatar) ? thread.avatar : null} name={thread.user} size={40} /></button>}
            <div className="min-w-0">
              {headerIcon
                ? <div className="text-sm font-semibold text-arc-text truncate">{headerTitle}</div>
                : <button onClick={() => onViewProfile(thread.user)} className="text-sm font-semibold text-arc-text hover:text-arc-accent transition block truncate">{headerTitle}</button>}
              <div className="text-[11px] text-arc-faint truncate">{headerSub}</div>
            </div>
            <div className="ml-auto flex items-center gap-1.5">
              <PixBadge color={tc}>{tl.toUpperCase()}</PixBadge>
              <PixBadge color={sc}>{sl.toUpperCase()}</PixBadge>
            </div>
          </div>

          <div ref={ref} className="flex-1 overflow-y-auto px-4 py-4 space-y-1 bg-arc-bg/30">
            {msgs.map((m, i) => <DMBubble key={i} m={m} avatar={thread.avatar} user={thread.user} />)}
          </div>

          {closed ? (
            <div className="px-4 py-4 border-t border-arc-border bg-arc-surface/60 text-center text-sm text-arc-faint">{tr('chat.closed','This chat has been closed')}</div>
          ) : (
            <div className="p-3 border-t border-arc-border flex items-center gap-2">
              <button className="w-10 h-10 rounded-xl bg-arc-surface2 hover:bg-arc-border text-arc-muted flex items-center justify-center transition shrink-0"><Icon name="paperclip" size={16} /></button>
              <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder={tr('chat.typeMsg','Type a message…')}
                className="flex-1 bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl px-3 h-10 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
              <Btn icon="send" className="shrink-0" onClick={send}>{tr('c.send','Send')}</Btn>
            </div>
          )}
        </Card>

        {/* info order */}
        {thread.order && (
          <div className="lg:col-span-1">
            <Card className="p-5">
              <div className="text-sm font-semibold text-arc-text mb-4">{tr('chat.orderInfo','Order Info')}</div>
              <div className="flex items-center gap-3 mb-4">
                {(() => { const p = PRODUCTS.find(x => x.id === thread.order.productId); return (
                  <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${p ? p.gradient : 'from-arc-surface2 to-arc-surface'} grid-noise flex items-center justify-center text-xl shrink-0`}>{p ? p.glyph : '▣'}</div>
                ); })()}
                <div>
                  <div className="text-sm font-semibold text-arc-text">{thread.order.title}</div>
                  <div className="text-[11px] text-arc-faint">{tr('orders.qty','Qty')}: {thread.order.qty}</div>
                </div>
              </div>
              <div className="space-y-2.5 text-sm">
                <div className="flex justify-between"><span className="text-arc-faint">{tr('chat.orderId','Order ID')}</span><span className="font-mono text-xs text-arc-muted">{thread.order.id}</span></div>
                <div className="flex justify-between"><span className="text-arc-faint">{tr('chat.total','Total')}</span><Usdc value={thread.order.total} className="text-emerald-400 font-semibold" /></div>
                <div className="flex justify-between items-center"><span className="text-arc-faint">{tr('chat.status','Status')}</span><span className="text-xs text-arc-muted">{thread.order.status}</span></div>
              </div>
              <Btn variant="outline" full className="mt-4" icon="receipt" onClick={() => onOpenOrder(thread.order.id)}>{tr('chat.viewOrder','View Order')}</Btn>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function DMBubble({ m, avatar, user }) {
  if (m.from === 'system')
    return (
      <div className="flex justify-center py-1.5">
        <div className="max-w-[85%] text-center text-xs text-arc-muted bg-arc-surface2/60 ring-1 ring-arc-borderlt/60 rounded-xl px-3.5 py-2.5 whitespace-pre-line">{m.text}<div className="text-[10px] text-arc-faint mt-1">{m.time}</div></div>
      </div>
    );
  const me = m.from === 'me';
  return (
    <div className={`flex items-end gap-2 ${me ? 'justify-end' : 'justify-start'}`}>
      {!me && <Avatar gradient={isImgUrl(avatar) ? '' : (avatar || 'from-slate-600 to-slate-800')} img={isImgUrl(avatar) ? avatar : null} name={user} size={26} />}
      <div className={`max-w-[78%] ${me ? 'items-end' : 'items-start'} flex flex-col`}>
        <div className={`rounded-2xl px-3.5 py-2 text-sm ${me ? 'bg-arc-primary text-white rounded-br-md' : 'bg-arc-surface2 text-arc-text ring-1 ring-arc-border rounded-bl-md'}`} style={{ textWrap: 'pretty' }}>{m.text}</div>
        <div className="text-[10px] text-arc-faint mt-0.5 px-1 flex items-center gap-1">{m.time}{me && <Icon name="check-check" size={12} className="text-arc-accent" />}</div>
      </div>
      {me && <Avatar gradient={isImgUrl(ME.avatar) ? '' : (ME.avatar || 'from-slate-600 to-slate-800')} img={isImgUrl(ME.avatar) ? ME.avatar : null} name={ME.name} size={26} />}
    </div>
  );
}

// ---- New Chat modal ----
function NewChatModal({ open, onClose, onStart }) {
  const [uid, setUid] = useState('');
  return (
    <Modal open={open} onClose={onClose} width="max-w-sm">
      <Card className="overflow-hidden">
        <div className="p-6 text-center">
          <div className="w-12 h-12 rounded-2xl bg-arc-primary/15 ring-1 ring-arc-primary/30 flex items-center justify-center mx-auto mb-3"><Icon name="message-circle-plus" size={22} className="text-arc-accent" /></div>
          <div className="font-semibold text-arc-text text-lg">{tr('chat.new','New Chat')}</div>
          <div className="text-sm text-arc-muted mt-1">{tr('chat.newSub','Enter the UID of the user you want to chat with')}</div>
        </div>
        <div className="px-6 pb-6">
          <label className="text-xs uppercase tracking-wide text-arc-faint">{tr('chat.userUid','User UID')}</label>
          <input value={uid} onChange={e => setUid(e.target.value.toUpperCase())} placeholder={tr('chat.uidPh','e.g. ABC12345')}
            className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none font-mono transition" />
          <div className="text-[11px] text-arc-faint mt-1.5">{tr('chat.uidHint','The UID can be found on the user profile')}</div>
          <div className="flex gap-3 mt-5">
            <Btn variant="ghost" full onClick={onClose}>{tr('c.cancel','Cancel')}</Btn>
            <Btn variant="primary" full icon="send" disabled={!uid.trim()} onClick={() => onStart(uid)}>{tr('chat.startChat','Start Chat')}</Btn>
          </div>
        </div>
      </Card>
    </Modal>
  );
}

// ---- Shared User Profile modal (View Profile) ----
function UserProfileModal({ name, onClose, onChat, onStore }) {
  if (!name) return null;
  // Extract UID from object (forum passes {uid, name, avatar, role})
  const initialUid = (typeof name === 'object' && name.uid) ? name.uid : null;
  const initialName = (typeof name === 'object' ? name.name : name) || 'User';
  const initialAvatar = (typeof name === 'object' ? name.avatar : null) || 'from-arc-primary to-arc-accent';
  const initialRole = (typeof name === 'object' ? name.role : null) || 'Buyer';

  const [profile, setProfile] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!initialUid || initialUid === '—') { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    fetch((window.SLIME_API || '') + '/api/users/' + encodeURIComponent(initialUid))
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!alive || !d) { setLoading(false); return; }
        setProfile(d);
        setLoading(false);
      })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [initialUid]);

  // Use fetched profile or fallback to initial data
  const p = profile ? {
    name: profile.name || initialName,
    uid: profile.uid || initialUid,
    avatar: profile.avatarUrl || profile.avatarGradient || initialAvatar,
    role: profile.role || initialRole,
    rating: profile.rating,
    ratingCount: profile.reviewCount,
    joined: profile.joinedAt ? new Date(profile.joinedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—',
    message: profile.store ? `${profile.store.name} · ${profile.completedOrders} sales` : '',
    isStore: !!profile.store,
    storeName: profile.store?.name,
  } : {
    name: initialName,
    uid: initialUid || '—',
    avatar: initialAvatar,
    role: initialRole,
    rating: null,
    joined: '—',
    message: '',
    isStore: false,
  };

  return (
    <Modal open={!!name} onClose={onClose} width="max-w-sm">
      <Card className="overflow-hidden">
        <div className={`h-20 bg-gradient-to-r ${isImgUrl(p.avatar) ? '' : p.avatar} bg-cover bg-center relative`} style={isImgUrl(p.avatar) ? { backgroundImage: `url(${p.avatar})` } : {}}>
          <button onClick={onClose} className="absolute top-3 right-3 w-8 h-8 rounded-lg bg-arc-bg/40 hover:bg-arc-bg/70 text-white flex items-center justify-center transition"><Icon name="x" size={16} /></button>
        </div>
        <div className="px-5 pb-5 -mt-9 relative bg-arc-surface/70 backdrop-blur">
          <div className="flex items-end gap-3">
            <Avatar gradient={isImgUrl(p.avatar) ? '' : p.avatar} img={isImgUrl(p.avatar) ? p.avatar : null} name={p.name} size={64} ring />
            <div className="pb-1">
              <div className="font-bold text-white">{p.name}</div>
              <div className="flex items-center gap-1.5 mt-0.5"><CopyChip value={p.uid} /></div>
            </div>
          </div>
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <span className={`inline-flex items-center gap-1 text-[11px] font-medium rounded-lg px-2 py-1 ${p.role === 'Admin' ? 'bg-rose-500/15 text-rose-300' : p.role === 'Seller' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-arc-surface2 text-arc-muted'}`}>
              <Icon name={(DISC_ROLE_META[p.role] || {}).icon || 'user'} size={12} /> {p.role}
            </span>
            {p.rating != null && <span className="inline-flex items-center gap-1 text-[11px] text-amber-300"><Icon name="star" size={12} className="fill-amber-400" stroke={0} /> {p.rating} {p.ratingCount ? `(${p.ratingCount})` : ''}</span>}
            <span className="text-[11px] text-arc-faint">{tr('pd.joined','Joined')} {p.joined}</span>
          </div>
          {loading && <div className="mt-3 text-xs text-arc-faint animate-pulse">Loading profile…</div>}
          {p.message && <div className="mt-3 text-sm text-arc-muted bg-arc-bg/50 ring-1 ring-arc-border rounded-xl px-3.5 py-2.5">{p.message}</div>}
          <div className="flex gap-2 mt-4">
            <Btn variant="primary" full icon="message-circle" onClick={() => { onClose(); onChat(p.name); }}>{tr('c.chat','Chat')}</Btn>
            {p.isStore && <Btn variant="outline" full icon="store" onClick={() => { onClose(); onStore(p.storeName || p.name); }}>{tr('chat.viewStore','View Store')}</Btn>}
          </div>
        </div>
      </Card>
    </Modal>
  );
}

Object.assign(window, { ChatDM, NewChatModal, UserProfileModal });
