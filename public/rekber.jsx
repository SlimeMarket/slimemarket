// ============ View: Rekber (Escrow Panel + Create Escrow form) ============

const REKBER_META = {
  WAITING: { tone: 'amber', icon: 'loader', label: 'Waiting' },
  APPROVED: { tone: 'cyan', icon: 'check', label: 'Approved' },
  SENT: { tone: 'blue', icon: 'send', label: 'Sent' },
  COMPLETED: { tone: 'emerald', icon: 'check-check', label: 'Completed' },
  CANCELLED: { tone: 'rose', icon: 'x', label: 'Cancelled' },
};
const REKBER_FEE_RATE = 0.02; // 2% buyer fee (non-refundable, matches contract FEE_BPS=200)

function RekberStat({ label, value, tone, active, onClick }) {
  const map = {
    slate: ['ring-arc-border bg-arc-surface/60', 'text-arc-text'],
    amber: ['ring-amber-500/30 bg-amber-500/5', 'text-amber-300'],
    cyan: ['ring-cyan-500/30 bg-cyan-500/5', 'text-cyan-300'],
    blue: ['ring-arc-primary/30 bg-arc-primary/5', 'text-arc-accent'],
    emerald: ['ring-emerald-500/30 bg-emerald-500/5', 'text-emerald-300'],
    rose: ['ring-rose-500/30 bg-rose-500/5', 'text-rose-300'],
  };
  const [ring, txt] = map[tone];
  return (
    <button onClick={onClick} className={`text-left rounded-2xl ring-1 px-3.5 py-3 transition ${ring} ${active ? 'ring-2' : 'hover:ring-arc-borderlt'}`}>
      <div className="text-[10px] uppercase tracking-wide text-arc-muted">{label}</div>
      <div className={`text-2xl font-bold mt-0.5 tabular-nums ${txt}`}>{value}</div>
    </button>
  );
}

function RekberForm({ saldo, onClose, onCreate, notify }) {
  const [uid, setUid] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [pay, setPay] = useState('Balance');
  const [collateral, setCollateral] = useState(false);
  const [colAmt, setColAmt] = useState('');

  const harga = parseFloat(price) || 0;
  const col = collateral ? (parseFloat(colAmt) || 0) : 0;
  const fee = +(harga * REKBER_FEE_RATE).toFixed(2);
  const total = Math.max(0, harga + fee + col);
  // Price is whatever the two parties agree on — no 1 USDC floor (mirrors the WL
  // market + the server, which accept any positive amount).
  const valid = uid.trim() && name.trim() && harga > 0 && (!collateral || col > 0);
  const enough = pay === 'Manual' || saldo >= total;

  return (
    <div className="anim-fade border-t border-emerald-500/20 mt-4 pt-5 space-y-5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <Field label={tr('rk.sellerUid','Seller UID')} hint={tr('rk.uidHint','UID can be found on the seller profile')}>
          <input value={uid} onChange={e => setUid(e.target.value)} placeholder={tr('rk.uidPh','Enter seller UID…')} className={inputCls} />
        </Field>
        <Field label={tr('rk.itemName','Product/Service Name')}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder={tr('rk.itemPh','e.g. Logo Design Service…')} className={inputCls} />
        </Field>
        <Field label={tr('rk.price','Price (USDC)')}>
          <input value={price} onChange={e => setPrice(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" className={inputCls + ' font-mono'} />
        </Field>
        <Field label={tr('rk.note','Note (Optional)')}>
          <input value={note} onChange={e => setNote(e.target.value)} placeholder={tr('rk.notePh','Additional note…')} className={inputCls} />
        </Field>
      </div>

      <div>
        <div className="text-sm text-arc-muted mb-2">{tr('rk.paymentMethod','Payment Method')}</div>
        <div className="grid grid-cols-2 gap-3">
          {[['Balance', 'wallet', tr('rk.paySaldo','Deducted directly from balance'), tr('rk.balance','Balance')], ['Manual', 'building-2', tr('rk.payManual','Transfer to admin account'), 'Manual']].map(([id, ic, sub, lbl]) => (
            <button key={id} onClick={() => setPay(id)}
              className={`flex items-start gap-3 rounded-xl p-3.5 text-left transition ring-1 ${pay === id ? 'ring-2 ring-emerald-500 bg-emerald-500/5' : 'ring-arc-border bg-arc-surface/60 hover:ring-arc-borderlt'}`}>
              <Icon name={ic} size={18} className={pay === id ? 'text-emerald-400 mt-0.5' : 'text-arc-muted mt-0.5'} />
              <div>
                <div className="text-sm font-medium text-arc-text">{lbl}</div>
                <div className="text-[11px] text-arc-faint">{sub}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* collateral mode */}
      <div className={`rounded-xl ring-1 transition ${collateral ? 'ring-amber-500/40 bg-amber-500/5' : 'ring-arc-border bg-arc-surface/40'}`}>
        <button onClick={() => setCollateral(c => !c)} className="w-full flex items-center gap-3 p-3.5 text-left">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${collateral ? 'bg-amber-500/15 text-amber-300' : 'bg-arc-surface2 text-arc-muted'}`}><Icon name="lock" size={17} /></div>
          <div className="flex-1">
            <div className="text-sm font-medium text-arc-text">{tr('rk.collateralMode','Collateral Mode')}</div>
            <div className="text-[11px] text-arc-faint">{tr('rk.collateralSub','Require collateral for risky transactions (accounts, wallet surrender, services)')}</div>
          </div>
          <span className={`w-11 h-6 rounded-full p-0.5 transition shrink-0 ${collateral ? 'bg-amber-500' : 'bg-arc-surface2'}`}>
            <span className={`block w-5 h-5 rounded-full bg-white transition-transform ${collateral ? 'translate-x-5' : ''}`}></span>
          </span>
        </button>
        {collateral && (
          <div className="px-3.5 pb-3.5 anim-fade">
            <Field label={tr('rk.collateralValue','Collateral Value (USDC)')} hint={tr('rk.collateralHint','Held by smart-contract & returned on successful transaction')}>
              <input value={colAmt} onChange={e => setColAmt(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" className={inputCls + ' font-mono'} />
            </Field>
            <div className="flex items-center gap-1.5 mt-2 text-[11px] text-amber-300/80"><Icon name="shield-alert" size={12} /> {tr('rk.collateralWarn','If the other party defaults, the collateral is executed by the Tribunal.')}</div>
          </div>
        )}
      </div>

      {/* summary */}
      <div className="rounded-xl ring-1 ring-emerald-500/25 bg-emerald-500/5 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="space-y-1 text-sm flex-1">
          <div className="flex gap-3"><span className="text-arc-muted w-28">{tr('rk.priceLabel','Price')}</span><Usdc value={harga} className="text-arc-text" /></div>
          <div className="flex gap-3"><span className="text-arc-muted w-28">{tr('rk.fee','Fee (2%)')}</span><Usdc value={fee} className="text-arc-text" /></div>
          {collateral && col > 0 && <div className="flex gap-3"><span className="text-amber-300/90 w-28">{tr('rk.collateral','Collateral')}</span><Usdc value={col} className="text-amber-300" /></div>}
          <div className="flex gap-3 pt-1"><span className="text-arc-text font-semibold w-28">{tr('rk.totalLabel','Total')}</span><Usdc value={total} className="text-emerald-400 font-bold text-lg" /></div>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-arc-faint">{tr('rk.available','Available')}</div>
          <Usdc value={saldo} className={`text-sm font-semibold ${enough ? 'text-arc-muted' : 'text-rose-400'}`} />
          <Btn variant="emerald" icon="shield-check" className="mt-2" disabled={!valid || !enough}
            onClick={() => onCreate({ uid, name, harga, note, pay, total, collateral, col })}>{tr('rk.create','Create Escrow')}</Btn>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <div>
      <div className="text-sm text-arc-muted mb-2">{label}</div>
      {children}
      {hint && <div className="text-[11px] text-arc-faint mt-1.5">{hint}</div>}
    </div>
  );
}
const inputCls = 'w-full bg-arc-surface/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none transition';

function RekberPanel({ txs, saldo, onCreate, onStartShop, notify }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');

  const counts = { all: txs.length };
  REKBER_STAGES.forEach(s => counts[s] = txs.filter(t => t.status === s).length);
  const list = txs.filter(t => (filter === 'all' || t.status === filter) && (t.id.toLowerCase().includes(q.toLowerCase()) || t.product.toLowerCase().includes(q.toLowerCase())));

  return (
    <div className="anim-view">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <h1 className="text-xl font-bold text-white">{tr('rk.title','Escrow Transactions')}</h1>
          <PixBadge color="emerald">P2P ESCROW</PixBadge>
        </div>
        <span className="inline-flex items-center gap-1.5 text-sm text-emerald-300"><Icon name="shield-check" size={15} /> {tr('rk.securedSub','Transactions with a security guarantee')}</span>
      </div>

      {/* stats */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
        <RekberStat label={tr('rk.total','Total')} value={counts.all} tone="slate" active={filter === 'all'} onClick={() => setFilter('all')} />
        <RekberStat label={tr('rk.waiting','Waiting')} value={counts.WAITING} tone="amber" active={filter === 'WAITING'} onClick={() => setFilter('WAITING')} />
        <RekberStat label={tr('rk.approved','Approved')} value={counts.APPROVED} tone="cyan" active={filter === 'APPROVED'} onClick={() => setFilter('APPROVED')} />
        <RekberStat label={tr('rk.sent','Sent')} value={counts.SENT} tone="blue" active={filter === 'SENT'} onClick={() => setFilter('SENT')} />
        <RekberStat label={tr('ord.completed','Completed')} value={counts.COMPLETED} tone="emerald" active={filter === 'COMPLETED'} onClick={() => setFilter('COMPLETED')} />
        <RekberStat label={tr('rk.cancelled','Cancelled')} value={counts.CANCELLED} tone="rose" active={filter === 'CANCELLED'} onClick={() => setFilter('CANCELLED')} />
      </div>

      {/* create escrow */}
      <div className="rounded-2xl ring-1 ring-emerald-500/25 bg-gradient-to-br from-emerald-600/10 via-arc-surface to-arc-surface p-4 mb-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/15 ring-1 ring-emerald-500/30 flex items-center justify-center text-emerald-300 shrink-0"><Icon name="plus" size={20} /></div>
          <div className="flex-1">
            <div className="font-semibold text-arc-text">{tr('rk.createNew','Create New Escrow')}</div>
            <div className="text-xs text-arc-muted">{tr('rk.createSub','Safe transactions with escrow protection')}</div>
          </div>
          <Btn variant="emerald" iconRight={open ? 'chevron-up' : 'chevron-down'} onClick={() => setOpen(o => !o)}>{open ? tr('c.close','Close') : tr('rk.create','Create Escrow')}</Btn>
        </div>
        {open && <RekberForm saldo={saldo} onClose={() => setOpen(false)} notify={notify} onCreate={(d) => { onCreate(d); setOpen(false); }} />}
      </div>

      {/* search */}
      <div className="flex gap-2 mb-5">
        <div className="relative flex-1">
          <Icon name="search" size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-arc-faint" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={tr('rk.searchPh','Search order number…')}
            className="w-full bg-arc-surface/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl pl-10 pr-3 h-11 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
        </div>
        <Btn size="lg">{tr('c.search','Search')}</Btn>
      </div>

      {/* list / empty */}
      {list.length === 0 ? (
        <Card className="py-16 flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 ring-1 ring-emerald-500/25 flex items-center justify-center"><Icon name="shield-check" size={26} className="text-emerald-400" /></div>
          <div className="text-sm text-arc-muted">{tr('rk.empty','No escrow transactions yet')}{filter !== 'all' ? tr('rk.forFilter',' for this filter') : ''}</div>
          <Btn variant="emerald" icon="shopping-bag" onClick={onStartShop}>{tr('rk.startShop','Start Shopping with Escrow')}</Btn>
        </Card>
      ) : (
        <div className="space-y-3">
          {list.map(t => {
            const m = REKBER_META[t.status];
            return (
              <Card key={t.id} className="p-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-mono text-xs text-arc-muted">{t.id}</span>
                  <PixBadge color={m.tone}>{m.label}</PixBadge>
                  {t.collateral > 0 && <PixBadge color="amber">COLLATERAL</PixBadge>}
                  <span className="ml-auto text-xs text-arc-faint">{t.date}</span>
                </div>
                <div className="flex items-center gap-3 mt-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/10 ring-1 ring-emerald-500/25 flex items-center justify-center text-emerald-300 shrink-0"><Icon name="handshake" size={18} /></div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-arc-text truncate">{t.product}</div>
                    <div className="text-[11px] text-arc-faint">{tr('c.seller','Seller')}: {t.seller} · {tr('rk.pay','Pay')}: {t.payment}{t.note ? ' · ' + t.note : ''}</div>
                  </div>
                  <Usdc value={t.amount} className="text-emerald-400 font-bold shrink-0" />
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { RekberPanel });
