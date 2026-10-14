// ============ View: Global Discussion (public forum, multi-channel) ============

function GlobalDiscussion({ role, onRekber, onViewProfile, onUpsell, notify }) {
  const [channel, setChannel] = useState('global');
  const [store, setStore] = useState(() => ({ ...FORUM_MESSAGES }));
  const [draft, setDraft] = useState('');
  const [tag, setTag] = useState('off');          // off | WTS | WTB
  const [reply, setReply] = useState(null);        // { user, text }
  const [menuId, setMenuId] = useState(null);
  const feedRef = useRef(null);
  const rank = ROLE_RANK[role] ?? 0;
  const isMember = rank < 1;                        // Member / public

  const API = window.SLIME_API || '';

  // Fetch messages for current channel from backend
  useEffect(() => {
    if (isMember && FORUM_CHANNELS.find(c => c.id === channel)?.gated) return;
    (async () => {
      try {
        const r = await fetch(API + '/api/forum/' + channel, { credentials: 'include' });
        if (r.ok) { const d = await r.json(); if (d.messages) setStore(s => ({ ...s, [channel]: d.messages })); }
      } catch (e) { /* keep empty */ }
    })();
  }, [channel]);

  const chMeta = FORUM_CHANNELS.find(c => c.id === channel);
  const locked = chMeta.gated && isMember;
  const messages = store[channel] || [];
  useEffect(() => { if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight; }, [messages.length, channel]);

  const send = async () => {
    if (!draft.trim() || locked) return;
    const text = draft; setDraft(''); setReply(null);
    // Optimistic add
    const optimistic = {
      id: 'x' + Date.now(), user: ME.name || 'you', avatar: ME.avatar, uid: ME.uid, role,
      tag: tag === 'off' ? null : tag, text, time: 'now', me: true, replyTo: reply || null,
    };
    setStore(s => ({ ...s, [channel]: [...(s[channel] || []), optimistic] }));
    // Send to backend
    try {
      const r = await fetch(API + '/api/forum/' + channel, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    } catch (e) {
      // Roll back the optimistic bubble — never leave a message that wasn't sent.
      setStore(s => ({ ...s, [channel]: (s[channel] || []).filter(m => m.id !== optimistic.id) }));
      notify && notify(tr('forum.sendFailed','Message failed to send.'), 'error');
    }
  };

  return (
    <div className="anim-view">
      <Card className="overflow-hidden flex h-[660px]">
        {/* channel rail */}
        <div className="w-16 sm:w-56 bg-arc-bg/50 border-r border-arc-border flex flex-col shrink-0">
          <div className="px-3 sm:px-4 h-14 border-b border-arc-border flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-arc-primary/20 ring-1 ring-arc-primary/30 flex items-center justify-center"><Icon name="messages-square" size={16} className="text-arc-accent" /></div>
            <span className="hidden sm:block text-sm font-semibold text-arc-text">{tr('forum.forum','Forum')}</span>
          </div>
          <div className="p-2 space-y-1 flex-1 overflow-y-auto">
            <div className="hidden sm:block px-2 py-1.5 text-[10px] uppercase tracking-wide text-arc-faint">{tr('forum.channels','Channels')}</div>
            {FORUM_CHANNELS.map(ch => {
              const chLocked = ch.gated && isMember;
              const activeCh = channel === ch.id;
              return (
                <button key={ch.id} onClick={() => setChannel(ch.id)}
                  className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition ${activeCh ? 'bg-arc-primary/15 text-arc-accent ring-1 ring-arc-primary/30' : 'text-arc-muted hover:bg-arc-surface2/60 hover:text-arc-text'}`}>
                  <Icon name={ch.icon} size={16} className="shrink-0" />
                  <div className="hidden sm:block text-left leading-tight min-w-0 flex-1">
                    <div className="font-medium truncate">{ch.label}</div>
                  </div>
                  {chLocked && <Icon name="lock" size={13} className="hidden sm:block text-arc-faint shrink-0" />}
                </button>
              );
            })}
          </div>
          {/* role notice */}
          <div className="p-2 border-t border-arc-border hidden sm:block">
            <div className="rounded-lg bg-arc-surface/60 ring-1 ring-arc-border px-3 py-2.5">
              <div className="flex items-center gap-1.5 text-[11px] text-arc-muted"><Icon name={(DISC_ROLE_META[role] || {}).icon || 'user'} size={12} className="text-arc-accent" /> {tr('forum.role','Role')}: <span className="font-semibold">{role}</span></div>
              {isMember && <div className="text-[10px] text-arc-faint mt-1 leading-snug">{tr('forum.unlockAll','Complete 3 transactions to unlock all channels.')}</div>}
            </div>
          </div>
        </div>

        {/* feed area */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="px-4 sm:px-5 h-14 border-b border-arc-border bg-arc-bg/40 flex items-center gap-2">
            <Icon name="hash" size={16} className="text-arc-faint" />
            <span className="text-sm font-semibold text-arc-text">{chMeta.label}</span>
            <span className="hidden sm:inline text-xs text-arc-faint">— {chMeta.desc}</span>
            <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-amber-300 bg-amber-500/10 ring-1 ring-amber-500/25 rounded-lg px-2.5 py-1.5">
              <Icon name="clock" size={12} /> {tr('forum.autoDelete','auto-delete')} <span className="font-semibold">{tr('forum.sevenDays','7 days')}</span>
            </span>
          </div>

          {locked ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
              <div className="w-16 h-16 rounded-2xl bg-arc-primary/10 ring-1 ring-arc-primary/25 flex items-center justify-center mb-4"><Icon name="lock" size={28} className="text-arc-accent" /></div>
              <div className="text-lg font-bold text-white">{tr('forum.lockedTitle','Channel locked')}</div>
              <p className="text-sm text-arc-muted mt-1.5 max-w-xs">{tr('forum.lockedP1','Channel')} <span className="font-pixel text-[8px] text-arc-accent">{chMeta.hash}</span> {tr('forum.lockedP2','is for role')} <span className="text-arc-text font-medium">Buyer</span> {tr('forum.lockedP3','and above. Complete')} <span className="text-emerald-300 font-semibold">{tr('forum.lockedP4','3 transactions')}</span> {tr('forum.lockedP5','to level up from Member → Buyer.')}</p>
              <div className="mt-4 flex items-center gap-2 text-xs text-arc-faint"><Icon name="shield-check" size={14} className="text-emerald-400" /> {tr('forum.leecher','Prevents leechers from harvesting community info.')}</div>
              <Btn variant="primary" className="mt-5" icon="shopping-bag" onClick={onUpsell}>{tr('forum.startTx','Start a Transaction')}</Btn>
            </div>
          ) : (
            <div ref={feedRef} className="flex-1 overflow-y-auto px-3 sm:px-5 py-4 space-y-1" onClick={() => setMenuId(null)}>
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const grouped = prev && prev.user === m.user && !m.replyTo && !prev.replyTo;
                return <DiscLine key={m.id} m={m} grouped={grouped} menuOpen={menuId === m.id}
                  onMenu={(e) => { e.stopPropagation(); setMenuId(menuId === m.id ? null : m.id); }}
                  onReply={() => { setReply({ user: m.user, text: m.text }); setMenuId(null); }}
                  onViewProfile={() => { onViewProfile({ name: m.user, uid: m.uid, avatar: m.avatar, role: m.role }); setMenuId(null); }}
                  onRekber={() => { onRekber(m); setMenuId(null); }} />;
              })}
              {messages.length === 0 && <div className="text-center text-arc-faint text-sm py-16">{tr('forum.emptyPre','No messages in')} {chMeta.hash} {tr('forum.emptyPost','yet. Be the first!')}</div>}
            </div>
          )}

          {/* composer */}
          {!locked && (
            <div className="border-t border-arc-border">
              {reply && (
                <div className="flex items-center gap-2 px-4 py-2 bg-arc-primary/10 border-b border-arc-primary/20">
                  <Icon name="reply" size={14} className="text-arc-accent shrink-0" />
                  <div className="min-w-0 flex-1 text-xs">
                    <span className="text-arc-accent font-medium">{tr('forum.replyingTo','Replying to')} {reply.user}</span>
                    <span className="text-arc-muted ml-2 truncate">{reply.text}</span>
                  </div>
                  <button onClick={() => setReply(null)} className="text-arc-muted hover:text-arc-text shrink-0"><Icon name="x" size={15} /></button>
                </div>
              )}
              <div className="p-3 flex items-center gap-2">
                {(channel === 'wts' || channel === 'wtb' || channel === 'global') && (
                  <div className="flex rounded-lg overflow-hidden ring-1 ring-arc-borderlt shrink-0">
                    {[['off', 'OFF'], ['WTS', 'WTS'], ['WTB', 'WTB']].map(([id, lbl]) => (
                      <button key={id} onClick={() => setTag(id)}
                        className={`font-pixel text-[8px] px-2.5 py-2 transition ${tag === id ? (id === 'WTS' ? 'bg-emerald-500/20 text-emerald-300' : id === 'WTB' ? 'bg-arc-primary/20 text-arc-accent' : 'bg-arc-borderlt text-arc-text') : 'bg-arc-surface2 text-arc-faint hover:text-arc-muted'}`}>{lbl}</button>
                    ))}
                  </div>
                )}
                <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()}
                  placeholder={`${tr('forum.messagePh','Message')} ${chMeta.hash}…`}
                  className="flex-1 bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl px-3 h-11 text-sm text-arc-text placeholder-arc-faint outline-none transition min-w-0" />
                <Btn icon="send" className="shrink-0" onClick={send}>{tr('c.send','Send')}</Btn>
              </div>
            </div>
          )}
        </div>
      </Card>
      <p className="text-[11px] text-arc-faint mt-2 text-center">{tr('forum.tagHintPre','WTS/WTB tags are optional in general channels — pick')} <span className="font-pixel text-[7px]">OFF</span> {tr('forum.tagHintPost','for regular chat.')}</p>
    </div>
  );
}

function DiscLine({ m, grouped, menuOpen, onMenu, onReply, onViewProfile, onRekber }) {
  const rm = DISC_ROLE_META[m.role] || { color: 'slate', icon: 'user' };
  return (
    <div className={`group flex gap-3 rounded-lg px-2 -mx-2 hover:bg-arc-surface2/30 transition ${grouped ? 'py-0.5' : 'pt-2.5 pb-0.5 mt-1'}`}>
      <div className="w-10 shrink-0">
        {!grouped && <button onClick={onViewProfile}><Avatar gradient={isImgUrl(m.avatar) ? '' : (m.avatar || 'from-slate-600 to-slate-800')} img={isImgUrl(m.avatar) ? m.avatar : null} name={m.user} size={38} /></button>}
      </div>
      <div className="flex-1 min-w-0">
        {!grouped && (
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <button onClick={onViewProfile} className={`text-sm font-semibold hover:underline ${m.me ? 'text-arc-accent' : 'text-arc-text'}`}>{m.user}</button>
            <PixBadge color={rm.color}>{m.role.toUpperCase()}</PixBadge>
            <span className="text-[10px] text-arc-faint font-mono inline-flex items-center gap-1">{m.uid}</span>
            <span className="text-[10px] text-arc-faint">· {m.time}</span>
          </div>
        )}
        {/* reply quote */}
        {m.replyTo && (
          <button onClick={onViewProfile} className="block text-left mb-1 pl-2.5 border-l-2 border-arc-primary/60 bg-arc-primary/5 rounded-r-md py-1 pr-2 max-w-md">
            <div className="text-[11px] text-arc-accent font-medium">{m.replyTo.user}</div>
            <div className="text-[11px] text-arc-muted truncate">{m.replyTo.text}</div>
          </button>
        )}
        <div className="flex items-start gap-2">
          {m.tag && <span className={`font-pixel text-[8px] mt-1 shrink-0 px-1.5 py-1 rounded ${m.tag === 'WTS' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-arc-primary/15 text-arc-accent'}`}>{m.tag}</span>}
          <p className="text-sm text-arc-muted leading-relaxed flex-1 min-w-0" style={{ textWrap: 'pretty' }}>{m.text}</p>
          {/* menu */}
          <div className="relative shrink-0">
            <button onClick={onMenu} className="w-7 h-7 rounded-lg text-arc-faint hover:text-arc-text hover:bg-arc-surface2 flex items-center justify-center opacity-0 group-hover:opacity-100 transition"><Icon name="ellipsis-vertical" size={16} /></button>
            {menuOpen && (
              <div className="absolute right-0 top-8 z-20 w-44 bg-arc-surface ring-1 ring-arc-borderlt rounded-xl shadow-2xl py-1 anim-fade">
                <MenuItem icon="reply" label={tr('forum.reply','Reply')} onClick={onReply} />
                <MenuItem icon="user-round" label={tr('forum.viewProfile','View Profile')} onClick={onViewProfile} />
                {!m.me && <MenuItem icon="handshake" label={tr('forum.proposeRekber','Request Escrow')} onClick={onRekber} accent />}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MenuItem({ icon, label, onClick, accent }) {
  return (
    <button onClick={onClick} className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition ${accent ? 'text-emerald-300 hover:bg-emerald-500/10' : 'text-arc-muted hover:bg-arc-surface2'}`}>
      <Icon name={icon} size={15} /> {label}
    </button>
  );
}

// ---- Instant Rekber confirmation modal ----
function RekberModal({ open, target, onClose, onCreate }) {
  if (!target) return null;
  return (
    <Modal open={open} onClose={onClose} width="max-w-sm">
      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-arc-border">
          <div className="w-10 h-10 rounded-xl bg-arc-primary/15 ring-1 ring-arc-primary/30 flex items-center justify-center text-arc-accent"><Icon name="handshake" size={18} /></div>
          <div>
            <div className="font-semibold text-arc-text">{tr('forum.rekberTitle','Create Instant Escrow')}</div>
            <div className="text-xs text-arc-muted">{tr('forum.rekberSub','Custom P2P escrow session')}</div>
          </div>
          <button onClick={onClose} className="ml-auto w-8 h-8 rounded-lg hover:bg-arc-surface2 text-arc-muted flex items-center justify-center"><Icon name="x" size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex items-center gap-3 bg-arc-bg/50 ring-1 ring-arc-border rounded-xl p-3">
            <Avatar gradient={isImgUrl(target.avatar) ? '' : (target.avatar || 'from-slate-600 to-slate-800')} img={isImgUrl(target.avatar) ? target.avatar : null} name={target.user} size={36} />
            <div className="min-w-0">
              <div className="text-sm font-medium text-arc-text">{target.user} {target.tag && <><span className="text-arc-faint">·</span> <span className={`font-pixel text-[7px] ${target.tag === 'WTS' ? 'text-emerald-300' : 'text-arc-accent'}`}>{target.tag}</span></>}</div>
              <div className="text-xs text-arc-muted truncate">{target.text}</div>
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wide text-arc-faint">{tr('forum.dealAmount','Deal Amount (USDC)')}</label>
            <input defaultValue="30.00" className="w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl px-3 h-11 text-sm text-arc-text outline-none font-mono transition" />
          </div>
          <div className="flex items-center justify-between text-xs bg-arc-bg/50 ring-1 ring-arc-border rounded-xl px-3 py-2.5">
            <span className="text-arc-muted inline-flex items-center gap-1.5"><Icon name="receipt" size={13} className="text-arc-accent" /> {tr('forum.fee','Fee (2%)')}</span>
            <span className="font-pixel text-[8px] text-arc-accent">2% of deal</span>
          </div>
          <Btn variant="primary" size="lg" full icon="handshake" onClick={() => onCreate(target)}>{tr('forum.openEscrow','Open Escrow')}</Btn>
          <div className="text-[11px] text-arc-faint text-center flex items-center justify-center gap-1.5"><Icon name="shield-check" size={12} className="text-emerald-500/70" /> {tr('forum.roomAuto','A private Order Room will be created automatically')}</div>
        </div>
      </Card>
    </Modal>
  );
}

Object.assign(window, { GlobalDiscussion, RekberModal });
