// ============ Middleman Console (Escrow + Tribunal + Stats) ============

// ---- resolve dispute modal ----
function ResolveModal({ dispute, onClose, onResolve }) {
  const [winner, setWinner] = useState(null);
  const [note, setNote] = useState('');
  if (!dispute) return null;
  return (
    <Modal open={!!dispute} onClose={onClose} width="max-w-lg">
      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-arc-border bg-rose-500/5">
          <div className="w-10 h-10 rounded-xl bg-rose-500/15 ring-1 ring-rose-500/30 flex items-center justify-center text-rose-300"><Icon name="gavel" size={18} /></div>
          <div>
            <div className="font-semibold text-arc-text">{tr('admin.resolve','Resolve Dispute')}</div>
            <div className="text-[12px] text-arc-muted mt-1.5">{tr('admin.reason','Reason')}: {dispute.reason}</div>
          </div>
          <button onClick={onClose} className="ml-auto w-8 h-8 rounded-lg hover:bg-arc-surface2 text-arc-muted flex items-center justify-center"><Icon name="x" size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex items-center gap-3 flex-wrap text-[11px] text-arc-faint">
            <span className="inline-flex items-center gap-1"><Icon name="paperclip" size={11} /> {dispute.evidence} {tr('admin.evidence','evidence')}</span>
            <span className="inline-flex items-center gap-1"><Icon name="clock" size={11} /> {dispute.age} {tr('admin.ago','ago')}</span>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-arc-faint mb-2">{tr('admin.winner','Winning party')}</div>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => setWinner('buyer')} className={`rounded-xl ring-1 px-4 py-3 text-left transition ${winner === 'buyer' ? 'ring-rose-500 bg-rose-500/10' : 'ring-arc-border hover:ring-arc-faint'}`}>
                <div className="flex items-center gap-2"><Avatar gradient={dispute.buyerAv || 'from-rose-500 to-orange-600'} name={dispute.buyer} size={28} /> <span className="text-sm text-arc-text">{dispute.buyer}</span></div>
                <div className="text-[11px] text-arc-muted mt-1.5">{tr('admin.refundBuyer','Refund buyer')}</div>
              </button>
              <button onClick={() => setWinner('seller')} className={`rounded-xl ring-1 px-4 py-3 text-left transition ${winner === 'seller' ? 'ring-emerald-500 bg-emerald-500/10' : 'ring-arc-border hover:ring-arc-faint'}`}>
                <div className="flex items-center gap-2"><Avatar gradient={dispute.sellerAv || 'from-cyan-500 to-blue-600'} name={dispute.seller} size={28} /> <span className="text-sm text-arc-text">{dispute.seller}</span></div>
                <div className="text-[11px] text-arc-muted mt-1.5">{tr('admin.releaseSeller','Release to seller')}</div>
              </button>
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-arc-faint mb-2">{tr('admin.decisionNote','Decision note')} <span className="text-arc-faint">{tr('admin.auditNote','(recorded in audit log)')}</span></div>
            <textarea rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder={tr('admin.notePlaceholder','Tribunal decision reason.')}
              className="w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl px-3 py-2.5 text-sm text-arc-text placeholder-arc-faint outline-none resize-none"></textarea>
          </div>
          <div className="text-[12px] text-arc-muted" style={{ textWrap: 'pretty' }}>
            {winner === 'buyer' && <><Icon name="undo-2" size={12} className="inline text-rose-400 mr-1" />{tr('admin.funds','Funds')} <Usdc value={dispute.amount} /> {tr('admin.refundedTo','refunded to')} <b className="text-arc-text">{dispute.buyer}</b>{dispute.collateral ? ` · ${tr('admin.sellerCollateral','seller collateral')} ${dispute.collateral} USDC ${tr('admin.heldSeized','held/seized')}` : ''}.</>}
            {winner === 'seller' && <><Icon name="check-check" size={12} className="inline text-emerald-400 mr-1" />{tr('admin.funds','Funds')} {tr('admin.releasedTo','released to')} <b className="text-arc-text">{dispute.seller}</b>{dispute.collateral ? ` · ${tr('admin.collateralReturned','collateral returned')}` : ''}.</>}
            {!winner && tr('admin.pickWinnerFirst','Pick the winning party first.')}
          </div>
          <Btn variant={winner === 'buyer' ? 'danger' : 'emerald'} full icon="gavel" disabled={!winner} onClick={() => onResolve(dispute, winner, note)}>{tr('admin.execDecision','Execute Decision')}</Btn>
        </div>
      </Card>
    </Modal>
  );
}

// onReleaseDeal/onRefundDeal props were dropped: they routed through
// app.jsx's api() which omits X-Admin-Token, so escrow actions always 401'd.
// This console calls the endpoints itself (see executeMmAction).
function MiddlemanConsole({ wlDeals, onOpenDeal, notify }) {
  // MM lands on Escrow Watch (its only job); Admin opens on the Tribunal.
  const [tab, setTab] = useState((typeof ME !== 'undefined' && ME.role === 'Admin') ? 'disputes' : 'escrow');
  const [disputes, setDisputes] = useState([]);
  const [resolving, setResolving] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mmStats, setMmStats] = useState([]);
  const [mmStatsLoading, setMmStatsLoading] = useState(false);
  const [loadedTabs, setLoadedTabs] = useState(new Set());
  // Admin action token ref — routes no longer REQUIRE the token (session role
  // is the gate), but an older tab may still mint one via /api/admin/verify.
  const adminTokenRef = useRef(null);

  const API = window.SLIME_API || '';
  const api = async (path, opts = {}) => {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (adminTokenRef.current) headers['X-Admin-Token'] = adminTokenRef.current;
    const res = await fetch(API + path, { credentials: 'include', headers, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  };

  // PIN step-action token REMOVED at the owner's request: the session role
  // (Admin/MM, Circle email OTP) is the only gate — actions execute directly.
  const requireAdminAuth = (action, payload) => executeMmAction(action, payload);

  const executeMmAction = async (action, payload) => {
    try {
      if (action === 'resolveDispute') {
        await api('/api/admin/disputes/' + payload.orderId + '/resolve', {
          method: 'POST', body: JSON.stringify({ decision: payload.decision, reason: payload.reason }),
        });
        setDisputes(list => list.filter(x => x.id !== payload.orderId));
        notify('Dispute resolved: ' + payload.decision, payload.decision === 'refund' ? 'info' : 'success');
      } else if (action === 'releaseDeal' || action === 'refundDeal') {
        // these used to go through app.jsx's global api(), which does
        // NOT attach X-Admin-Token, so /api/wl/deals/[id]/release|refund
        // (requireStaffAuth) always 401'd. Call them from here instead, where
        // the token is attached, and refresh the wallet after the relay.
        const path = action === 'releaseDeal'
          ? '/api/wl/deals/' + payload.dealId + '/release'
          : '/api/wl/deals/' + payload.dealId + '/refund';
        await api(path, { method: 'POST' });
        notify(action === 'releaseDeal' ? 'Funds released to seller' : 'Funds refunded to buyer',
               action === 'releaseDeal' ? 'success' : 'info');
        window.refreshWallet?.();
      }
    } catch (e) { notify('Action failed: ' + e.message, 'error'); }
    setResolving(null);
  };

  useEffect(() => {
    // Disputes are Admin-only (GET /api/admin/disputes uses requireRole("Admin")).
    // Skip the call for a pure MM instead of logging a 403 on every mount.
    if (!(typeof ME !== 'undefined' && ME.role === 'Admin')) { setLoading(false); return; }
    (async () => {
      try {
        const dRes = await api('/api/admin/disputes').catch(() => ({ items: [] }));
        setDisputes((dRes.items || []).map(d => ({
          id: d.orderId, kind: 'order', title: d.productName, variant: '',
          buyer: d.buyerName, buyerAv: 'from-arc-primary to-arc-accent',
          seller: d.sellerName, sellerAv: 'from-cyan-500 to-blue-600',
          amount: Number(d.amount) / 1000000, reason: d.reason,
          evidence: 0, age: d.appealedAt ? new Date(d.appealedAt).toLocaleString() : '-', sla: 'normal',
          chatThreadId: d.chatThreadId,
        })));
        setLoadedTabs(s => new Set(s).add('disputes'));
      } catch (e) { console.error('MM fetch disputes failed:', e); }
      setLoading(false);
    })();
  }, []);

  const fetchMmStats = async () => {
    setMmStatsLoading(true);
    try {
      const d = await api('/api/admin/mm/stats');
      setMmStats(d.items || []);
      setLoadedTabs(s => new Set(s).add('mmstats'));
    } catch (e) { notify('Failed to load MM stats: ' + e.message, 'error'); }
    setMmStatsLoading(false);
  };

  useEffect(() => {
    if (tab === 'mmstats' && !loadedTabs.has('mmstats')) fetchMmStats();
  }, [tab]);

  const resolveDispute = async (d, winner, note) => {
    const decision = winner === 'buyer' ? 'refund' : 'release';
    requireAdminAuth('resolveDispute', { orderId: d.id, decision, reason: note || 'Tribunal decision: ' + winner });
  };

  const escrowAction = (e, kind) => {
    if (e.real) {
      // Route through the PIN gate: the release/refund endpoints require a valid
      // X-Admin-Token (requireStaffAuth), which only exists after PIN verify.
      requireAdminAuth(kind === 'release' ? 'releaseDeal' : 'refundDeal', { dealId: e.id });
      return;
    }
    notify(kind === 'release' ? 'Funds released to ' + e.seller : 'Refund to ' + e.buyer, kind === 'release' ? 'success' : 'info');
  };

  const liveEscrow = (wlDeals || []).filter(d => d.status === 'ESCROW').map(d => ({
    id: d.id, title: (d.listing?.project || 'Deal') + ' · ' + (d.listing?.wlType || ''), type: d.listing?.type || 'escrow',
    buyer: 'buyer', seller: d.seller || 'seller', price: d.price || 0, collateral: d.sellerCollateral || 0, joined: d.middlemanJoined, age: d.date || 'recent', real: true,
    // .D3 — funding-method badges on the admin Escrow Watch rows.
    payerType: d.buyerPayerWalletType || null, collType: d.sellerCollateralWalletType || null,
  }));
  const escrow = liveEscrow;
  const lockedValue = escrow.reduce((s, e) => s + e.price + (e.collateral || 0), 0);

  // an MM's job is escrow release/refund, nothing else. The Tribunal and
  // MM Stats tabs call Admin-only endpoints (/api/admin/disputes,
  // /api/admin/mm/stats), so rendering them for a pure MM only produced 403s.
  // Hide them unless the viewer is an Admin.
  const isAdminViewer = (typeof ME !== 'undefined' && ME.role === 'Admin');

  const TABS = [
    ...(isAdminViewer ? [{ id: 'disputes', label: tr('mm.disputes','Tribunal'), icon: 'gavel', count: disputes.length }] : []),
    { id: 'escrow', label: tr('mm.escrow','Escrow Watch'), icon: 'lock', count: escrow.length },
    ...(isAdminViewer ? [{ id: 'mmstats', label: tr('mm.stats','MM Stats'), icon: 'bar-chart-3', count: 0 }] : []),
  ];

  return (
    <div className="anim-view">
      <div className="flex items-center gap-2.5 mb-1">
        <h1 className="text-xl font-bold text-white">{tr('mm.title','Middleman Panel')}</h1>
        <PixBadge color="violet">ESCROW OPERATOR</PixBadge>
      </div>
      <p className="text-sm text-arc-muted mb-5">{tr('mm.subtitle','Dispute tribunal, live escrow monitoring, and deal statistics. Release or refund funds for WL escrow deals.')}</p>

      {/* stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <AdmStat icon="gavel" label={tr('mm.activeDisputes','Active Disputes')} value={disputes.length} sub={disputes.filter(d => d.sla === 'urgent').length + ' urgent'} tone="rose" />
        <AdmStat icon="lock" label={tr('mm.escrowLocked','Locked Escrow')} value={escrow.length} sub={lockedValue.toFixed(0) + ' USDC ' + tr('mm.value','value')} tone="violet" />
        <AdmStat icon="handshake" label={tr('mm.totalDeals','Total Deals')} value={mmStats.reduce((s, m) => s + m.deal_count, 0)} sub="all time" tone="emerald" />
        <AdmStat icon="undo-2" label={tr('mm.refunds','Refunds')} value={mmStats.reduce((s, m) => s + m.refund_count, 0)} sub="processed" tone="amber" />
      </div>

      {/* tabs */}
      <div className="flex items-center gap-1 border-b border-arc-border mb-5 overflow-x-auto">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition ${tab === t.id ? 'border-arc-primary text-arc-accent' : 'border-transparent text-arc-muted hover:text-arc-text'}`}>
            <Icon name={t.icon} size={15} /> {t.label}
            {t.count > 0 && <span className={`text-[10px] font-pixel px-1.5 py-1 rounded ${tab === t.id ? 'bg-arc-primary/20 text-arc-accent' : 'bg-arc-surface2 text-arc-muted'}`}>{t.count}</span>}
          </button>
        ))}
      </div>

      {/* === Tribunal === */}
      {tab === 'disputes' && (
        <div className="space-y-3">
          {loading && <div className="text-sm text-arc-muted py-8 text-center">Loading disputes...</div>}
          {!loading && disputes.length === 0 && <Empty icon="party-popper" text={tr('mm.noDisputes','No active disputes. All clear!')} />}
          {disputes.map(d => (
            <Card key={d.id} className="p-4">
              <div className="flex items-start gap-3 flex-wrap">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${d.kind === 'wl' ? 'bg-arc-primary/15 text-arc-accent' : 'bg-rose-500/15 text-rose-300'}`}><Icon name={d.kind === 'wl' ? 'hexagon' : 'package-open'} size={18} /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs text-arc-muted">{d.id}</span>
                    {d.sla === 'urgent' && <PixBadge color="rose">URGENT</PixBadge>}
                    <span className="text-[11px] text-arc-faint">{d.age} {tr('admin.ago','ago')}</span>
                  </div>
                  <div className="text-sm font-semibold text-arc-text mt-1">{d.title} <span className="text-arc-faint font-normal">· {d.variant}</span></div>
                  <div className="text-[12px] text-arc-muted mt-1" style={{ textWrap: 'pretty' }}>{d.reason}</div>
                  <div className="flex items-center gap-3 mt-2 text-[11px] text-arc-faint">
                    <span className="inline-flex items-center gap-1"><Avatar gradient={d.buyerAv} name={d.buyer} size={16} /> {d.buyer}</span>
                    <Icon name="arrow-left-right" size={12} />
                    <span className="inline-flex items-center gap-1"><Avatar gradient={d.sellerAv} name={d.seller} size={16} /> {d.seller}</span>
                    <span className="inline-flex items-center gap-1 ml-1"><Icon name="paperclip" size={11} /> {d.evidence}</span>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <Usdc value={d.amount} className="text-emerald-400 font-bold" />
                  <div className="flex gap-2">
                    <Btn size="sm" variant="outline" icon="messages-square" onClick={() => notify(tr('admin.joinedRoom','Joined dispute room') + ' ' + d.id, 'info')}>{tr('admin.room','Room')}</Btn>
                    <Btn size="sm" variant="danger" icon="gavel" onClick={() => setResolving(d)}>{tr('admin.decide','Resolve')}</Btn>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* === Escrow Watch === */}
      {tab === 'escrow' && (
        <div className="space-y-3">
          {escrow.length === 0 && <Empty icon="lock-open" text={tr('mm.noEscrow','No active escrow right now.')} />}
          {escrow.map(e => (
            <Card key={e.id} className="p-4">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="w-10 h-10 rounded-xl bg-arc-primary/15 text-arc-accent flex items-center justify-center shrink-0"><Icon name="lock" size={18} /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs text-arc-muted">{e.id}</span>
                    <PixBadge color={e.type === 'escrow' ? 'cyan' : 'blue'}>{e.type.toUpperCase()}</PixBadge>
                    {e.real && <PixBadge color="emerald">LIVE</PixBadge>}
                    {/* .D3 — funding-method badges (buyer payer + seller collateral) */}
                    {e.payerType && <PixBadge color={e.payerType === 'eoa' ? 'violet' : 'cyan'}>{(e.payerType === 'eoa' ? 'BUYER EOA' : 'BUYER UCW')}</PixBadge>}
                    {e.collType && <PixBadge color={e.collType === 'eoa' ? 'violet' : 'cyan'}>{(e.collType === 'eoa' ? 'COLL EOA' : 'COLL UCW')}</PixBadge>}
                    {e.joined && <span className="text-[11px] text-emerald-400 inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> joined</span>}
                  </div>
                  <div className="text-sm font-semibold text-arc-text mt-1 truncate">{e.title}</div>
                  <div className="text-[11px] text-arc-faint mt-1">{e.buyer} → {e.seller} · {e.age}{e.collateral > 0 ? ' · collateral ' + e.collateral + ' USDC' : ''}</div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <Usdc value={e.price} className="text-emerald-400 font-bold" />
                  <div className="flex gap-2">
                    {e.real && <Btn size="sm" variant="ghost" icon="external-link" onClick={() => onOpenDeal(e.id)}>{tr('admin.open','Open')}</Btn>}
                    <Btn size="sm" variant="danger" icon="undo-2" onClick={() => escrowAction(e, 'refund')}>{tr('admin.refund','Refund')}</Btn>
                    <Btn size="sm" variant="emerald" icon="check-check" onClick={() => escrowAction(e, 'release')}>{tr('admin.release','Release')}</Btn>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* === MM Stats === */}
      {tab === 'mmstats' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <AdmStat icon="users" label="Middlemen" value={mmStats.length} sub="total" tone="rose" />
            <AdmStat icon="handshake" label="Total Deals" value={mmStats.reduce((s, m) => s + m.deal_count, 0)} sub="all time" tone="violet" />
            <AdmStat icon="check-check" label="Releases" value={mmStats.reduce((s, m) => s + m.release_count, 0)} sub="completed" tone="emerald" />
            <AdmStat icon="undo-2" label="Refunds" value={mmStats.reduce((s, m) => s + m.refund_count, 0)} sub="processed" tone="amber" />
          </div>
          {mmStatsLoading && <div className="text-sm text-arc-muted py-8 text-center">Loading stats...</div>}
          {!mmStatsLoading && mmStats.length === 0 && <Empty icon="bar-chart-3" text="No middleman activity yet." />}
          {!mmStatsLoading && mmStats.length > 0 && (
            <Card className="overflow-hidden">
              <div className="divide-y divide-arc-border/60">
                {mmStats.map(m => (
                  <div key={m.user_id} className="flex items-center gap-3 px-4 py-3">
                    <Avatar gradient="from-rose-500 to-orange-600" name={m.name} size={36} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-arc-text">{m.name} <span className="text-arc-faint">· {m.email}</span></div>
                      <div className="text-[11px] text-arc-muted mt-0.5">
                        {m.deal_count} deals · {m.release_count} releases · {m.refund_count} refunds
                        {m.last_action_at && ' · last ' + new Date(m.last_action_at).toLocaleDateString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-bold text-arc-accent tabular-nums">{m.deal_count}</span>
                      <span className="text-[10px] text-arc-faint">deals</span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      <ResolveModal dispute={resolving} onClose={() => setResolving(null)} onResolve={resolveDispute} />
    </div>
  );
}

Object.assign(window, { MiddlemanConsole, ResolveModal });
