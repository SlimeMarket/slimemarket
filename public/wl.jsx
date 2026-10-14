// ============ WL (Whitelist) Marketplace — Escrow-only ============

const WL_GLYPHS = ['⬡', '⬢', '⬣', '◉', '◈', '✶', '✦', '⛩', '🔷', '🪙'];
const WL_GRADIENTS = [
  'from-orange-600 via-amber-700 to-arc-bg',
  'from-blue-700 via-indigo-800 to-arc-bg',
  'from-cyan-600 via-blue-700 to-indigo-900',
  'from-sky-600 via-cyan-700 to-arc-bg',
  'from-emerald-600 via-teal-700 to-arc-bg',
  'from-rose-600 via-pink-700 to-arc-surface',
];
const WL_FEE_RATE = 0.02; // 2% buyer fee (non-refundable, matches contract FEE_BPS=200)

// ---- WL listing card ----
function WLCard({ wl, onOpen }) {
  const tm = wlTypeMeta(wl.type);
  return (
    <div onClick={() => onOpen(wl)} className="group relative bg-arc-surface/60 ring-1 ring-arc-border hover:ring-arc-primary/50 rounded-2xl overflow-hidden transition-all duration-200 hover:-translate-y-1 hover:shadow-glow flex flex-col cursor-pointer">
      <div className={`relative h-32 bg-gradient-to-br ${wl.gradient} grid-noise overflow-hidden bg-cover bg-center`} style={wl.img ? { backgroundImage: `url(${wl.img})` } : {}}>
        {!wl.img && <div className="absolute inset-0 flex items-center justify-center text-white/90 text-5xl blob-float select-none">{wl.glyph}</div>}
        <div className="absolute top-2.5 left-2.5 flex gap-1.5 flex-wrap">
          {/* A1 — direction badge. WTB means the creator is buying, so the
              visitor is the one who would sell to them. */}
          {wl.side === 'WTB' && <PixBadge color="cyan">{tr('wl.wanted','WANTED')}</PixBadge>}
          {wl.collateral && <PixBadge color="amber">{tr('wl.collateralBadge','COLLATERAL')}</PixBadge>}
          {wl.offer && <PixBadge color="blue">{tr('wl.offerOk','OFFER OK')}</PixBadge>}
        </div>
        <div className="absolute bottom-2.5 left-2.5">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-white bg-arc-bg/50 ring-1 ring-white/15 rounded-md px-2 py-1 backdrop-blur-sm"><Icon name={tm.icon} size={11} /> {tm.label}</span>
        </div>
      </div>
      <div className="p-3.5 flex flex-col gap-2 flex-1">
        <div className="flex items-center gap-2 text-[11px] text-arc-muted">
          <Avatar gradient={wl.sellerAvatar} name={wl.seller} size={18} />
          <span className="truncate">{wl.seller}</span>
          <PixBadge color={(DISC_ROLE_META[wl.sellerRole] || {}).color || 'slate'} className="ml-auto">{(wl.sellerRole || 'Member').toUpperCase()}</PixBadge>
        </div>
        <h3 className="font-semibold text-[15px] leading-snug text-arc-text">{wl.project}</h3>
        <div className="flex flex-wrap gap-1.5">
          <span className="text-[10px] font-medium text-arc-accent bg-arc-primary/15 ring-1 ring-arc-primary/30 rounded px-1.5 py-0.5">{wl.wlType}</span>
          {wl.mintPrice > 0 && <span className="text-[10px] font-medium text-arc-muted bg-arc-surface2 ring-1 ring-arc-border rounded px-1.5 py-0.5">Mint {wl.mintPrice} USDC</span>}
        </div>
        <div className="flex items-end justify-between mt-auto pt-1">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-arc-faint">{tr('wl.pricePerSpot','Price / spot')} · {tr('wl.left','left')} {wl.qty}</div>
            <Usdc value={wl.unitPrice} className="text-emerald-400 font-bold text-lg" />
          </div>
          <Btn size="sm" icon="shield-check">{tr('wl.deal','Deal')}</Btn>
        </div>
      </div>
    </div>
  );
}

// ---- WL detail / buy + offer modal ----
function WLDetailModal({ wl, saldo, onClose, onDeal }) {
  const [mode, setMode] = useState('buy');     // buy | offer
  const [offerPrice, setOfferPrice] = useState('');
  const [qty, setQty] = useState(1);
  useEffect(() => { if (wl) { setMode('buy'); setOfferPrice(''); setQty(1); } }, [wl]);
  if (!wl) return null;
  const tm = wlTypeMeta(wl.type);
  const maxQty = Math.max(1, wl.qty || 1);
  const unit = mode === 'offer' ? (parseFloat(offerPrice) || 0) : wl.unitPrice;
  const price = +(unit * qty).toFixed(2);
  const fee = +(price * WL_FEE_RATE).toFixed(2);
  const total = +(price + fee).toFixed(2);
  const enough = saldo >= total;
  // Price is whatever the seller/buyer agrees — the server accepts any positive
  // amount (z.number().positive()). This used to be `unit >= 1`, which silently
  // disabled the buy button for any listing under 1 USDC even though the API
  // would happily take it.
  const valid = unit > 0;

  return (
    <Modal open={!!wl} onClose={onClose} width="max-w-md">
      <Card className="overflow-hidden">
        <div className={`relative h-24 bg-gradient-to-br ${wl.gradient} grid-noise bg-cover bg-center`} style={wl.img ? { backgroundImage: `url(${wl.img})` } : {}}>
          <button onClick={onClose} className="absolute top-3 right-3 w-8 h-8 rounded-lg bg-arc-bg/40 hover:bg-arc-bg/70 text-white flex items-center justify-center transition"><Icon name="x" size={16} /></button>
          <div className="absolute bottom-3 left-4 flex items-center gap-3">
            {!wl.img && <div className="text-4xl">{wl.glyph}</div>}
            <div>
              <Pixel className="text-white/80 text-[8px]">{tr('wl.escrowDealBadge','WL ESCROW DEAL')}</Pixel>
              <div className="font-semibold text-white text-sm leading-tight mt-1">{wl.project}</div>
            </div>
          </div>
        </div>

        <div className="p-5 space-y-4 max-h-[68vh] overflow-y-auto">
          {/* meta */}
          <div className="flex flex-wrap gap-1.5">
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-arc-accent bg-arc-primary/15 ring-1 ring-arc-primary/30 rounded-md px-2 py-1">{wl.wlType}</span>
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-arc-muted bg-arc-surface2 ring-1 ring-arc-border rounded-md px-2 py-1"><Icon name={tm.icon} size={11} /> {tm.label}</span>
            {wl.collateral && <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-300 bg-amber-500/10 ring-1 ring-amber-500/25 rounded-md px-2 py-1"><Icon name="lock" size={11} /> {tr('wl.collateral','Collateral')}</span>}
          </div>
          <p className="text-sm text-arc-muted leading-relaxed" style={{ textWrap: 'pretty' }}>{wl.desc}</p>
          <div className="flex items-center gap-2 text-sm">
            <Icon name="link" size={14} className="text-arc-accent" />
            <a href={wl.projectLink} target="_blank" rel="noopener noreferrer" className="text-arc-accent hover:brightness-125 truncate">{wl.projectLink}</a>
          </div>
          <div className="flex items-center gap-2.5 bg-arc-bg/50 ring-1 ring-arc-border rounded-xl p-3">
            <Avatar gradient={wl.sellerAvatar} name={wl.seller} size={32} />
            <div className="text-sm"><span className="text-arc-text font-medium">{wl.seller}</span> <span className="text-arc-faint">· {tr('wl.left','left')} {wl.qty} {tr('wl.spots','spots')}</span></div>
          </div>

          {/* buy / offer toggle */}
          {wl.offer && (
            <div className="flex rounded-xl overflow-hidden ring-1 ring-arc-borderlt">
              {[['buy', tr('wl.fixedPrice','Fixed Price'), wl.unitPrice + ''], ['offer', tr('wl.makeOffer','Make Offer'), 'nego']].map(([id, lbl, sub]) => (
                <button key={id} onClick={() => setMode(id)} className={`flex-1 py-2.5 text-sm font-medium transition ${mode === id ? 'bg-arc-primary text-white' : 'bg-arc-surface/60 text-arc-muted hover:text-arc-text'}`}>{lbl}</button>
              ))}
            </div>
          )}
          {mode === 'offer' && (
            <div>
              <label className="text-xs uppercase tracking-wide text-arc-faint">{tr('wl.offerPricePerSpot','Offer price / spot (USDC)')}</label>
              <input value={offerPrice} onChange={e => setOfferPrice(e.target.value.replace(/[^0-9.]/g, ''))} placeholder={'Listing ' + wl.unitPrice} className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none font-mono transition" />
              <div className="text-[11px] text-arc-faint mt-1.5">{tr('wl.offerToDm','Offer is sent to the seller DM.')} <span className="text-arc-muted">{tr('wl.fundsNotHeld','Funds are not held')}</span> {tr('wl.untilAccept','until the seller accepts & proceeds.')}</div>
            </div>
          )}

          {/* quantity stepper */}
          <div className="flex items-center justify-between bg-arc-bg/50 ring-1 ring-arc-border rounded-xl px-3.5 py-3">
            <div>
              <div className="text-sm text-arc-text font-medium">{tr('wl.numSpots','Number of Spots')}</div>
              <div className="text-[11px] text-arc-faint">{tr('wl.stockLeft','Stock left:')} <span className="text-emerald-400 font-medium">{maxQty}</span></div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setQty(q => Math.max(1, q - 1))} className="w-9 h-9 rounded-lg bg-arc-surface2 hover:bg-arc-border text-arc-text flex items-center justify-center transition disabled:opacity-40" disabled={qty <= 1}><Icon name="minus" size={16} /></button>
              <input value={qty} onChange={e => { const v = parseInt(e.target.value.replace(/[^0-9]/g, '')) || 1; setQty(Math.min(maxQty, Math.max(1, v))); }} className="w-12 h-9 text-center bg-arc-bg/60 ring-1 ring-arc-borderlt rounded-lg text-sm text-arc-text font-mono outline-none" />
              <button onClick={() => setQty(q => Math.min(maxQty, q + 1))} className="w-9 h-9 rounded-lg bg-arc-surface2 hover:bg-arc-border text-arc-text flex items-center justify-center transition disabled:opacity-40" disabled={qty >= maxQty}><Icon name="plus" size={16} /></button>
            </div>
          </div>

          {/* breakdown */}
          <div className="bg-arc-bg/50 ring-1 ring-arc-border rounded-xl p-4 space-y-2.5">
            <div className="flex justify-between text-sm"><span className="text-arc-muted">{mode === 'offer' ? tr('wl.offerPrice','Offer Price') : tr('wl.price','Price')} × {qty}</span><Usdc value={price} className="text-arc-text" /></div>
            <div className="flex justify-between text-sm"><span className="text-arc-muted">{tr('wl.fee','Fee (2%)')}</span><Usdc value={fee} className="text-arc-text" /></div>
            <div className="h-px bg-arc-border my-1"></div>
            <div className="flex justify-between items-center"><span className="text-sm font-semibold text-arc-text">{tr('wl.subtotal','Subtotal')}</span><Usdc value={total} className="text-emerald-400 font-bold text-lg" /></div>
            {wl.collateral && (
              <div className="flex justify-between text-xs pt-1"><span className="text-amber-300/90 inline-flex items-center gap-1"><Icon name="lock" size={11} /> {tr('wl.needCollateral','Seller collateral required')}</span><span className="text-amber-300">{tr('wl.setOnProceed','set on proceed')}</span></div>
            )}
          </div>

          <div className="rounded-xl ring-1 ring-arc-primary/25 bg-arc-primary/5 px-3.5 py-3 text-[11px] text-arc-muted leading-relaxed">
            <Icon name="shield-check" size={13} className="text-arc-accent inline mr-1" />
            Your funds are <span className="font-medium text-arc-text">not held</span> yet. Once the seller accepts &amp; sets the collateral amount then <span className="font-medium">{tr('wl.proceeds','Proceeds')}</span>, the buyer funds &amp; seller collateral enter the escrow System. {wl.collateral ? 'Seller collateral is required for this type.' : ''}
          </div>

          <Btn variant={mode === 'offer' ? 'primary' : 'emerald'} size="lg" full icon={mode === 'offer' ? 'gavel' : 'send'} disabled={!valid}
            onClick={() => onDeal({ wl, unit, qty, price, isOffer: mode === 'offer', total, needsCollateral: !!wl.collateral })}>
            {mode === 'offer' ? tr('wl.sendOffer','Send Offer to Seller') : tr('wl.sendOrder','Send Order to Seller')}
          </Btn>
          <div className="flex items-center justify-between text-[11px] text-arc-faint">
            <span>{tr('wl.yourBalance','Your balance')} {enough ? '' : tr('wl.insufficientTotal','(insufficient for this total)')}</span><Usdc value={saldo} className={enough ? 'text-arc-muted' : 'text-rose-400'} />
          </div>
          {/* Dead-end fix: an insufficient balance used to be a full stop — the
              button was disabled with no way forward. Most OTC buyers hold USDC
              on another chain, and the wallet page can bridge it onto Arc, so
              point at that instead of leaving them stuck. */}
          {!enough && (
            <div className="flex items-start gap-1.5 text-[11px] text-amber-300/90 leading-relaxed">
              <Icon name="arrow-left-right" size={12} className="mt-0.5 shrink-0" />
              <span>
                {tr('wl.bridgeHint','Holding USDC on another chain? Bridge it to Arc in')}{' '}
                <button
                  type="button"
                  onClick={() => window.SlimeRouter?.pushPath?.('balance')}
                  className="text-arc-accent underline underline-offset-2 hover:brightness-125"
                >{tr('wl.walletLink','your wallet')}</button>
                {tr('wl.bridgeHintEnd',' — then come back and send the order.')}
              </span>
            </div>
          )}
        </div>
      </Card>
    </Modal>
  );
}

// ---- WL listing form (anyone can list) ----
function WLListingModal({ open, role, onClose, onList, notify }) {
  const [project, setProject] = useState('');
  const [side, setSide] = useState('WTS');
  const [wlType, setWlType] = useState('');
  const [type, setType] = useState('mint');
  const [unitPrice, setUnitPrice] = useState('');
  const [mintPrice, setMintPrice] = useState('');
  const [qty, setQty] = useState('1');
  const [link, setLink] = useState('');
  const [offer, setOffer] = useState(true);
  const [img, setImg] = useState(null);
  const [glyph, setGlyph] = useState(WL_GLYPHS[0]);
  const [gradient, setGradient] = useState(WL_GRADIENTS[0]);
  const [desc, setDesc] = useState('');
  useEffect(() => { if (open) { setProject(''); setSide('WTS'); setWlType(''); setType('mint'); setUnitPrice(''); setMintPrice(''); setQty('1'); setLink(''); setOffer(true); setImg(null); setGlyph(WL_GLYPHS[0]); setGradient(WL_GRADIENTS[0]); setDesc(''); } }, [open]);

  const tm = wlTypeMeta(type);
  const needsCollateral = tm.collateral;
  const isWtb = side === 'WTB';
  // Same rule on create: any positive unit price is allowed (no 1 USDC floor).
  const valid = project.trim() && wlType.trim() && parseFloat(unitPrice) > 0 && parseInt(qty) >= 1;
  const submit = () => onList({
    id: 'wl' + Date.now(), project: project.trim(), wlType: wlType.trim(), type,
    side,
    unitPrice: parseFloat(unitPrice), mintPrice: parseFloat(mintPrice) || 0, qty: parseInt(qty) || 1,
    glyph, gradient, img, seller: ME.name, sellerRole: role, sellerAvatar: ME.avatar,
    projectLink: link.trim() || '#', offer, collateral: needsCollateral, desc: desc.trim() || (wlType + ' — ' + tm.label),
  });

  return (
    <Modal open={open} onClose={onClose} width="max-w-lg">
      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-arc-border">
          <div className="w-10 h-10 rounded-xl bg-arc-primary/15 ring-1 ring-arc-primary/30 flex items-center justify-center text-arc-accent"><Icon name="gem" size={18} /></div>
          <div>
            <div className="font-semibold text-arc-text">{isWtb ? tr('wl.wantToBuy','Post a Buy Request') : tr('wl.sellSpot','Sell WL Spot')}</div>
            <div className="text-xs text-arc-muted">{isWtb ? tr('wl.wtbSub','Tell the market what you are looking for — escrow required') : tr('wl.anyoneSell','Any member can sell WL — escrow required')}</div>
          </div>
          <button onClick={onClose} className="ml-auto w-8 h-8 rounded-lg hover:bg-arc-surface2 text-arc-muted flex items-center justify-center"><Icon name="x" size={16} /></button>
        </div>
        <div className="p-5 space-y-4 max-h-[72vh] overflow-y-auto">
          {/* A1 — direction. Same form, opposite meaning: on WTS the creator
              sells and visitors buy; on WTB the creator buys and visitors sell. */}
          <div>
            <label className="text-sm text-arc-muted mb-2 block">{tr('wl.iWantTo','I want to')}</label>
            <div className="grid grid-cols-2 gap-2">
              {[['WTS', tr('wl.sell','Sell')], ['WTB', tr('wl.buy','Buy')]].map(([val, label]) => (
                <button key={val} type="button" onClick={() => setSide(val)}
                  className={`h-11 rounded-xl text-sm font-medium ring-1 transition ${side === val ? (val === 'WTB' ? 'bg-cyan-500/15 ring-cyan-500/40 text-cyan-200' : 'bg-emerald-500/15 ring-emerald-500/40 text-emerald-200') : 'bg-arc-bg/60 ring-arc-border text-arc-muted hover:text-arc-text'}`}>
                  {label}
                </button>
              ))}
            </div>
            <div className="text-[11px] text-arc-faint mt-1.5 leading-relaxed">
              {isWtb
                ? tr('wl.wtbHint','You are the BUYER. Whoever accepts your request becomes the seller and delivers to you.')
                : tr('wl.wtsHint','You are the SELLER. Whoever buys from you becomes the buyer and pays into escrow.')}
            </div>
          </div>
          {/* image */}
          <div>
            <label className="text-sm text-arc-muted mb-2 block">{tr('wl.projectImage','Project Image')}</label>
            <ImageUpload value={img} onChange={setImg} height={120} gradient={gradient} glyph={glyph} recommend="1200×400px (3:1), max 2MB" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-arc-muted">{tr('wl.projectName','Project Name')}</label>
              <input value={project} onChange={e => setProject(e.target.value)} placeholder={tr('wl.projectNamePh','e.g. Azuki — Elementals')} className={wlInput} />
            </div>
            <div>
              <label className="text-sm text-arc-muted">{tr('wl.wlType','WL Type')}</label>
              <input value={wlType} onChange={e => setWlType(e.target.value)} placeholder="GTD / FCFS / OG Role…" className={wlInput} />
            </div>
          </div>

          {/* type selector */}
          <div>
            <label className="text-sm text-arc-muted">{tr('wl.deliveryType','Delivery Type')}</label>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {WL_TYPES.map(t => (
                <button key={t.id} onClick={() => setType(t.id)}
                  className={`flex items-start gap-2.5 rounded-xl p-3 text-left transition ring-1 ${type === t.id ? 'ring-2 ring-arc-primary bg-arc-primary/5' : 'ring-arc-border bg-arc-surface/60 hover:ring-arc-borderlt'}`}>
                  <Icon name={t.icon} size={16} className={`mt-0.5 shrink-0 ${type === t.id ? 'text-arc-accent' : 'text-arc-muted'}`} />
                  <div>
                    <div className="text-sm font-medium text-arc-text flex items-center gap-1.5">{t.label} {t.collateral && <Icon name="lock" size={11} className="text-amber-400" />}</div>
                    <div className="text-[11px] text-arc-faint leading-snug">{t.desc}</div>
                  </div>
                </button>
              ))}
            </div>
            <div className={`mt-2 flex items-start gap-1.5 text-[11px] ${needsCollateral ? 'text-amber-300/90' : 'text-emerald-300/80'}`}>
              <Icon name={needsCollateral ? 'shield-alert' : 'shield-check'} size={12} className="mt-0.5 shrink-0" />
              {needsCollateral
                ? tr('wl.collateralReq','This type REQUIRES collateral — the seller balance is held (= Mint Price / deal price) until the transaction is complete.')
                : tr('wl.collateralNone','This type needs no collateral (Wallet Submit / Discord Surrender).')}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="text-sm text-arc-muted">{tr('wl.unitPrice','Unit Price')}</label>
              <input value={unitPrice} onChange={e => setUnitPrice(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="USDC" className={wlInput + ' font-mono'} />
            </div>
            <div>
              <label className="text-sm text-arc-muted">{tr('wl.mintPrice','Mint Price')}</label>
              <input value={mintPrice} onChange={e => setMintPrice(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0" className={wlInput + ' font-mono'} disabled={!needsCollateral} />
            </div>
            <div>
              <label className="text-sm text-arc-muted">{tr('wl.numSpots','Number of Spots')}</label>
              <input value={qty} onChange={e => setQty(e.target.value.replace(/[^0-9]/g, ''))} placeholder="1" className={wlInput + ' font-mono'} />
            </div>
          </div>

          <div>
            <label className="text-sm text-arc-muted">{tr('wl.projectLink','Project Link')}</label>
            <input value={link} onChange={e => setLink(e.target.value)} placeholder="https://…" className={wlInput} />
          </div>

          <div>
            <label className="text-sm text-arc-muted">{tr('wl.descOptional','Description (optional)')}</label>
            <textarea rows={2} value={desc} onChange={e => setDesc(e.target.value)} placeholder={tr('wl.descPh','Spot details, terms, etc…')} className={wlInput.replace('h-11', '') + ' py-2.5 resize-none'}></textarea>
          </div>

          {/* offer toggle */}
          <button onClick={() => setOffer(o => !o)} className={`w-full flex items-center gap-3 rounded-xl p-3.5 ring-1 transition ${offer ? 'ring-arc-primary/40 bg-arc-primary/5' : 'ring-arc-border bg-arc-surface/40'}`}>
            <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${offer ? 'bg-arc-primary/15 text-arc-accent' : 'bg-arc-surface2 text-arc-muted'}`}><Icon name="gavel" size={17} /></div>
            <div className="flex-1 text-left">
              <div className="text-sm font-medium text-arc-text">{tr('wl.offerOption','Offer Option')}</div>
              <div className="text-[11px] text-arc-faint">{tr('wl.allowOffer','Allow buyers to negotiate via DM')}</div>
            </div>
            <span className={`w-11 h-6 rounded-full p-0.5 transition shrink-0 ${offer ? 'bg-arc-primary' : 'bg-arc-surface2'}`}><span className={`block w-5 h-5 rounded-full bg-white transition-transform ${offer ? 'translate-x-5' : ''}`}></span></span>
          </button>

          <div className="flex gap-3 pt-1">
            <Btn variant="ghost" full onClick={onClose}>{tr('c.cancel','Cancel')}</Btn>
            <Btn variant="primary" full icon="check" disabled={!valid} onClick={submit}>{tr('wl.publish','Publish WL')}</Btn>
          </div>
        </div>
      </Card>
    </Modal>
  );
}
const wlInput = 'mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none transition';

Object.assign(window, { WLCard, WLDetailModal, WLListingModal, WL_FEE_RATE, WL_GLYPHS, WL_GRADIENTS });
