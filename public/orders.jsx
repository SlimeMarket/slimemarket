// ============ Views: My Orders (list) + Order Detail ============

// .D — payer method badge (orders.payer_wallet_type, migration 0050).
// ucw → "UCW" (Circle user wallet), eoa → "EOA wallet" (MetaMask/Coinbase
// external wallet), platform → "Escrow" (legacy platform-funded). null → hidden.
// Shared by buyer (orders.jsx) and seller (seller.jsx) views.
function PayerBadge({ type }) {
  if (!type) return null;
  const cfg = {
    ucw: { label: tr('orders.payerUcw','UCW'), cls: 'ring-cyan-500/30 bg-cyan-500/10 text-cyan-300' },
    eoa: { label: tr('orders.payerEoa','EOA wallet'), cls: 'ring-violet-500/30 bg-violet-500/10 text-violet-300' },
    platform: { label: tr('orders.payerPlatform','Escrow'), cls: 'ring-arc-border bg-arc-surface2 text-arc-muted' },
  }[type];
  if (!cfg) return null;
  return <span className={`text-[9px] font-medium rounded px-1.5 py-0.5 ring-1 ${cfg.cls}`}>{cfg.label}</span>;
}

function OrderStatChip({ label, value, tone, active, onClick }) {
  const tones = {
    slate: 'ring-arc-border bg-arc-surface/60', amber: 'ring-amber-500/30 bg-amber-500/5',
    cyan: 'ring-cyan-500/30 bg-cyan-500/5', emerald: 'ring-emerald-500/30 bg-emerald-500/5',
    rose: 'ring-rose-500/30 bg-rose-500/5',
  };
  const text = { slate: 'text-arc-text', amber: 'text-amber-300', cyan: 'text-cyan-300', emerald: 'text-emerald-300', rose: 'text-rose-300' };
  return (
    <button onClick={onClick} className={`text-left rounded-2xl ring-1 px-4 py-3.5 transition ${tones[tone]} ${active ? 'ring-2 ' + (tone === 'slate' ? 'ring-arc-primary/50' : '') : 'hover:ring-arc-borderlt'}`}>
      <div className="text-[11px] uppercase tracking-wide text-arc-muted">{label}</div>
      <div className={`text-2xl font-bold mt-1 tabular-nums ${text[tone]}`}>{value}</div>
    </button>
  );
}

function PesananSaya({ orders, onOpen, onProduct, loading }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  // Gate the empty state on the parent's real fetch status instead of a timer,
  // so "No orders" never flashes while /api/orders is still in flight.
  const ordersLoaded = !loading;
  orders = orders || [];
  const total = orders.length;
  const processing = orders.filter(o => ['PROCESS', 'SENT', 'PENDING'].includes(o.status)).length;
  const completed = orders.filter(o => o.status === 'DONE').length;
  const disputes = orders.filter(o => o.status === 'DISPUTED').length;

  const list = orders.filter(o => {
    const matchQ = (o.id || '').toLowerCase().includes(q.toLowerCase()) || (o.title || '').toLowerCase().includes(q.toLowerCase());
    const matchF = filter === 'all'
      || (filter === 'processing' && ['PROCESS', 'SENT', 'PENDING'].includes(o.status))
      || (filter === 'completed' && o.status === 'DONE')
      || (filter === 'disputes' && o.status === 'DISPUTED');
    return matchQ && matchF;
  });

  return (
    <div className="anim-view">
      <h1 className="text-xl font-bold text-white mb-5">{tr('orders.title','My Orders')}</h1>

      {/* stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <OrderStatChip label={tr('orders.total','Total Orders')} value={total} tone="slate" active={filter === 'all'} onClick={() => setFilter('all')} />
        <OrderStatChip label={tr('orders.processing','Processing')} value={processing} tone="cyan" active={filter === 'processing'} onClick={() => setFilter('processing')} />
        <OrderStatChip label={tr('orders.completed','Completed')} value={completed} tone="emerald" active={filter === 'completed'} onClick={() => setFilter('completed')} />
        <OrderStatChip label={tr('orders.disputes','Disputed')} value={disputes} tone="rose" active={filter === 'disputes'} onClick={() => setFilter('disputes')} />
      </div>

      {/* search — filters live as you type */}
      <div className="flex gap-2 mb-5">
        <div className="relative flex-1">
          <Icon name="search" size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-arc-faint" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={tr('orders.searchPh','Search order # or product name…')}
            className="w-full bg-arc-surface/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl pl-10 pr-3 h-11 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
        </div>
      </div>

      {/* order cards */}
      <div className="space-y-3">
        {list.map(o => {
          const p = (window.PRODUCTS || []).find(x => x.id === o.productId);
          return (
            <Card key={o.id} className="overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-arc-border/70">
                <span className="font-mono text-xs text-arc-text">{o.id}</span>
                <StatusPill status={o.status} />
                <PayerBadge type={o.payerWalletType} />
                <span className="ml-auto text-xs text-arc-faint">{o.date}</span>
              </div>
              <div className="flex items-center gap-3.5 px-4 py-4">
                <div className={`w-14 h-14 rounded-xl bg-gradient-to-br ${p ? p.gradient : 'from-arc-surface2 to-arc-surface'} grid-noise flex items-center justify-center text-2xl shrink-0`}>{p ? p.glyph : '▣'}</div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-arc-text leading-tight truncate">{o.title}</div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <span className="text-[10px] font-medium text-arc-accent bg-arc-primary/15 ring-1 ring-arc-primary/25 rounded px-1.5 py-0.5">{o.variant}</span>
                  </div>
                  <div className="text-[11px] text-arc-faint mt-1">{tr('orders.qty','Qty')}: {o.qty} · {tr('orders.seller','Seller')}: <span className="text-arc-muted">{o.seller}</span></div>
                </div>
                <Usdc value={o.amount} className="text-emerald-400 font-bold text-base shrink-0" />
              </div>
              <button onClick={() => onOpen(o)} className="w-full text-left px-4 py-2.5 border-t border-arc-border/70 text-sm text-arc-accent hover:brightness-125 hover:bg-arc-surface2 transition inline-flex items-center gap-1">
                {tr('orders.viewDetail','View Detail')} <Icon name="arrow-right" size={14} />
              </button>
            </Card>
          );
        })}
        {list.length === 0 && <div className="text-center text-arc-faint py-16 text-sm">{ordersLoaded ? tr('orders.none','No orders matching this filter.') : 'Loading orders...'}</div>}
      </div>
    </div>
  );
}

// ---------- Order Detail ----------
function DetailPesanan({ order, onBack, onConfirm, onAppeal, onChat, onStore, onCancel, onReview, onRevokeAllowance }) {
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [nowTs, setNowTs] = useState(Date.now());
  const [t0, setT0] = useState(() => Date.now());
  useEffect(() => { setT0(Date.now()); setReveal(false); }, [order && order.id]);
  useEffect(() => { const id = setInterval(() => setNowTs(Date.now()), 1000); return () => clearInterval(id); }, []);
  if (!order) return null;

  const p = (window.PRODUCTS || []).find(x => x.id === order.productId);
  const store = (typeof STORES !== 'undefined' ? STORES : {})[order.seller];
  const credUnlocked = order.status === 'SENT' || order.status === 'DONE' || order.status === 'DISPUTED';
  const hasCreds = Object.keys(order.credentials || {}).length > 0;
  const total = +((order.amount || 0) + (order.adminFee || 0)).toFixed(2);
  // what a refund actually returns: the item amount only. The 2%
  // service fee is non-refundable, so `total` must not be shown as the refund.
  const refundAmount = +(order.amount || 0).toFixed(2);
  const done = order.status === 'DONE';
  const disputed = order.status === 'DISPUTED';
  const cancelled = order.status === 'CANCELLED' || order.status === 'DECLINED';
  const canCancel = order.status === 'PENDING' || order.status === 'PROCESS';
  const isManual = order.delivery === 'manual';
  const activeFlow = order.status === 'PENDING' || order.status === 'PROCESS' || order.status === 'SENT';

  const elapsed = nowTs - t0;
  const cancelLeft = 2 * 3600e3 + 58 * 60e3 - elapsed;
  // Only trust a server-provided release deadline. No client-side demo
  // fallback — if the server didn't send one, we show a placeholder instead of
  // a countdown that pretends to know when funds release.
  const releaseDeadlineTs = order.releaseDeadline ? new Date(order.releaseDeadline).getTime() : null;
  const releaseLeft = releaseDeadlineTs != null && !isNaN(releaseDeadlineTs) ? releaseDeadlineTs - nowTs : null;
  const fmtDur = (ms) => {
    if (ms <= 0) return '0s';
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d > 0) return d + 'd ' + h + 'h ' + String(m).padStart(2, '0') + 'm';
    if (h > 0) return h + 'h ' + String(m).padStart(2, '0') + 'm ' + String(sec).padStart(2, '0') + 's';
    return m + 'm ' + String(sec).padStart(2, '0') + 's';
  };

  const copyAll = () => {
    const txt = Object.entries(order.credentials || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
    navigator.clipboard?.writeText(txt); setCopied(true); setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="anim-view">
      {/* header */}
      <div className="flex flex-col sm:flex-row sm:items-start gap-2 mb-5">
        <div>
          <h1 className="text-xl font-bold text-white font-mono">{order.id}</h1>
          <div className="text-xs text-arc-faint mt-0.5 inline-flex items-center gap-2">{order.date} <PayerBadge type={order.payerWalletType} /></div>
        </div>
        <button onClick={onBack} className="sm:ml-auto inline-flex items-center gap-1.5 text-sm text-arc-accent hover:brightness-125 transition"><Icon name="arrow-left" size={15} /> {tr('od.backToOrders','Back to Orders')}</button>
      </div>

      {(order.onChainStatus === 'release_failed' || order.onChainStatus === 'refund_failed') && (
        <div className="px-4 py-3 rounded-xl bg-amber-500/10 ring-1 ring-amber-500/30 text-amber-300 text-sm flex items-center gap-2 mb-4">
          <Icon name="alert-triangle" size={16} /> On-chain {order.onChainStatus === 'release_failed' ? 'release' : 'refund'} failed. Retrying automatically...
        </div>
      )}

      {/* stepper / terminal banner */}
      {cancelled ? (
        <Card className="p-5 mb-5">
          <div className="flex items-start gap-3">
            <div className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${order.status === 'DECLINED' ? 'bg-rose-500/15 text-rose-300' : 'bg-arc-surface2 text-arc-muted'}`}>
              <Icon name={order.status === 'DECLINED' ? 'ban' : 'x-circle'} size={22} />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-arc-text">{order.status === 'DECLINED' ? tr('od.declined','Order Declined by Seller') : tr('od.cancelled','Order Cancelled')}</span>
                <StatusPill status={order.status} />
              </div>
              {order.cancelReason && <div className="text-xs text-arc-muted mt-1">{tr('od.reason','Reason')}: <span className="text-arc-text">{order.cancelReason}</span></div>}
              {/* the refund is paid by the escrow contract DIRECTLY to
                  the buyer's wallet, and only the item amount comes back (the
                  2% service fee is non-refundable). Showing `total` here
                  overstated the refund. */}
              <div className="text-[11px] text-emerald-400 mt-1.5 inline-flex items-center gap-1.5">
                <Icon name="undo-2" size={12} /> {tr('od.refunded','Refund')} <Usdc value={refundAmount} /> {tr('od.refundedToWallet','sent to your wallet on-chain.')}
              </div>
              {order.payment === 'Onchain' && order.onChainStatus === null && onRevokeAllowance && (
                <button onClick={() => onRevokeAllowance(order)}
                  className="mt-3 inline-flex items-center gap-2 text-xs text-amber-300 hover:text-amber-200 bg-amber-500/10 hover:bg-amber-500/15 ring-1 ring-amber-500/30 hover:ring-amber-500/50 rounded-xl px-3 py-2 transition">
                  <Icon name="shield-off" size={14} /> Revoke unused USDC approval
                </button>
              )}
            </div>
          </div>
        </Card>
      ) : (
        <Card className="p-5 mb-5"><Stepper status={order.status} /></Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        {/* LEFT */}
        <div className="lg:col-span-3 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <Card className="p-4">
              <div className="text-xs uppercase tracking-wide text-arc-faint mb-2">{tr('od.orderStatus','Order Status')}</div>
              <span className={`inline-flex items-center gap-2 text-sm font-medium rounded-lg px-3 py-1.5 ${done ? 'bg-emerald-500/15 text-emerald-300' : disputed ? 'bg-rose-500/15 text-rose-300' : 'bg-cyan-500/15 text-cyan-300'}`}>
                <Icon name={(STATUS_META[order.status] || STATUS_META.PENDING).icon} size={14} /> {(STATUS_META[order.status] || STATUS_META.PENDING).label}
              </span>
            </Card>
            <Card className="p-4">
              <div className="text-xs uppercase tracking-wide text-arc-faint mb-2">{tr('od.paymentMethod','Payment Method')}</div>
              <span className="inline-flex items-center gap-2 text-sm font-medium rounded-lg px-3 py-1.5 bg-arc-primary/15 text-arc-accent">
                <Icon name={order.payment === 'Balance' ? 'wallet' : 'zap'} size={14} /> {order.payment === 'Balance' ? tr('od.balance','Balance') : order.payment}
              </span>
            </Card>
          </div>

          {/* product detail */}
          <Card className="p-4">
            <div className="text-xs uppercase tracking-wide text-arc-faint mb-3">{tr('od.productDetail','Product Detail')}</div>
            <div className="flex items-center gap-3.5">
              <div className={`w-16 h-16 rounded-xl bg-gradient-to-br ${p ? p.gradient : 'from-arc-surface2 to-arc-surface'} grid-noise flex items-center justify-center text-3xl shrink-0`}>{p ? p.glyph : '▣'}</div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-arc-text">{order.title}</div>
                <span className="inline-block text-[10px] font-medium text-arc-accent bg-arc-primary/15 ring-1 ring-arc-primary/25 rounded px-1.5 py-0.5 mt-1">{order.variant}</span>
                <div className="text-[11px] text-arc-faint mt-1.5">{tr('orders.qty','Qty')}: {order.qty} × <Usdc value={order.amount} /></div>
                <button onClick={() => onStore(order.seller)} className="text-[11px] text-arc-accent hover:brightness-125 mt-0.5">{tr('orders.seller','Seller')}: {order.seller}</button>
              </div>
            </div>
          </Card>

          {/* payment summary */}
          <Card className="p-4">
            <div className="text-xs uppercase tracking-wide text-arc-faint mb-3">{tr('od.paymentSummary','Payment Summary')}</div>
            <div className="space-y-2.5 text-sm">
              <div className="flex justify-between"><span className="text-arc-muted">{tr('od.subtotal','Subtotal')} ({order.qty} item)</span><Usdc value={order.amount} className="text-arc-text" /></div>
              <div className="flex justify-between"><span className="text-arc-muted">{tr('od.adminFee','Service Fee (2%)')}</span><Usdc value={order.adminFee} className="text-arc-accent" /></div>
              <div className="h-px bg-arc-border"></div>
              <div className="flex justify-between items-center"><span className="font-semibold text-arc-text">{tr('od.totalPaid','Total Paid')}</span><Usdc value={total} className="text-emerald-400 font-bold text-lg" /></div>
            </div>
          </Card>

          {/* On-Chain Verification */}
          {order.onChainTxHash && (
            <Card className="p-4 mb-4">
              <div className="flex items-center gap-2 mb-2">
                <Icon name="shield-check" size={14} className="text-emerald-400" />
                <span className="text-xs font-semibold uppercase tracking-wide text-arc-faint">{tr('od.onchainVerify','On-Chain Verification')}</span>
              </div>
              <div className="space-y-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  {/* the indexer overwrites on_chain_tx_hash with the
                      LATEST settlement tx (release/refund), so calling this the
                      "Creation Tx" was wrong once an order had settled. */}
                  <span className="text-arc-muted">{tr('od.latestTx','Latest on-chain Tx')}</span>
                  <a href={'https://testnet.arcscan.app/tx/' + order.onChainTxHash} target="_blank" rel="noopener noreferrer"
                     className="font-mono text-arc-accent hover:brightness-125 truncate max-w-[180px]">
                    {order.onChainTxHash.slice(0, 10)}…{order.onChainTxHash.slice(-6)}
                  </a>
                </div>
                {order.onChainOrderId && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-arc-muted">{tr('od.contractOrderId','Contract Order ID')}</span>
                    <span className="font-mono text-arc-text">#{order.onChainOrderId}</span>
                  </div>
                )}
                {order.onChainStatus && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-arc-muted">{tr('od.onchainStatus','On-Chain Status')}</span>
                    <span className={`font-mono ${
                      order.onChainStatus === 'RELEASED' ? 'text-emerald-400' :
                      order.onChainStatus === 'REFUNDED' ? 'text-rose-400' :
                      order.onChainStatus === 'release_failed' || order.onChainStatus === 'refund_failed' ? 'text-amber-400' :
                      'text-arc-muted'
                    }`}>{order.onChainStatus}</span>
                  </div>
                )}
                {order.onChainStatus === 'release_pending' || order.onChainStatus === 'refund_pending' ? (
                  <div className="flex items-center gap-1.5 text-amber-300 pt-1">
                    <Icon name="loader" size={12} className="animate-spin" /> Awaiting on-chain confirmation...
                  </div>
                ) : order.onChainStatus === 'release_failed' || order.onChainStatus === 'refund_failed' ? (
                  <div className="flex items-center gap-1.5 text-amber-300 pt-1">
                    <Icon name="alert-triangle" size={12} /> On-chain {order.onChainStatus === 'release_failed' ? 'release' : 'refund'} failed. Auto-retrying...
                  </div>
                ) : order.onChainStatus === 'RELEASED' || order.onChainStatus === 'REFUNDED' ? (
                  <div className="flex items-center gap-1.5 text-emerald-400 pt-1">
                    <Icon name="check-circle" size={12} /> Verified on-chain ✓
                  </div>
                ) : null}
              </div>
            </Card>
          )}

          {/* Invoice — printable nota belanja (browser tab → Ctrl+P → Save as PDF).
              Same renderer/totals as the invoice emailed at payment time, so the
              document the buyer keeps always matches what they saw. */}
          <Card className="p-4 mb-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-arc-primary/10 flex items-center justify-center shrink-0">
                <Icon name="file-text" size={16} className="text-arc-accent" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-arc-text">{tr('od.invoice','Nota Belanja')}</div>
                <div className="text-[11px] text-arc-faint">{tr('od.invoiceHint','Invoice lengkap — bisa disimpan sebagai PDF')}</div>
              </div>
              <a href={(window.SLIME_API || '') + '/api/orders/' + order.id + '/invoice'} target="_blank" rel="noopener noreferrer"
                 className="inline-flex items-center gap-1.5 text-xs text-arc-accent hover:brightness-125 bg-arc-surface2 ring-1 ring-arc-border hover:ring-arc-borderlt rounded-lg px-2.5 py-1.5 transition shrink-0">
                <Icon name="external-link" size={12} /> {tr('od.viewInvoice','Lihat')}
              </a>
            </div>
          </Card>
        </div>

        {/* RIGHT */}
        <div className="lg:col-span-2 space-y-5">
          {isManual && activeFlow && (
            <div className="flex items-start gap-2.5 rounded-2xl ring-1 ring-arc-primary/30 bg-arc-primary/5 px-4 py-3.5">
              <Icon name="info" size={16} className="text-arc-accent mt-0.5 shrink-0" />
              <div className="text-[12px] text-arc-text leading-relaxed" style={{ textWrap: 'pretty' }}>{tr('od.inspectNote','Manual delivery: seller has up to 2×24h to deliver. After delivery you have a 42h inspection window before funds auto-release.')}</div>
            </div>
          )}
          {/* order info / credentials */}
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs uppercase tracking-wide text-arc-faint flex items-center gap-1.5"><Icon name="lock" size={12} className="text-arc-accent" /> {tr('od.orderInfo','Order Info')}</span>
              {credUnlocked && hasCreds && (
                <button onClick={copyAll} className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-arc-text bg-arc-surface2 hover:bg-arc-border rounded-lg px-2 py-1.5 transition">
                  <Icon name={copied ? 'check' : 'copy'} size={12} className={copied ? 'text-emerald-400' : ''} /> {tr('od.copyAll','Copy All')}
                </button>
              )}
            </div>

            {!hasCreds ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center">
                <Icon name="loader" size={22} className="text-amber-400" />
                <div className="text-sm text-arc-text">{tr('od.preparing','Seller is preparing your order')}</div>
                <div className="text-[11px] text-arc-faint">{tr('od.credsAppear','Credentials appear once status is SENT')}</div>
              </div>
            ) : (
              <>
                <div className="relative rounded-xl ring-1 ring-arc-border bg-arc-bg/60 p-3.5 font-mono text-xs space-y-2 overflow-hidden">
                  <div className={(credUnlocked && reveal) ? '' : 'blur-[6px] select-none pointer-events-none'}>
                    {Object.entries(order.credentials || {}).map(([k, v]) => (
                      <div key={k} className="flex gap-2"><span className="text-arc-faint shrink-0">{k}:</span> <span className="text-arc-text break-all">{v}</span></div>
                    ))}
                  </div>
                  {!(credUnlocked && reveal) && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-arc-bg/40">
                      <Icon name={credUnlocked ? 'eye-off' : 'shield-alert'} size={20} className={credUnlocked ? 'text-arc-accent' : 'text-arc-faint'} />
                      {credUnlocked
                        ? <button onClick={() => setReveal(true)} className="text-xs text-arc-accent hover:brightness-125 font-medium">{tr('od.show','Show')} →</button>
                        : <span className="text-[11px] text-arc-faint">{tr('od.lockedUntilSent','Locked until SENT')}</span>}
                    </div>
                  )}
                </div>
                {order.terms && order.terms.length > 0 && (
                  <div className="mt-3">
                    <div className="text-[11px] uppercase tracking-wide text-arc-faint mb-1.5">{tr('od.terms','Terms & Conditions')}</div>
                    <ul className="space-y-1">
                      {order.terms.map((t, i) => (
                        <li key={i} className="text-[12px] text-arc-muted flex gap-1.5 leading-snug"><span className="text-arc-primary mt-0.5">•</span><span style={{ textWrap: 'pretty' }}>{t}</span></li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </Card>

          {/* actions */}
          <Card className="p-4">
            <div className="text-xs uppercase tracking-wide text-arc-faint mb-3">{tr('od.actions','Actions')}</div>

            {(order.status === 'PENDING' || order.status === 'PROCESS') && (
              <div className="space-y-2.5">
                <div className="rounded-xl ring-1 ring-amber-500/25 bg-amber-500/5 px-3.5 py-3 text-center">
                  <div className="text-sm font-medium text-amber-300">{tr('od.waitingSeller','Waiting for seller')}</div>
                  {order.status === 'PENDING'
                    ? <div className="text-[11px] text-arc-muted mt-0.5">{tr('od.cancelIn','Auto-cancel in')} <span className="font-mono text-arc-text">{fmtDur(cancelLeft)}</span></div>
                    : <div className="text-[11px] text-arc-muted mt-0.5">{tr('od.processNote','Seller is processing your order.')}</div>}
                </div>
                <Btn variant="primary" full icon="message-circle" onClick={() => onChat(order)}>{tr('od.chatSeller','Chat Seller')}</Btn>
                {canCancel && (
                  <button onClick={() => onCancel(order)} className="w-full inline-flex items-center justify-center gap-2 text-xs text-arc-muted hover:text-rose-300 bg-arc-surface/60 hover:bg-rose-500/10 ring-1 ring-arc-border hover:ring-rose-500/30 rounded-xl py-2.5 transition">
                    <Icon name="x-circle" size={14} /> {tr('od.cancelOrder','Cancel Order')}
                  </button>
                )}
              </div>
            )}

            {order.status === 'SENT' && (
              <div className="space-y-2.5">
                <div className="rounded-xl ring-1 ring-cyan-500/25 bg-cyan-500/5 px-3.5 py-3">
                  {releaseLeft != null ? (
                    <>
                      <div className="flex items-center gap-1.5 text-[11px] text-cyan-300"><Icon name="timer" size={13} /> {tr('od.autoReleaseIn','Auto-release in')}</div>
                      <div className="text-lg font-mono font-bold text-cyan-200 mt-0.5 tabular-nums">{fmtDur(releaseLeft)}</div>
                    </>
                  ) : (
                    <div className="flex items-center gap-1.5 text-[11px] text-cyan-300"><Icon name="timer" size={13} /> {tr('od.autoReleasePending','Auto-release timer will appear once the server confirms the inspection deadline.')}</div>
                  )}
                  <div className="text-[11px] text-arc-muted mt-1" style={{ textWrap: 'pretty' }}>{tr('od.inspectWindow','Inspect your item. Confirm to release funds now, or appeal if something is wrong.')}</div>
                </div>
                <Btn variant="primary" full icon="message-circle" onClick={() => onChat(order)}>{tr('od.chatSeller','Chat Seller')}</Btn>
                <div className="flex gap-2">
                  <Btn variant="emerald" full icon="check-check" onClick={() => onConfirm(order)}>{tr('od.confirm','Confirm Received')}</Btn>
                  <Btn variant="danger" icon="gavel" onClick={() => onAppeal(order)}>{tr('od.appeal','Appeal')}</Btn>
                </div>
              </div>
            )}
            {done && (
              <div className="mt-2.5 space-y-2.5">
                <div className="flex flex-col items-center gap-1 bg-arc-bg/50 ring-1 ring-arc-border rounded-xl py-4">
                  <Icon name="check-check" size={18} className="text-emerald-400" />
                  <div className="text-sm text-arc-text">{tr('od.complete','Order Complete')}</div>
                </div>
                {order.review
                  ? (
                    <div className="rounded-xl ring-1 ring-amber-500/25 bg-amber-500/5 px-3.5 py-3">
                      <div className="flex items-center gap-2"><Stars value={order.review.rating} size={13} /><span className="text-[11px] text-arc-muted">{tr('od.yourReview','Your Review')}</span></div>
                      {order.review.comment && <div className="text-xs text-arc-text mt-1.5">“{order.review.comment}”</div>}
                    </div>
                  )
                  : <Btn variant="outline" full icon="star" onClick={() => onReview(order)}>{tr('od.giveReview','Give Review')}</Btn>}
              </div>
            )}
            {disputed && (
              <div className="mt-2.5 space-y-2.5">
                <div className="flex items-center justify-center gap-2 bg-rose-500/10 ring-1 ring-rose-500/25 rounded-xl py-3 text-sm text-rose-300">
                  <Icon name="gavel" size={15} /> {tr('od.awaitTribunal','Awaiting Tribunal decision')}
                </div>
                <Btn variant="danger" full icon="gavel" onClick={() => onChat(order)}>{tr('od.openTribunalChat','Open Tribunal Chat')}</Btn>
              </div>
            )}
          </Card>

          {/* seller info */}
          <Card className="p-4">
            <div className="text-xs uppercase tracking-wide text-arc-faint mb-3">{tr('od.sellerInfo','Seller Info')}</div>
            <div className="flex items-center gap-3 w-full group">
              <Avatar gradient={store && !isImgUrl(store.avatar) ? store.avatar : 'from-arc-primary to-arc-accent'} img={store && isImgUrl(store.avatar) ? store.avatar : null} name={order.seller} size={42} />
              <div className="text-left min-w-0">
                <button onClick={() => onStore(order.seller)} className="text-sm font-semibold text-arc-text hover:text-arc-accent transition">{order.seller}</button>
                {store && <div className="mt-0.5"><CopyChip value={store.uid} /></div>}
              </div>
              <button onClick={() => onStore(order.seller)} className="ml-auto text-arc-faint hover:text-arc-text transition"><Icon name="chevron-right" size={16} /></button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { PesananSaya, DetailPesanan, ReasonModal, ReviewModal });

// ---- Review modal (after confirm — optional) ----
function ReviewModal({ open, order, onClose, onSubmit }) {
  const [rating, setRating] = useState(5);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  useEffect(() => { if (open) { setRating(5); setHover(0); setComment(''); } }, [open]);
  if (!open || !order) return null;
  return (
    <Modal open={open} onClose={onClose} width="max-w-md">
      <Card className="overflow-hidden">
        <div className="p-6 text-center border-b border-arc-border">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 ring-1 ring-emerald-500/30 flex items-center justify-center mx-auto mb-3"><Icon name="party-popper" size={22} className="text-emerald-300" /></div>
          <div className="font-semibold text-arc-text text-lg">{tr('ord.thankYou','Thank you for your purchase!')}</div>
          <div className="text-sm text-arc-muted mt-1">{tr('rv.share','Share your experience.')}</div>
        </div>
        <div className="p-5">
          <div className="text-xs uppercase tracking-wide text-arc-faint text-center mb-2">{tr('rv.rating','Rating')}</div>
          <div className="flex items-center justify-center gap-1.5 mb-4">
            {[1, 2, 3, 4, 5].map(n => (
              <button key={n} onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(0)} onClick={() => setRating(n)} className="transition-transform hover:scale-110">
                <Icon name="star" size={32} className={(hover || rating) >= n ? 'fill-amber-400 text-amber-400' : 'fill-arc-border text-arc-border'} stroke={0} />
              </button>
            ))}
          </div>
          <textarea rows={3} value={comment} onChange={e => setComment(e.target.value)} placeholder={tr('rv.commentPh','Write a comment (optional)…')}
            className="w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl px-3.5 py-2.5 text-sm text-arc-text placeholder-arc-faint outline-none resize-none transition"></textarea>
          <div className="flex items-center gap-1.5 mt-2 text-[11px] text-arc-faint"><Icon name="shield" size={12} className="text-emerald-500/70" /> {tr('rv.censorNote','Your name will be censored on the store page')} ({typeof censorName === 'function' ? censorName(ME.name) : ME.name}).</div>
          <div className="flex gap-3 mt-4">
            <Btn variant="ghost" full onClick={onClose}>{tr('rv.skip','Skip')}</Btn>
            <Btn variant="emerald" full icon="send" onClick={() => onSubmit(order, { rating, comment: comment.trim() })}>{tr('c.send','Send')}</Btn>
          </div>
        </div>
      </Card>
    </Modal>
  );
}

// ---- Reusable reason picker modal (cancel / decline) ----
function ReasonModal({ open, kind, reasons, onClose, onConfirm }) {
  const [reason, setReason] = useState('');
  const [other, setOther] = useState('');
  useEffect(() => { if (open) { setReason(''); setOther(''); } }, [open]);
  if (!open) return null;
  const isDecline = kind === 'decline';
  const finalReason = reason === '__other' ? (other.trim() || tr('rsn.other','Other')) : reason;
  return (
    <Modal open={open} onClose={onClose} width="max-w-md">
      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-arc-border">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${isDecline ? 'bg-rose-500/15 text-rose-300' : 'bg-amber-500/15 text-amber-300'}`}>
            <Icon name={isDecline ? 'ban' : 'x-circle'} size={18} />
          </div>
          <div>
            <div className="font-semibold text-arc-text">{isDecline ? tr('rsn.declineTitle','Decline Order') : tr('rsn.cancelTitle','Cancel Order')}</div>
            <div className="text-xs text-arc-muted">{isDecline ? tr('rsn.declineSub','Reason will be sent to the buyer') : tr('rsn.cancelSub','Choose a cancellation reason')}</div>
          </div>
          <button onClick={onClose} className="ml-auto w-8 h-8 rounded-lg hover:bg-arc-surface2 text-arc-muted flex items-center justify-center"><Icon name="x" size={16} /></button>
        </div>
        <div className="p-5 space-y-2.5">
          {(reasons || []).map(r => (
            <button key={r} onClick={() => setReason(r)}
              className={`w-full flex items-center gap-2.5 text-left rounded-xl px-3.5 py-3 text-sm transition ring-1 ${reason === r ? (isDecline ? 'ring-rose-500 bg-rose-500/10 text-rose-200' : 'ring-amber-500 bg-amber-500/10 text-amber-200') : 'ring-arc-border bg-arc-surface/60 text-arc-text hover:ring-arc-borderlt'}`}>
              <span className={`w-4 h-4 rounded-full ring-2 flex items-center justify-center shrink-0 ${reason === r ? (isDecline ? 'ring-rose-400' : 'ring-amber-400') : 'ring-arc-faint'}`}>{reason === r && <span className={`w-2 h-2 rounded-full ${isDecline ? 'bg-rose-400' : 'bg-amber-400'}`}></span>}</span>
              {r}
            </button>
          ))}
          <button onClick={() => setReason('__other')}
            className={`w-full flex items-center gap-2.5 text-left rounded-xl px-3.5 py-3 text-sm transition ring-1 ${reason === '__other' ? 'ring-arc-primary bg-arc-primary/10 text-arc-accent' : 'ring-arc-border bg-arc-surface/60 text-arc-text hover:ring-arc-borderlt'}`}>
            <span className={`w-4 h-4 rounded-full ring-2 flex items-center justify-center shrink-0 ${reason === '__other' ? 'ring-arc-primary' : 'ring-arc-faint'}`}>{reason === '__other' && <span className="w-2 h-2 rounded-full bg-arc-primary"></span>}</span>
            {tr('rsn.other','Other')}…
          </button>
          {reason === '__other' && (
            <input autoFocus value={other} onChange={e => setOther(e.target.value)} placeholder={tr('rsn.writeReason','Write a reason…')}
              className="w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
          )}
          <div className="flex gap-3 pt-2">
            <Btn variant="ghost" full onClick={onClose}>{tr('c.back','Back')}</Btn>
            <Btn variant="danger" full icon={isDecline ? 'ban' : 'x-circle'} disabled={!reason} onClick={() => onConfirm(finalReason)}>{isDecline ? tr('rsn.declineTitle','Decline Order') : tr('rsn.cancelTitle','Cancel Order')}</Btn>
          </div>
        </div>
      </Card>
    </Modal>
  );
}
