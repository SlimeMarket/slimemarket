// ============ Escrow Page: tabs (WL Market · Escrow P2P · WL Deals) + WL deal room ============

// tone → explicit theme classes (avoid dynamic color interpolation; violet → arc-primary)
const WL_TONE_CLS = {
  amber: 'bg-amber-500/15 text-amber-300',
  violet: 'bg-arc-primary/15 text-arc-accent',
  emerald: 'bg-emerald-500/15 text-emerald-300',
  rose: 'bg-rose-500/15 text-rose-300',
  cyan: 'bg-cyan-500/15 text-cyan-300',
};

function WLMsg({ m }) {
  if (m.from === 'system')
    return <div className="flex justify-center py-1"><span className="text-[11px] text-arc-muted bg-arc-surface2 ring-1 ring-arc-borderlt rounded-full px-3 py-1.5 inline-flex items-center gap-1.5 text-center"><Icon name="info" size={11} /> {m.text}</span></div>;
  if (m.from === 'middleman')
    return (
      <div className="flex justify-center py-1">
        <div className="max-w-[88%] bg-arc-primary/10 ring-1 ring-arc-primary/30 rounded-xl px-3.5 py-2.5">
          <div className="flex items-center gap-1.5 text-[11px] text-arc-accent font-semibold mb-0.5"><Icon name="shield" size={12} /> Middleman · SlimeMarket</div>
          <div className="text-sm text-arc-text" style={{ textWrap: 'pretty' }}>{m.text}</div>
        </div>
      </div>
    );
  // Identity-based alignment: `from` is 'me' | 'them' (computed server-side via
  // sender_id === myId). The sender's NAME is shown above others' bubbles.
  const me = m.from === 'me';
  return (
    <div className={`flex ${me ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[78%] rounded-2xl px-3.5 py-2 text-sm ${me ? 'bg-arc-primary text-white rounded-br-md' : 'bg-arc-surface2 text-arc-text rounded-bl-md'}`} style={{ textWrap: 'pretty' }}>
        {!me && <div className="text-[10px] text-arc-muted mb-0.5">{m.name || tr('c.seller','Seller')}</div>}
        {m.text}
        <div className={`text-[10px] mt-1 ${me ? 'text-white/70' : 'text-arc-faint'}`}>{m.time}</div>
      </div>
    </div>
  );
}

function WLDealRoom({ deal, role, onBack, onProceed, onRelease, onRefund, onCancel, onEscapeHatch, onViewProfile, notify, onMarkDelivered, onConfirmReceipt, onDispute, onTopUpCollateral, onSlash, onMarkPaid, onConfirmPayment }) {
  const [draft, setDraft] = useState('');
  const [msgs, setMsgs] = useState((deal && deal.messages) || []);
  const [col, setCol] = useState('');
  const [threadId, setThreadId] = useState(null);
  const ref = useRef(null);

  // Map a raw DB chat_message row → WLMsg shape.
  // Backend GET /api/wl/deals/{id}/chat returns rows
  // { sender_id, sender_role, text, created_at, users: { name, avatar_gradient } }
  // plus identity meta (myId, buyerId, sellerId). Alignment is by IDENTITY
  // (sender_id === myId → right/"me"), never by role — sender_role can be
  // stale/wrong on old rows (it used to store the account role).
  const mapDealMsg = (m, meta) => {
    const myId = meta.myId;
    const name = (m.users && m.users.name) || (m.sender_id === meta.buyerId ? tr('c.buyer','Buyer') : m.sender_id === meta.sellerId ? tr('c.seller','Seller') : '');
    const time = m.created_at ? new Date(m.created_at).toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) : tr('wl.now','now');
    // System/middleman messages have no sender_id → centered styling.
    if (!m.sender_id) {
      if (m.sender_role === 'middleman') return { from: 'middleman', text: m.text, time };
      return { from: 'system', text: m.text, time };
    }
    return {
      from: myId && m.sender_id === myId ? 'me' : 'them',
      name: name || tr('c.member','Member'),
      text: m.text,
      time,
    };
  };

  // Fetch real chat thread + poll for new messages (same pattern as chatdm.jsx).
  useEffect(() => {
    if (!deal || !deal.id) return;
    const API = window.SLIME_API || '';
    let cancelled = false;
    const fetchMsgs = async () => {
      try {
        const r = await fetch(API + '/api/wl/deals/' + deal.id + '/chat', { credentials: 'include' });
        if (!r.ok) return;
        const d = await r.json();
        if (cancelled) return;
        if (d && d.threadId) setThreadId(d.threadId);
        if (d && Array.isArray(d.messages)) setMsgs(d.messages.map(m => mapDealMsg(m, { myId: d.myId, buyerId: d.buyerId, sellerId: d.sellerId })));
      } catch (e) { /* keep existing */ }
    };
    fetchMsgs();
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible') fetchMsgs();
    }, 5000);
    return () => { cancelled = true; clearInterval(poll); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deal && deal.id]);

  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [msgs.length]);
  // Deal may be undefined on a direct URL load (wlDeals still fetching) — render
  // a loading state instead of crashing; the parent re-renders once deals arrive.
  if (!deal) {
    return (
      <div className="anim-view">
        <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-arc-muted hover:text-arc-text mb-4 transition"><Icon name="chevron-left" size={16} /> {tr('wl.back','Back to WL Deals')}</button>
        <Card className="p-10 text-center">
          <div className="text-sm text-arc-muted">{tr('wl.loadingDeal','Loading deal…')}</div>
        </Card>
      </div>
    );
  }
  const sm = WL_STAGE_META[deal.status];
  const tm = wlTypeMeta(deal.listing ? deal.listing.type : 'wl');
  const closed = deal.status === 'COMPLETED' || deal.status === 'CANCELLED';
  // 3 — staff includes the MM (middleman) role for release/refund.
  // release/refund are STAFF-only on the server (requireStaffAuth), so
  // showing them to a Seller produced a button that always 401'd. A seller is a
  // party to the deal, not a decider.
  const isStaff = role === 'Admin' || role === 'MM';
  // Which party is looking at this room. Identity comes from ME.id vs the deal's
  // buyer/seller ids — NOT from `role`, which describes the account, not the seat.

  // BUG FIX: this compared `ME.uid` (the 4-char uid) against `deal.buyerId` /
  // `deal.sellerId`, which the API returns as UUIDs (users.id). The comparison
  // was never true, so neither party was recognised: the seller never saw
  // "Seller Actions" (Mark as Delivered) and the buyer never saw Confirm.
  const isBuyer = !!ME.id && ME.id === deal.buyerId;
  const isSeller = !!ME.id && ME.id === deal.sellerId;
  const disputed = deal.status === 'DISPUTED';

  // Settlement clocks (0071). Shown so the buyer knows exactly how long their
  // funds stay locked BEFORE anything is decided, and so both sides can see when
  // the refund/release windows open.
  const fmtDeadline = (ts) => {
    if (!ts) return null;
    const t = Date.parse(ts);
    if (Number.isNaN(t)) return null;
    return new Date(t).toLocaleString('en-US', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const deliveryDeadlineLabel = fmtDeadline(deal.deliveryDeadline);
  const confirmDeadlineLabel = fmtDeadline(deal.confirmDeadline);
  const deliveryPassed = deal.deliveryDeadline ? Date.parse(deal.deliveryDeadline) < Date.now() : false;
  const confirmPassed = deal.confirmDeadline ? Date.parse(deal.confirmDeadline) < Date.now() : false;
  // The 7-day permissionless escape hatch (contract ESCROW_TIMEOUT). Only worth
  // offering once the window has actually elapsed.
  const ESCROW_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
  const dealAgeMs = (() => {
    const ts = deal.createdAt || deal.created_at || deal.date;
    const t = ts ? Date.parse(ts) : NaN;
    return Number.isNaN(t) ? null : Date.now() - t;
  })();
  const escapeHatchOpen = deal.status === 'ESCROW' && dealAgeMs !== null && dealAgeMs > ESCROW_TIMEOUT_MS;
  const statusLabel = (STATUS_META[deal.status] || {}).label || deal.status;
  const send = async () => {
    if (!draft.trim() || closed) return;
    if (!threadId) { notify && notify(tr('wl.chatLoading','Chat is still loading — try again in a moment.'), 'error'); return; }
    const text = draft.trim();
    const tempId = 'tmp' + Date.now();
    // Optimistic add (always rendered on the right/"me" side; the next poll
    // reconciles against the server rows, which align by identity).
    setMsgs(m => [...m, { id: tempId, from: 'me', name: (window.ME && window.ME.name) || 'You', text, time: tr('wl.now','now') }]);
    setDraft('');
    try {
      const r = await fetch((window.SLIME_API || '') + '/api/chats/' + threadId + '/messages', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    } catch (e) {
      // Roll back the optimistic bubble — never leave a message that wasn't sent.
      setMsgs(m => m.filter(x => x.id !== tempId));
      notify && notify(tr('wl.sendFailed','Message failed to send.'), 'error');
    }
  };

  return (
    <div className="anim-view">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-arc-muted hover:text-arc-text mb-4 transition"><Icon name="arrow-left" size={16} /> {tr('wl.backToDeals','Back to WL Deals')}</button>

      <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-xl font-bold text-white">{(deal.listing || {}).project || deal.project || 'Unknown'}</h1>
            <PixBadge color={sm.tone}>{statusLabel}</PixBadge>
          </div>
          <div className="flex items-center gap-2 mt-1.5 text-xs flex-wrap"><CopyChip value={deal.id} label="DEAL" /><span className="text-arc-faint">·</span><span className="text-arc-faint">{deal.date}</span></div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        {/* LEFT: escrow status */}
        <div className="lg:col-span-2 space-y-5">
          <Card className="p-5">
            <div className="text-xs uppercase tracking-wide text-arc-faint mb-3">{tr('wl.escrowStatus','Escrow Status')}</div>
            <div className="flex items-center gap-2.5 mb-4">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${WL_TONE_CLS[sm.tone] || WL_TONE_CLS.violet}`}><Icon name={sm.icon} size={18} /></div>
              <div>
                <div className="text-sm font-semibold text-arc-text">{sm.label}</div>
                <div className="text-[11px] text-arc-faint">{tm.label} · {(deal.listing || {}).wlType || 'WL'}</div>
              </div>
            </div>
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between"><span className="text-arc-muted">{tr('wl.dealPrice','Deal price')} {deal.qty > 1 ? '× ' + deal.qty : ''}</span><Usdc value={deal.price} className="text-arc-text" /></div>
              <div className="flex justify-between"><span className="text-arc-muted">{tr('wl.fee','Fee (2%)')}</span><Usdc value={+(deal.price * 0.02).toFixed(2)} className="text-arc-text" /></div>
              <div className="h-px bg-arc-border"></div>
              <div className="flex items-center justify-between">
                <span className="text-arc-muted inline-flex items-center gap-1.5"><Icon name={deal.buyerHeld ? 'lock' : 'lock-open'} size={13} className={deal.buyerHeld ? 'text-arc-accent' : 'text-arc-faint'} /> {tr('wl.buyerFunds','Buyer funds')} {deal.buyerHeld ? tr('wl.held','held') : tr('wl.notHeld','not held')}</span>
                <Usdc value={deal.total} className={deal.buyerHeld ? 'text-arc-accent font-semibold' : 'text-arc-faint'} />
              </div>
              {/* .D3 — funding method labels (buyer + seller collateral) */}
              {(deal.buyerPayerWalletType === 'eoa' || deal.buyerPayerWalletType === 'ucw') && (
                <div className="flex justify-between items-center">
                  <span className="text-arc-muted">{tr('wl.fundedVia','Funded via')}</span>
                  <span className={`text-[10px] font-medium rounded px-1.5 py-0.5 ring-1 ${deal.buyerPayerWalletType === 'eoa' ? 'ring-violet-500/30 bg-violet-500/10 text-violet-300' : 'ring-cyan-500/30 bg-cyan-500/10 text-cyan-300'}`}>{deal.buyerPayerWalletType === 'eoa' ? 'EOA wallet' : 'UCW (Circle)'}</span>
                </div>
              )}
              {deal.sellerCollateralWalletType === 'eoa' && deal.sellerCollateralTxHash && (
                <div className="flex justify-between items-center">
                  <span className="text-arc-muted">{tr('wl.collateralTx','Collateral tx')}</span>
                  <span className="font-mono text-[10px] text-violet-300" title={deal.sellerCollateralTxHash}>{deal.sellerCollateralTxHash.slice(0, 10)}…{deal.sellerCollateralTxHash.slice(-6)}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-amber-300/90 inline-flex items-center gap-1.5"><Icon name="shield" size={13} /> {tr('wl.sellerCollateral','Seller collateral')}</span>
                {deal.status === 'WAITING'
                  ? <span className="text-[11px] text-arc-faint">{deal.needsCollateral ? tr('wl.setOnProceed','set on proceed') : tr('wl.notNeeded','not needed')}</span>
                  : <Usdc value={deal.sellerCollateral} className={deal.sellerCollateral > 0 ? 'text-amber-300 font-semibold' : 'text-arc-faint'} />}
              </div>
              {/* Settlement clocks — the seller's delivery window and, once they
                  mark it delivered, the buyer's confirmation window. */}
              {deliveryDeadlineLabel && (
                <div className="flex justify-between items-center">
                  <span className="text-arc-muted inline-flex items-center gap-1.5"><Icon name="clock" size={13} className={deliveryPassed && deal.status === 'ESCROW' ? 'text-rose-400' : 'text-arc-faint'} /> {tr('wl.deliverBy','Seller delivers by')}</span>
                  <span className={`text-[11px] font-mono ${deliveryPassed && deal.status === 'ESCROW' ? 'text-rose-300' : 'text-arc-muted'}`}>{deliveryDeadlineLabel}</span>
                </div>
              )}
              {confirmDeadlineLabel && (
                <div className="flex justify-between items-center">
                  <span className="text-arc-muted inline-flex items-center gap-1.5"><Icon name="clock" size={13} className={confirmPassed ? 'text-amber-400' : 'text-arc-faint'} /> {tr('wl.confirmBy','Buyer confirms by')}</span>
                  <span className={`text-[11px] font-mono ${confirmPassed ? 'text-amber-300' : 'text-arc-muted'}`}>{confirmDeadlineLabel}</span>
                </div>
              )}
              {/* D3 — the off-platform payment trail. Only meaningful when the
                  deal has a fiat leg; the money moved outside the platform, so
                  these two declarations are the entire record of it. */}
              {deal.fiatLeg && (
                <div className="flex justify-between items-center">
                  <span className="text-arc-muted inline-flex items-center gap-1.5">
                    <Icon name={deal.paymentConfirmedAt ? 'check-check' : deal.paymentMarkedAt ? 'clock' : 'banknote'} size={13} className={deal.paymentConfirmedAt ? 'text-emerald-400' : deal.paymentMarkedAt ? 'text-amber-400' : 'text-arc-faint'} />
                    {tr('wl.fiatPayment','Payment (fiat)')}
                  </span>
                  <span className={`text-[11px] ${deal.paymentConfirmedAt ? 'text-emerald-300' : deal.paymentMarkedAt ? 'text-amber-300' : 'text-arc-faint'}`}>
                    {deal.paymentConfirmedAt ? tr('wl.payConfirmed','received')
                      : deal.paymentMarkedAt ? tr('wl.payMarked','sent · awaiting seller')
                      : tr('wl.payNone','not sent')}
                  </span>
                </div>
              )}
            </div>
            {/* A2 — a collateral-backed deal is only recorded as protected once the
                collateral is really locked on-chain. Legacy deals (created before
                the gate) could still be ESCROW with nothing deposited, so warn. */}
            {deal.status === 'ESCROW' && deal.needsCollateral && !(deal.sellerCollateral > 0) && (
              <div className="mt-3 rounded-xl bg-rose-500/10 ring-1 ring-rose-500/30 px-3.5 py-2.5 text-[11px] text-rose-200 leading-relaxed">
                <Icon name="shield-alert" size={12} className="inline mr-1" />
                {tr('wl.collateralMissing','This deal requires seller collateral, but none is locked on-chain yet. Do not treat the buyer as fully protected until the seller deposits it.')}
              </div>
            )}
            <div className="mt-4 rounded-xl bg-arc-bg/50 ring-1 ring-arc-border px-3.5 py-3 text-[11px] text-arc-muted leading-relaxed">
              {deal.status === 'WAITING' && <><Icon name="gavel" size={12} className="inline text-amber-400 mr-1" />{tr('wl.waitingSeller','Waiting for the seller to set the collateral amount & Proceed. Buyer funds & seller collateral are not held yet.')}</>}
              {deal.status === 'ESCROW' && <><Icon name="lock" size={12} className="inline text-arc-accent mr-1" />Buyer funds &amp; seller collateral are locked in the Escrow System. The seller delivers by the deadline above; the buyer then confirms. If nobody acts, the <span className="text-arc-text">{tr('wl.middlemanAdmin','Middleman/Admin')}</span> decides.</>}
              {deal.status === 'DISPUTED' && <><Icon name="shield-alert" size={12} className="inline text-rose-400 mr-1" />A dispute is open — settlement is <span className="text-arc-text">frozen</span>. The <span className="text-arc-text">{tr('wl.middlemanAdmin','Middleman/Admin')}</span> will review the evidence and either release, refund, or forfeit the collateral. If the platform does not resolve it, the buyer is refunded automatically after 30 days.</>}
              {deal.status === 'COMPLETED' && <><Icon name="check-check" size={12} className="inline text-emerald-400 mr-1" />Completed. The Middleman released funds to the seller{deal.sellerCollateral > 0 ? ' & returned the collateral' : ''}.</>}
              {deal.status === 'CANCELLED' && <>{deal.collateralSlashed > 0
                ? <><Icon name="shield-alert" size={12} className="inline text-amber-400 mr-1" />{tr("wl.refundedAfterFraud","Refunded after a fraud ruling. The buyer received their funds back plus the seller's collateral as compensation.")}</>
                : <><Icon name="undo-2" size={12} className="inline text-rose-400 mr-1" />Refunded. The Middleman returned the funds to the buyer{deal.sellerCollateral > 0 ? ' & released the seller collateral' : ''}.</>}</>}
            </div>

            {/* Dispute case file — facts + both claims + which outcomes the
                contract currently permits. Deliberately NO verdict and no AI:
                the middleman decides, this only saves them the assembly work. */}
            {deal.status === 'DISPUTED' && deal.disputeBrief && (
              <Card className="mt-4 p-4 space-y-3">
                <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-arc-faint">
                  <Icon name="file-text" size={13} className="text-rose-400" /> {tr('wl.caseFile','Dispute Case File')}
                </div>

                {deal.disputeReason && (
                  <div className="rounded-xl bg-arc-bg/50 ring-1 ring-arc-border px-3.5 py-3">
                    <div className="text-[10px] uppercase tracking-wide text-arc-faint mb-1">{tr('wl.reasonGiven','Reason given')}</div>
                    <div className="text-[12px] text-arc-text leading-relaxed whitespace-pre-wrap">{deal.disputeReason}</div>
                  </div>
                )}

                {[['buyer', tr('c.buyer','Buyer')], ['seller', tr('c.seller','Seller')]].map(([side, label]) => {
                  const items = (deal.disputeEvidence || []).filter(e => e.side === side);
                  return (
                    <div key={side} className="rounded-xl bg-arc-bg/50 ring-1 ring-arc-border px-3.5 py-3">
                      <div className="text-[10px] uppercase tracking-wide text-arc-faint mb-1">{label} — {tr('wl.statements','statements')} ({items.length})</div>
                      {items.length === 0
                        ? <div className="text-[12px] text-arc-faint italic">{tr('wl.nothingFiled','Nothing filed yet.')}</div>
                        : <ul className="space-y-1.5">
                            {items.map((e, i) => (
                              <li key={i} className="text-[12px] text-arc-text leading-relaxed">
                                {e.note}
                                {e.link && <> <a href={e.link} target="_blank" rel="noopener noreferrer" className="text-arc-accent hover:brightness-125 break-all">{e.link}</a></>}
                              </li>
                            ))}
                          </ul>}
                    </div>
                  );
                })}

                <div className="rounded-xl bg-arc-bg/50 ring-1 ring-arc-border px-3.5 py-3 space-y-1.5">
                  <div className="text-[10px] uppercase tracking-wide text-arc-faint">{tr('wl.outcomesOpen','Outcomes the contract currently permits')}</div>
                  {['release', 'refund', 'slash'].map((k) => {
                    const a = (deal.disputeBrief.availability || {})[k];
                    if (!a) return null;
                    return (
                      <div key={k} className="flex items-start gap-2 text-[12px]">
                        <Icon name={a.available ? 'check' : 'x'} size={13} className={a.available ? 'text-emerald-400 mt-0.5 shrink-0' : 'text-arc-faint mt-0.5 shrink-0'} />
                        <span className={a.available ? 'text-arc-text' : 'text-arc-faint'}>
                          <span className="font-medium">{tr('wl.op_' + k, k)}</span> — {a.reason}
                        </span>
                      </div>
                    );
                  })}
                  <div className="text-[10px] text-arc-faint pt-1">{tr('wl.caseFileNote','Facts only — the middleman decides the outcome.')}</div>
                </div>
              </Card>
            )}

            {/* participants */}
            <div className="mt-4">
              <div className="text-[11px] uppercase tracking-wide text-arc-faint mb-2">{tr('wl.roomParticipants','Room Participants')}</div>
              <div className="space-y-2">
                <button onClick={() => onViewProfile(deal.seller)} className="w-full flex items-center gap-2.5"><Avatar gradient={deal.sellerAvatar} name={deal.seller} size={28} /><span className="text-sm text-arc-muted">{deal.seller}</span><span className="text-[10px] text-arc-faint ml-auto">{tr('c.seller','Seller')}</span></button>
                <div className="flex items-center gap-2.5"><Avatar gradient={ME.avatar} img={ME.avatarImg} name={ME.name} size={28} /><span className="text-sm text-arc-muted">{ME.name} <span className="text-arc-accent">{tr('wl.you','(you)')}</span></span><span className="text-[10px] text-arc-faint ml-auto">{tr('c.buyer','Buyer')}</span></div>
                <div className="flex items-center gap-2.5">
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${deal.middlemanJoined ? 'bg-arc-primary/20 text-arc-accent' : 'bg-arc-surface2 text-arc-faint'}`}><Icon name="shield" size={15} /></div>
                  <span className={`text-sm ${deal.middlemanJoined ? 'text-arc-muted' : 'text-arc-faint'}`}>{tr('wl.middleman','Middleman')}</span>
                  <span className={`text-[10px] ml-auto ${deal.middlemanJoined ? 'text-emerald-400' : 'text-arc-faint'}`}>{deal.middlemanJoined ? tr('wl.joined','Joined') : tr('wl.notJoined','Not joined')}</span>
                </div>
              </div>
            </div>
          </Card>

          {/* actions (role-aware) */}
          {!closed && (
            <Card className="p-4 space-y-3">
              {deal.status === 'WAITING' && (
                <>
                  <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-arc-faint"><Icon name="store" size={13} className="text-emerald-400" /> {tr('wl.sellerActions','Seller Actions')}</div>
                  {/* bug #37 — Accept & Proceed / Decline Order are SELLER
                      operations (the proceed RPC is seller-only). They used to
                      render for everyone, so a buyer saw "Seller Actions". */}
                  {(isSeller || isStaff) && (
                    <>
                      {deal.needsCollateral && (
                        <div>
                          <label className="text-sm text-arc-muted">{tr('wl.collateralAmount','Collateral Amount (USDC)')}</label>
                          <input value={col} onChange={e => setCol(e.target.value.replace(/[^0-9.]/g, ''))} placeholder={tr('wl.collateralPh','as agreed with the buyer')} className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-amber-500/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none font-mono transition" />
                          <div className="text-[11px] text-amber-300/80 mt-1.5 flex items-start gap-1.5"><Icon name="shield-alert" size={12} className="mt-0.5 shrink-0" /> Held from the seller balance until the transaction is complete. Discuss the amount in chat first.</div>
                        </div>
                      )}
                      <Btn variant="emerald" full icon="check" disabled={deal.needsCollateral && !(parseFloat(col) > 0)} onClick={() => onProceed(deal.id, deal.needsCollateral ? col : 0)}>{deal.isOffer ? tr('wl.acceptOfferProceed','Accept Offer & Proceed') : tr('wl.acceptProceed','Accept & Proceed')}</Btn>
                      {/* bug #37 — a WAITING decline is a CANCEL, not a refund:
                          no money has moved yet, and the refund route only
                          accepts ESCROW/DISPUTED (and is staff-gated), so wiring
                          this to onRefund made it fail every time and prompted
                          the seller for an Admin PIN. */}
                      <Btn variant="danger" full icon="x" onClick={() => onCancel ? onCancel(deal.id) : onRefund(deal.id)}>{tr('wl.declineOrder','Decline Order')}</Btn>
                    </>
                  )}
                  {/* Either party (or staff) may cancel while nothing is escrowed. */}
                  {onCancel && (
                    <Btn variant="ghost" full icon="ban" onClick={() => onCancel(deal.id)}>{tr('wl.cancelDeal','Cancel Deal')}</Btn>
                  )}
                  <div className="text-[11px] text-arc-faint text-center">On Proceed: buyer funds &amp; seller collateral enter escrow, and the middleman joins.</div>
                </>
              )}
              {deal.status === 'ESCROW' && (
                <>
                  {/* ---- Seller: deliver, and top up the buyer's protection ---- */}
                  {isSeller && (
                    <>
                      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-arc-faint"><Icon name="store" size={13} className="text-emerald-400" /> {tr('wl.sellerActions','Seller Actions')}</div>
                      {/* D3 — on a fiat deal the seller cannot claim delivery
                          before confirming the money arrived (the DB enforces
                          this too, so the button just avoids a guaranteed 400). */}
                      {deal.fiatLeg && onConfirmPayment && !deal.paymentConfirmedAt && (
                        deal.paymentMarkedAt
                          ? <Btn variant="emerald" full icon="banknote" onClick={() => onConfirmPayment(deal.id)}>{tr('wl.confirmPaymentReceived','Confirm Payment Received')}</Btn>
                          : <div className="text-[11px] text-arc-muted leading-relaxed"><Icon name="banknote" size={12} className="inline mr-1 text-arc-faint" />{tr('wl.waitingBuyerPay','Waiting for the buyer to send the payment. Confirm it here once it lands.')}</div>
                      )}
                      {!deal.deliveredAt && onMarkDelivered && (
                        <Btn variant="emerald" full icon="package-check" disabled={deal.fiatLeg && !deal.paymentConfirmedAt} onClick={() => onMarkDelivered(deal.id)}>{tr('wl.markDelivered','Mark as Delivered')}</Btn>
                      )}
                      {deal.deliveredAt && (
                        <div className="text-[12px] text-arc-muted leading-relaxed"><Icon name="package-check" size={13} className="text-emerald-400 inline mr-1.5" />{tr('wl.deliveredWaiting','Delivered — waiting for the buyer to confirm.')}</div>
                      )}
                      {onTopUpCollateral && (
                        <div className="pt-1 border-t border-arc-border">
                          <label className="text-sm text-arc-muted">{tr('wl.addCollateral','Add collateral (USDC)')}</label>
                          <div className="flex gap-2 mt-2">
                            <input value={col} onChange={e => setCol(e.target.value.replace(/[^0-9.]/g, ''))} placeholder={tr('wl.addCollateralPh','as agreed in chat')} className="flex-1 bg-arc-bg/60 ring-1 ring-arc-border focus:ring-amber-500/50 rounded-xl px-3.5 h-10 text-sm text-arc-text placeholder-arc-faint outline-none font-mono transition" />
                            <Btn size="sm" variant="outline" icon="plus" disabled={!(parseFloat(col) > 0)} onClick={() => { onTopUpCollateral(deal.id, col); setCol(''); }}>{tr('wl.add','Add')}</Btn>
                          </div>
                          <div className="text-[11px] text-amber-300/80 mt-1.5 leading-relaxed">{tr('wl.addCollateralNote','Collateral can only grow — it can never be withdrawn, so the buyer’s protection never shrinks after they pay.')}</div>
                        </div>
                      )}
                    </>
                  )}

                  {/* ---- Buyer: confirm receipt, or escalate ---- */}
                  {isBuyer && (
                    <>
                      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-arc-faint"><Icon name="user" size={13} className="text-cyan-400" /> {tr('wl.buyerActions','Buyer Actions')}</div>
                      {/* D3 — declare the off-platform payment. The platform
                          cannot see a bank transfer, so this is the only way the
                          seller learns the money is on its way. */}
                      {deal.fiatLeg && onMarkPaid && !deal.paymentMarkedAt && (
                        <Btn variant="outline" full icon="banknote" onClick={() => onMarkPaid(deal.id)}>{tr('wl.iHavePaid','I Have Sent the Payment')}</Btn>
                      )}
                      {deal.fiatLeg && deal.paymentMarkedAt && !deal.paymentConfirmedAt && (
                        <div className="text-[11px] text-amber-300/90 leading-relaxed"><Icon name="clock" size={12} className="inline mr-1" />{tr('wl.waitingSellerConfirm','Payment marked as sent — waiting for the seller to confirm they received it.')}</div>
                      )}
                      {onConfirmReceipt && (
                        <Btn variant="emerald" full icon="check-check" onClick={() => onConfirmReceipt(deal.id)}>{tr('wl.confirmReceipt','Confirm Receipt & Release')}</Btn>
                      )}
                      {onDispute && (
                        <Btn variant="outline" full icon="shield-alert" onClick={() => onDispute(deal.id)}>{tr('wl.raiseDispute','Raise a Dispute')}</Btn>
                      )}
                      <div className="text-[11px] text-arc-faint text-center">{tr('wl.confirmNote','Confirming releases the funds to the seller immediately — you need the platform for nothing.')}</div>
                    </>
                  )}

                  {/* ---- Staff: arbitrate ---- */}
                  {isStaff && (
                    <>
                      <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-arc-faint"><Icon name="shield" size={13} className="text-arc-accent" /> {tr('wl.middlemanDecision','Middleman / Admin Decision')}</div>
                      <Btn variant="emerald" full icon="check-check" onClick={() => onRelease(deal.id)}>{tr('wl.releaseToSeller','Release Funds to Seller')}</Btn>
                      <Btn variant="danger" full icon="undo-2" onClick={() => onRefund(deal.id)}>{tr('wl.refundToBuyer','Refund to Buyer')}</Btn>
                      {onSlash && deal.sellerCollateral > 0 && (
                        <Btn variant="danger" full icon="shield-alert" onClick={() => onSlash(deal.id)}>{tr('wl.slashCollateral','Rule Fraud — Forfeit Collateral')}</Btn>
                      )}
                    </>
                  )}

                  {/* Neither party and not staff — explain who decides. */}
                  {!isBuyer && !isSeller && !isStaff && (
                    <div className="text-[12px] text-arc-muted leading-relaxed">
                      <Icon name="shield" size={13} className="text-arc-accent inline mr-1.5" />
                      {tr('wl.awaitingMiddleman','Funds are in escrow. A middleman or admin will release or refund once the deal is settled.')}
                    </div>
                  )}

                  {/* Escape hatch. The two directions are mutually exclusive:
                      release opens after delivery + the confirm window; refund
                      opens once the delivery deadline passes undelivered. */}
                  {(onEscapeHatch && (deal.deliveredAt ? confirmPassed : deliveryPassed)) && (
                    <div className="pt-1 border-t border-arc-border">
                      <div className="text-[11px] text-amber-300/90 mb-2 leading-relaxed">
                        {deal.deliveredAt
                          ? tr('wl.escapeConfirmNote','The buyer did not confirm in time. Anyone can now release the funds to the seller without the middleman.')
                          : tr('wl.escapeDeliveryNote','The seller did not deliver in time. Anyone can now refund the buyer without the middleman.')}
                      </div>
                      <div className="flex gap-2">
                        {deal.deliveredAt
                          ? <Btn size="sm" variant="outline" full icon="unlock" onClick={() => onEscapeHatch(deal.id, 'release')}>{tr('wl.escapeRelease','Force Release')}</Btn>
                          : <Btn size="sm" variant="outline" full icon="undo-2" onClick={() => onEscapeHatch(deal.id, 'refund')}>{tr('wl.escapeRefund','Force Refund')}</Btn>}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ---- Disputed: frozen until the middleman rules ---- */}
              {disputed && (
                <>
                  <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-arc-faint"><Icon name="shield-alert" size={13} className="text-rose-400" /> {tr('wl.disputeOpen','Dispute Open')}</div>
                  {isStaff ? (
                    <>
                      <Btn variant="emerald" full icon="check-check" onClick={() => onRelease(deal.id)}>{tr('wl.releaseToSeller','Release Funds to Seller')}</Btn>
                      <Btn variant="danger" full icon="undo-2" onClick={() => onRefund(deal.id)}>{tr('wl.refundToBuyer','Refund to Buyer')}</Btn>
                      {onSlash && deal.sellerCollateral > 0 && (
                        <Btn variant="danger" full icon="shield-alert" onClick={() => onSlash(deal.id)}>{tr('wl.slashCollateral','Rule Fraud — Forfeit Collateral')}</Btn>
                      )}
                      <div className="text-[11px] text-arc-faint text-center">{tr('wl.slashNote','Forfeit the collateral only when the seller is proven to have defrauded the buyer — the deposit is compensation, not a penalty.')}</div>
                    </>
                  ) : (
                    <div className="text-[12px] text-arc-muted leading-relaxed">
                      <Icon name="clock" size={13} className="text-amber-400 inline mr-1.5" />
                      {tr('wl.disputeWaiting','The middleman is reviewing. Nothing moves until they decide — and if they never do, the buyer is refunded automatically after 30 days.')}
                    </div>
                  )}
                </>
              )}
            </Card>
          )}
        </div>

        {/* RIGHT: chat */}
        <div className="lg:col-span-3">
          <Card className="flex flex-col h-[560px]">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-arc-border">
              <Icon name="messages-square" size={16} className="text-arc-accent" />
              <span className="text-sm font-semibold text-arc-text">{tr('wl.dealRoom','Deal Room')}</span>
              {deal.middlemanJoined && <PixBadge color="blue" className="ml-1">{tr('wl.middlemanBadge','MIDDLEMAN')}</PixBadge>}
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-emerald-400"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 pulse-glow"></span> {tr('wl.monitored','Monitored')}</span>
            </div>
            <div ref={ref} className="flex-1 overflow-y-auto p-4 space-y-3 bg-arc-bg/30">
              {msgs.map((m, i) => <WLMsg key={i} m={m} />)}
            </div>
            {closed ? (
              <div className="px-4 py-4 border-t border-arc-border text-center text-sm text-arc-faint">{tr('wl.roomClosed','Room closed')} — {deal.status === 'COMPLETED' ? tr('wl.dealCompleted','deal completed') : tr('wl.dealCancelled','deal cancelled')}.</div>
            ) : (
              <div className="p-3 border-t border-arc-border flex items-center gap-2">
                <button className="w-10 h-10 rounded-xl bg-arc-surface2 hover:bg-arc-border text-arc-muted flex items-center justify-center transition shrink-0"><Icon name="paperclip" size={16} /></button>
                <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder={tr('wl.messagePh','Message the seller / middleman…')}
                  className="flex-1 bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl px-3 h-10 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
                <Btn icon="send" className="shrink-0" onClick={send}>{tr('c.send','Send')}</Btn>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---- WL deals list ----
function WLDeals({ deals, onOpen, onBrowse }) {
  if (deals.length === 0)
    return (
      <Card className="py-16 flex flex-col items-center gap-3">
        <div className="w-14 h-14 rounded-2xl bg-arc-primary/10 ring-1 ring-arc-primary/25 flex items-center justify-center"><Icon name="gem" size={26} className="text-arc-accent" /></div>
        <div className="text-sm text-arc-muted">{tr('wl.noDealsYet','No WL deals yet. Start from WL Market.')}</div>
        <Btn variant="primary" icon="gem" onClick={onBrowse}>{tr('wl.browseMarket','Browse WL Market')}</Btn>
      </Card>
    );
  return (
    <div className="space-y-3">
      {deals.map(d => {
        const sm = WL_STAGE_META[d.status];
        const tm = wlTypeMeta(d.listing ? d.listing.type : 'wl');
        const dStatusLabel = (STATUS_META[d.status] || {}).label || d.status;
        const listing = d.listing || {};
        const project = listing.project || d.project || 'Unknown';
        const gradient = listing.gradient || 'from-slate-600 to-slate-800';
        const glyph = listing.glyph || '📦';
        const img = listing.img || null;
        return (
          <button key={d.id} onClick={() => onOpen(d.id)} className="w-full text-left">
            <Card className="p-4 hover:ring-arc-primary/40 transition">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="font-mono text-xs text-arc-muted">{d.id}</span>
                <PixBadge color={sm.tone}>{dStatusLabel}</PixBadge>
                {d.sellerCollateral > 0 && <PixBadge color="amber">{tr('wl.collateralBadge','COLLATERAL')}</PixBadge>}
                {d.isOffer && <PixBadge color="blue">OFFER</PixBadge>}
                {/* .D3 — wallet-method badges */}
                {d.buyerPayerWalletType === 'eoa' && <PixBadge color="violet">{tr('wl.fundedEoa','FUNDED EOA')}</PixBadge>}
                {d.buyerPayerWalletType === 'ucw' && <PixBadge color="cyan">{tr('wl.fundedUcw','FUNDED UCW')}</PixBadge>}
                {d.sellerCollateralWalletType === 'eoa' && <PixBadge color="violet">{tr('wl.collEoa','COLL EOA')}</PixBadge>}
                <span className="ml-auto text-xs text-arc-faint">{d.date}</span>
              </div>
              <div className="flex items-center gap-3 mt-3">
                <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${gradient} grid-noise flex items-center justify-center text-xl shrink-0 bg-cover bg-center`} style={img ? { backgroundImage: `url(${img})` } : {}}>{!img && glyph}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-arc-text truncate">{project}</div>
                  <div className="text-[11px] text-arc-faint">{tm.label} · {tr('c.seller','Seller')}: {d.seller} · {sm.label}</div>
                </div>
                <Usdc value={d.price} className="text-emerald-400 font-bold shrink-0" />
              </div>
            </Card>
          </button>
        );
      })}
    </div>
  );
}

// ---- Escrow Page (tabbed wrapper) ----
function EscrowPage({ wlListings, wlDeals, role, saldo, onList, onDeal, onOpenDeal, notify }) {
  const [tab, setTab] = useState('wl');
  const [detail, setDetail] = useState(null);
  const [listOpen, setListOpen] = useState(false);
  const [q, setQ] = useState('');
  // A1 — show one book at a time: sell offers (WTS) or buy requests (WTB).
  const [book, setBook] = useState('WTS');

  const list = wlListings
    .filter(w => (w.side === 'WTB' ? 'WTB' : 'WTS') === book)
    .filter(w => w.project.toLowerCase().includes(q.toLowerCase()) || w.wlType.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="anim-view">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-bold text-white">{tr('escrow.title','Escrow')}</h1>
          <PixBadge color="emerald">{tr('wl.securedBadge','SECURED')}</PixBadge>
        </div>
        <span className="inline-flex items-center gap-1.5 text-sm text-emerald-300"><Icon name="shield-check" size={15} /> {tr('escrow.guarded','Guarded by Middleman & Smart Contract')}</span>
      </div>

      {/* tabs */}
      <div className="flex items-center gap-1 mb-5 border-b border-arc-border overflow-x-auto">
        {[['wl', 'gem', 'WL Market'], ['deals', 'layers', tr('wl.deals','WL Deals') + ` (${wlDeals.length})`]].map(([id, ic, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition whitespace-nowrap ${tab === id ? 'border-arc-primary text-arc-accent' : 'border-transparent text-arc-muted hover:text-arc-text'}`}>
            <Icon name={ic} size={15} /> {label}
          </button>
        ))}
      </div>

      {tab === 'deals' && <WLDeals deals={wlDeals} onOpen={onOpenDeal} onBrowse={() => setTab('wl')} />}
      {tab === 'wl' && (
        <>
          {/* WL banner */}
          <div className="relative overflow-hidden rounded-2xl ring-1 ring-arc-primary/25 bg-gradient-to-r from-arc-primary/20 via-arc-surface2 to-arc-surface p-5 mb-5">
            <div className="absolute -right-6 -bottom-8 opacity-20"><SlimeLogo size={150} /></div>
            <div className="relative flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1">
                <Pixel className="text-arc-accent text-[9px]">{tr('wl.whitelistEscrow','WHITELIST ESCROW')}</Pixel>
                <h2 className="text-lg font-bold text-white mt-2">{tr('wl.bannerTitle','Secure WL deals with a Middleman.')}</h2>
                <p className="text-sm text-arc-muted mt-1 max-w-md">{tr('wl.bannerSub','Mint, Token Transfer, Wallet/Discord Surrender, Wallet Submit — all must go through escrow. Buyer & seller are protected, with collateral held for risky types.')}</p>
              </div>
              <Btn variant="primary" icon="gem" onClick={() => setListOpen(true)}>{tr('wl.sellSpot','Sell WL Spot')}</Btn>
            </div>
          </div>

          {/* A1 — the two books. WTS = people selling, WTB = people buying. */}
          <div className="flex items-center gap-2 mb-4">
            {[['WTS', 'Sell Offers'], ['WTB', 'Buy Requests']].map(([val, label]) => {
              const n = wlListings.filter(w => (w.side === 'WTB' ? 'WTB' : 'WTS') === val).length;
              return (
                <button key={val} onClick={() => setBook(val)}
                  className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium ring-1 transition ${book === val ? (val === 'WTB' ? 'bg-cyan-500/15 ring-cyan-500/40 text-cyan-200' : 'bg-emerald-500/15 ring-emerald-500/40 text-emerald-200') : 'bg-arc-surface/60 ring-arc-border text-arc-muted hover:text-arc-text'}`}>
                  <Icon name={val === 'WTB' ? 'search' : 'store'} size={14} /> {label}
                  <span className="text-[10px] opacity-70">{n}</span>
                </button>
              );
            })}
          </div>

          {/* search */}
          <div className="flex gap-2 mb-5">
            <div className="relative flex-1">
              <Icon name="search" size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-arc-faint" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder={tr('wl.searchPh','Search project / WL type…')}
                className="w-full bg-arc-surface/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl pl-10 pr-3 h-11 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
            </div>
            <Btn size="lg" variant="primary" icon="plus" onClick={() => setListOpen(true)} className="hidden sm:inline-flex">{tr('wl.sell','Sell WL')}</Btn>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {list.map(w => <WLCard key={w.id} wl={w} onOpen={setDetail} />)}
          </div>
          {list.length === 0 && <div className="text-center text-arc-faint py-16 text-sm">{tr('wl.noMatch','No matching WL.')}</div>}
        </>
      )}

      <WLDetailModal wl={detail} saldo={saldo} onClose={() => setDetail(null)} onDeal={(d) => { setDetail(null); onDeal(d); }} />
      <WLListingModal open={listOpen} role={role} onClose={() => setListOpen(false)} notify={notify} onList={(l) => { setListOpen(false); onList(l); }} />
    </div>
  );
}

Object.assign(window, { EscrowPage, WLDealRoom, WLDeals });
