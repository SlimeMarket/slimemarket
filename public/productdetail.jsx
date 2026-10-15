// ============ Views: Product Detail + Seller Store ============

// Fade-in for loaded content (paired with skeleton placeholders).
(function () {
  if (document.getElementById('pd-anim')) return;
  const s = document.createElement('style');
  s.id = 'pd-anim';
  s.textContent =
    '@keyframes pdFadeIn { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }' +
    '.pd-fade-in { animation: pdFadeIn .32s cubic-bezier(.2,.8,.2,1) both; }';
  document.head.appendChild(s);
})();

// promo-style product art (evokes seller-made banner, original)
function ProductArt({ product, big }) {
  const seller = product.seller || {};
  return (
    <div className={`group relative overflow-hidden rounded-2xl ring-1 ring-arc-border bg-gradient-to-br ${product.gradient || 'from-arc-surface2 to-arc-surface'} grid-noise transition-all duration-300 hover:ring-arc-primary/30 hover:shadow-glow ${big ? 'aspect-[4/3]' : 'h-44'}`}>
      {product.img && <img src={product.img} alt={product.title || ''} className="absolute inset-0 w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />}
      {product.img && <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-black/40"></div>}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2">
        <Avatar gradient={isImgUrl(seller.avatar) ? '' : (seller.avatar || 'from-slate-600 to-slate-800')} img={isImgUrl(seller.avatar) ? seller.avatar : null} name={seller.name} size={22} />
        <span className="text-[11px] font-semibold text-white/90">{seller.name}</span>
      </div>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
        {!product.img && <div className="text-7xl blob-float" style={{ textShadow: '0 6px 30px rgba(0,0,0,.5)' }}>{product.glyph}</div>}
        <div className="text-center">
          <div className="text-[10px] uppercase tracking-[0.2em] text-white/60">{tr('pd.priceFrom','From')}</div>
          <Usdc value={product.priceLow} className="text-4xl font-extrabold text-white" size="text-sm" />
        </div>
      </div>
      <div className="absolute bottom-4 inset-x-4 flex items-center justify-center gap-2 flex-wrap">
        {[tr('pd.tag.safe','100% Safe'), product.delivery === 'instant' ? tr('pd.tag.instant','Instant Delivery') : tr('pd.tag.fast','Fast Process'), tr('pd.tag.escrow','Escrow Protected')].map(t => (
          <span key={t} className="inline-flex items-center gap-1 text-[10px] font-medium text-white/90 bg-black/30 ring-1 ring-white/15 rounded-md px-2 py-1 backdrop-blur-sm">
            <Icon name="shield-check" size={11} className="text-emerald-300" /> {t}
          </span>
        ))}
      </div>
    </div>
  );
}

function StatBox({ icon, label, value, color }) {
  const c = { cyan: 'text-cyan-400', emerald: 'text-emerald-400', violet: 'text-arc-accent', blue: 'text-arc-accent', amber: 'text-amber-400' }[color] || 'text-arc-muted';
  return (
    <div className="flex-1 text-center px-2 py-3 transition-colors duration-200 hover:bg-arc-surface2/30 rounded-lg">
      <div className="flex items-center justify-center gap-1 text-[10px] uppercase tracking-wide text-arc-faint"><Icon name={icon} size={12} className={c} /> {label}</div>
      <div className="text-base font-bold text-arc-text mt-1 tabular-nums">{value}</div>
    </div>
  );
}

function ProductDetail({ product, onBuy, onStore, onBack, onChat }) {
  const [expand, setExpand] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('');
  const [reportLoading, setReportLoading] = useState(false);

  const submitReport = async () => {
    if (!reportReason.trim()) return;
    setReportLoading(true);
    try {
      const API = window.SLIME_API || '';
      const res = await fetch(API + '/api/reports', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetType: 'product', targetId: product.id, reason: reportReason.trim() }) });
      if (res.ok) { setReportOpen(false); setReportReason(''); alert('Report submitted. Admin will review.'); }
      else { const d = await res.json().catch(() => ({})); alert(d.error || 'Report failed'); }
    } catch (e) { alert('Network error'); }
    setReportLoading(false);
  };
  if (!product) return (
    <div className="anim-view">
      <div className="h-4 w-16 animate-pulse bg-arc-surface2/40 rounded-lg mb-4"></div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* skeleton art */}
        <div className="aspect-[4/3] w-full animate-pulse bg-arc-surface2/40 rounded-2xl ring-1 ring-arc-border"></div>
        {/* skeleton info */}
        <div className="flex flex-col gap-4">
          <div className="flex gap-2">
            <div className="h-5 w-16 animate-pulse bg-arc-surface2/40 rounded-lg"></div>
            <div className="h-5 w-20 animate-pulse bg-arc-surface2/40 rounded-lg"></div>
          </div>
          <div className="h-7 w-3/4 animate-pulse bg-arc-surface2/40 rounded-lg"></div>
          <div className="h-6 w-32 animate-pulse bg-arc-surface2/40 rounded-lg"></div>
          <div className="flex gap-2 mt-2">
            <div className="h-8 w-24 animate-pulse bg-arc-surface2/40 rounded-xl"></div>
            <div className="h-8 w-20 animate-pulse bg-arc-surface2/40 rounded-xl"></div>
            <div className="h-8 w-16 animate-pulse bg-arc-surface2/40 rounded-xl"></div>
            <div className="h-8 w-20 animate-pulse bg-arc-surface2/40 rounded-xl"></div>
          </div>
          <div className="h-20 w-full animate-pulse bg-arc-surface2/40 rounded-xl"></div>
          <div className="h-24 w-full animate-pulse bg-arc-surface2/40 rounded-xl"></div>
          <div className="flex gap-3 mt-2">
            <div className="h-11 flex-1 animate-pulse bg-arc-surface2/40 rounded-xl"></div>
            <div className="h-11 w-32 animate-pulse bg-arc-surface2/40 rounded-xl"></div>
          </div>
        </div>
      </div>
    </div>
  );
  const seller = product.seller || {};
  const desc = product.desc || '';
  const shown = expand ? desc : desc.slice(0, 260);
  const moreCount = (typeof storeProducts === 'function' && seller.name) ? storeProducts(seller.name).length : 0;

  // Variants list (excluding the synthesized single "Default" entry so the
  // detail view only shows a variants block when the seller actually defined
  // multiple price variants).
  const allVariants = Array.isArray(product.variants) ? product.variants : [];
  const realVariants = allVariants.filter(v => !(allVariants.length === 1 && v.label === 'Default'));
  // Per-variant stock count (instant delivery only). Manual delivery uses a
  // single product-level `stock` number — not per-variant.
  const variantStockOf = (v) => {
    if (product.delivery !== 'instant') return product.stock ?? 0;
    if (product.variantStock && typeof product.variantStock === 'object') {
      return product.variantStock[v.label] ?? (product.stockItems?.length ?? 0);
    }
    return product.stockItems?.length ?? 0;
  };
  // Total stock (used in the StatBox): sum of per-variant stock when present,
  // otherwise the legacy product-level stock.
  //
  // FIX: this used to fall back to `stockItems.length` (the legacy text[] array)
  // for single-variant products, while the seller center and storefront counted
  // `variantStock` (product_stock_items). The two sources diverged whenever a
  // restock wrote to one but not the other, so the product page and the seller
  // center showed different stock for the same listing. Prefer `variantStock`
  // everywhere; fall back to the legacy array only when it is absent.
  const variantStockTotal = (product.variantStock && typeof product.variantStock === 'object')
    ? Object.values(product.variantStock).reduce((a, b) => a + (Number(b) || 0), 0)
    : null;
  const totalStock = product.delivery === 'instant'
    ? (realVariants.length > 0
        ? realVariants.reduce((sum, v) => sum + variantStockOf(v), 0)
        : (variantStockTotal != null && Object.keys(product.variantStock).length > 0
            ? variantStockTotal
            : (product.stockItems?.length ?? product.stock ?? 0)))
    : (product.stock ?? 0);

  return (
    <div className="anim-view pd-fade-in">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-arc-muted hover:text-arc-text mb-4 transition"><Icon name="arrow-left" size={16} /> {tr('c.back','Back')}</button>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* left: art */}
        <div>
          <ProductArt product={product} big />
        </div>

        {/* right: info */}
        <div className="flex flex-col">
          <div className="flex items-center gap-2 mb-2">
            <PixBadge color="blue">{String(product.cat || 'ITEM').toUpperCase()}</PixBadge>
            <DeliveryBadge type={product.delivery} est={product.est} />
          </div>
          <h1 className="text-2xl font-bold text-white leading-snug" style={{ textWrap: 'balance' }}>{product.title}</h1>
          <div className="mt-2 flex items-baseline gap-2">
            <Usdc value={product.priceLow} className="text-2xl font-extrabold text-arc-accent" size="text-sm" />
            {product.priceHigh > product.priceLow && <><span className="text-arc-faint">–</span><Usdc value={product.priceHigh} className="text-2xl font-extrabold text-arc-accent" size="text-sm" /></>}
          </div>

          {/* variants block — only shown when the seller defined 2+ price variants */}
          {realVariants.length > 0 && (
            <div className="mt-3">
              <div className="text-[11px] uppercase tracking-wide text-arc-faint mb-2 flex items-center gap-1.5"><Icon name="layers" size={12} className="text-arc-accent" /> {tr('pd.variants','Variants')}</div>
              <div className="flex flex-wrap gap-2">
                {realVariants.map((v, i) => {
                  const vStock = variantStockOf(v);
                  const out = product.delivery === 'instant' && vStock <= 0;
                  return (
                    <span key={i} className={`inline-flex items-center gap-2 rounded-xl ring-1 px-3 py-2 text-xs transition-all duration-200 hover:-translate-y-0.5 ${out ? 'ring-rose-500/30 bg-rose-500/5 text-rose-400/80' : 'ring-arc-border bg-gradient-to-br from-arc-surface to-arc-surface2/50 text-arc-muted hover:ring-arc-primary/40 hover:shadow-glow hover:text-arc-text'}`}>
                      <span className="font-medium text-arc-text">{v.label}</span>
                      <Usdc value={v.price} className="text-emerald-400 font-bold" />
                      {product.delivery === 'instant' && (
                        <span className={`text-[10px] ${vStock > 0 ? 'text-arc-faint' : 'text-rose-400'}`}>· {vStock} {tr('pd.inStock','in stock')}</span>
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* seller row */}
          <button onClick={() => onStore(seller.name)} className="mt-4 inline-flex items-center gap-2.5 group w-fit">
            <Avatar gradient={isImgUrl(seller.avatar) ? '' : (seller.avatar || 'from-slate-600 to-slate-800')} img={isImgUrl(seller.avatar) ? seller.avatar : null} name={seller.name} size={36} />
            <div className="text-left">
              <div className="text-sm font-medium text-arc-text group-hover:text-arc-accent transition flex items-center gap-1.5">{seller.name} <Icon name="chevron-right" size={14} className="text-arc-faint" /></div>
              <div className="text-xs text-arc-faint flex items-center gap-1"><Stars value={seller.rating} size={11} /> {seller.rating} · {product.sold} {tr('pd.sold','Sold')}</div>
            </div>
          </button>

          {/* stat boxes */}
          <div className="mt-4 flex items-stretch bg-gradient-to-br from-arc-surface/60 to-arc-surface2/30 ring-1 ring-arc-border rounded-xl divide-x divide-arc-border/60">
            <StatBox icon="eye" label={tr('pd.viewed','Viewed')} value={product.views} color="cyan" />
            <StatBox icon="shopping-bag" label={tr('pd.sold','Sold')} value={product.sold} color="emerald" />
            <StatBox icon="shield" label={tr('pd.warranty','Warranty')} value={product.warranty} color="blue" />
            <StatBox icon="boxes" label={tr('pd.stock','Stock')} value={totalStock >= 999 ? '∞' : totalStock} color="amber" />
          </div>

          {/* seller info */}
          <Card className="mt-4 p-4 bg-gradient-to-br from-arc-surface to-arc-surface2/50 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glow">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-arc-faint mb-2"><Icon name="store" size={13} className="text-arc-accent" /> {tr('pd.sellerInfo','Seller Info')}</div>
            <div className="flex items-center gap-1.5 text-sm text-arc-text"><Icon name="calendar" size={14} className="text-arc-faint" /> {tr('pd.joined','Joined')} {product.joined}</div>
            <button onClick={() => onStore(seller.name)} className="mt-3 w-full text-sm text-arc-text bg-arc-surface2 hover:bg-arc-border ring-1 ring-arc-border rounded-xl py-2.5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glow">{tr('pd.viewMore','View')} {moreCount} {tr('pd.moreProducts','more products')}</button>
          </Card>

          {/* buy */}
          <div className="mt-4 flex gap-3">
            <Btn variant="primary" size="lg" full icon="zap" className="transition-all duration-200 hover:scale-[1.02] hover:shadow-glow" onClick={() => onBuy(product)}>{tr('pd.buyNow','Buy Now')}</Btn>
            <Btn variant="outline" size="lg" icon="message-circle" className="transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glow" onClick={() => onChat(seller.name)}>{tr('pd.chat','Chat')}</Btn>
          </div>
          <button onClick={() => setReportOpen(true)} className="mt-3 text-xs text-arc-faint hover:text-rose-400 transition inline-flex items-center gap-1"><Icon name="flag" size={12} /> Report Product</button>
        </div>
      </div>

      {/* description */}
      <Card className="mt-6 p-5 max-w-3xl bg-gradient-to-br from-arc-surface to-arc-surface2/50 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glow">
        <div className="flex items-center gap-2 text-sm font-semibold text-arc-text mb-3"><Icon name="file-text" size={16} className="text-arc-accent" /> {tr('pd.description','Description')}</div>
        <pre className="text-sm text-arc-text leading-relaxed whitespace-pre-wrap font-sans" style={{ textWrap: 'pretty' }}>{shown}{!expand && desc.length > 260 ? '…' : ''}</pre>
        {desc.length > 260 && (
          <button onClick={() => setExpand(e => !e)} className="mt-2 text-sm text-arc-accent hover:brightness-125 transition">{expand ? tr('pd.showLess','Show less') : tr('pd.readMore','Read more')}</button>
        )}
      </Card>

      {/* Report Modal */}
      <Modal open={reportOpen} onClose={() => setReportOpen(false)} width="max-w-md">
        <Card className="overflow-hidden">
          <div className="flex items-center gap-3 px-5 py-4 border-b border-arc-border bg-rose-500/5">
            <div className="w-10 h-10 rounded-xl bg-rose-500/15 ring-1 ring-rose-500/30 flex items-center justify-center text-rose-300"><Icon name="flag" size={18} /></div>
            <div>
              <div className="font-semibold text-arc-text">{tr('pd.reportProduct','Report Product')}</div>
              <div className="text-xs text-arc-muted">{product.title}</div>
            </div>
            <button onClick={() => setReportOpen(false)} className="ml-auto w-8 h-8 rounded-lg hover:bg-arc-surface2 text-arc-muted flex items-center justify-center"><Icon name="x" size={16} /></button>
          </div>
          <div className="p-5 space-y-4">
            <div>
              <label className="text-sm text-arc-muted">{tr('pd.reason','Reason')}</label>
              <textarea rows={3} value={reportReason} onChange={e => setReportReason(e.target.value)} placeholder="Describe the issue: scam, fake product, illegal content, etc."
                className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-rose-500/50 rounded-xl px-3.5 py-2.5 text-sm text-arc-text placeholder-arc-faint outline-none resize-none transition"></textarea>
            </div>
            <div className="flex gap-3">
              <Btn variant="ghost" full onClick={() => setReportOpen(false)}>{tr('c.cancel','Cancel')}</Btn>
              <Btn variant="danger" full icon="flag" disabled={!reportReason.trim()} onClick={submitReport} loading={reportLoading}>{tr('pd.submitReport','Submit Report')}</Btn>
            </div>
          </div>
        </Card>
      </Modal>
    </div>
  );
}

// ---------- Seller Store ----------
function StorePage({ storeName, reviews, onProduct, onBuy, onChat, onBack }) {
  const [tab, setTab] = useState('products');
  const [q, setQ] = useState('');
  const storeReviews = reviews || (typeof REVIEWS !== 'undefined' ? REVIEWS : []);
  const s = (typeof STORES !== 'undefined' ? STORES : {})[storeName];
  if (!s) return (
    <div className="anim-view">
      <div className="h-4 w-16 animate-pulse bg-arc-surface2/40 rounded-lg mb-4"></div>
      <div className="h-28 w-full animate-pulse bg-arc-surface2/40 rounded-2xl mb-5"></div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="bg-gradient-to-br from-arc-surface to-arc-surface2/50 ring-1 ring-arc-border rounded-2xl overflow-hidden">
            <div className="aspect-[4/3] w-full animate-pulse bg-arc-surface2/40 rounded-lg"></div>
            <div className="p-3.5 space-y-2">
              <div className="h-3 animate-pulse bg-arc-surface2/40 rounded-lg w-3/4"></div>
              <div className="h-3 animate-pulse bg-arc-surface2/40 rounded-lg w-1/2"></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
  const allProducts = typeof storeProducts === 'function' ? storeProducts(storeName) : [];
  // C3 — sold-out items move to their own tab; the Products tab shows in-stock only.
  const inStock = allProducts.filter(p => p.status !== 'soldout');
  const soldOut = allProducts.filter(p => p.status === 'soldout');
  const products = inStock.filter(p => (p.title || '').toLowerCase().includes(q.toLowerCase()));
  const soldOutFiltered = soldOut.filter(p => (p.title || '').toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="anim-view">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-arc-muted hover:text-arc-text mb-4 transition"><Icon name="arrow-left" size={16} /> {tr('c.back','Back')}</button>

      {/* banner header */}
      <div className="relative overflow-hidden rounded-2xl ring-1 ring-arc-border bg-gradient-to-br from-arc-surface to-arc-surface2/50 transition-all duration-300 hover:shadow-glow">
        <div className={`h-28 bg-gradient-to-r ${isImgUrl(s.banner) ? '' : (s.banner || 'from-arc-primary/40 to-arc-accent/30')} bg-cover bg-center`} style={isImgUrl(s.banner) ? { backgroundImage: `url(${s.banner})` } : {}}></div>
        <div className="px-5 pb-5 -mt-9 bg-arc-surface/70 backdrop-blur">
          <div className="flex flex-col sm:flex-row sm:items-end gap-4">
            <div className="relative">
              <Avatar gradient={isImgUrl(s.avatar) ? '' : s.avatar} img={isImgUrl(s.avatar) ? s.avatar : null} name={s.name} size={72} ring />
              {s.online && <span className="absolute bottom-1 right-1 w-3.5 h-3.5 rounded-full bg-emerald-400 ring-2 ring-arc-surface"></span>}
            </div>
            <div className="flex-1 pb-1">
              <h1 className="text-xl font-bold text-white">{s.name}</h1>
              <div className="flex items-center gap-2 mt-1 text-sm text-arc-muted flex-wrap">
                <span>@{String(s.handle || s.name || '').replace(/^@/, '')}</span>
                <span className="text-arc-faint">·</span>
                <CopyChip value={s.uid} />
                <span className="text-[10px] font-medium text-arc-faint bg-arc-surface2 ring-1 ring-arc-border rounded px-1.5 py-0.5">{tr('store.profileStorefront','Profile = storefront')}</span>
              </div>
            </div>
            <Btn variant="primary" icon="message-circle" onClick={() => onChat(s.name)}>{tr('store.chatSeller','Chat Seller')}</Btn>
          </div>
          <div className="h-px bg-arc-border my-4"></div>
          <div className="flex items-center gap-2">
            <Stars value={s.rating} size={14} />
            <span className="text-sm font-semibold text-arc-text">{s.rating}</span>
            <span className="text-xs text-arc-faint">({s.ratingCount} {tr('store.ratings','ratings')})</span>
          </div>
        </div>
      </div>

      {/* tabs */}
      <div className="flex items-center gap-1 mt-5 border-b border-arc-border">
        {[
          ['products', 'list', `${tr('store.tabProducts','Products')} (${inStock.length})`],
          ['reviews', 'star', `${tr('store.tabReviews','Reviews')} (${storeReviews.length})`],
          ['soldout', 'package-x', `${tr('store.tabSoldOut','Sold Out')} (${soldOut.length})`],
        ].map(([id, ic, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-all duration-200 ${tab === id ? 'border-arc-primary text-arc-accent' : 'border-transparent text-arc-muted hover:text-arc-text hover:border-arc-border'}`}>
            <Icon name={ic} size={15} /> {label}
          </button>
        ))}
      </div>

      {tab === 'products' ? (
        <div className="mt-5">
          <div className="flex flex-col sm:flex-row gap-3 mb-5">
            <h2 className="text-sm font-semibold text-arc-text self-center">{tr('store.allProducts','All Products')} <span className="text-arc-accent">{s.name}</span></h2>
            <div className="sm:ml-auto relative">
              <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-arc-faint" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder={tr('store.searchPh','Search products…')}
                className="w-full sm:w-64 bg-gradient-to-br from-arc-surface/60 to-arc-surface2/30 ring-1 ring-arc-border focus:ring-arc-primary/50 hover:ring-arc-borderlt rounded-xl pl-9 pr-9 h-10 text-sm text-arc-text placeholder-arc-faint outline-none transition-all duration-200" />
              {q && <button onClick={() => setQ('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md hover:bg-arc-surface2 text-arc-faint hover:text-arc-text flex items-center justify-center transition"><Icon name="x" size={14} /></button>}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {products.map(p => <ProductCard key={p.id} product={p} onBuy={onBuy} onOpen={() => onProduct(p)} />)}
          </div>
          {products.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 gap-4 text-center pd-fade-in">
              <div className="w-20 h-20 rounded-2xl bg-arc-surface2/60 ring-1 ring-arc-border flex items-center justify-center transition-transform duration-300 hover:scale-110">
                <Icon name="package" size={32} className="text-arc-faint" />
              </div>
              <div>
                <div className="text-base font-semibold text-arc-text">{tr('store.noProducts','No products.')}</div>
                <div className="text-xs text-arc-faint mt-1">{tr("pd.noProducts","This store hasn't listed any products yet")}</div>
              </div>
              {q && <button onClick={() => setQ('')} className="inline-flex items-center gap-1.5 text-xs font-medium text-arc-accent bg-arc-primary/10 hover:bg-arc-primary/20 ring-1 ring-arc-primary/30 rounded-lg px-4 py-2 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glow"><Icon name="rotate-ccw" size={13} /> Clear search</button>}
            </div>
          )}
        </div>
      ) : tab === 'soldout' ? (
        <div className="mt-5">
          <div className="flex flex-col sm:flex-row gap-3 mb-5">
            <h2 className="text-sm font-semibold text-arc-text self-center">{tr('store.tabSoldOut','Sold Out')} <span className="text-arc-accent">{s.name}</span></h2>
            <div className="sm:ml-auto relative">
              <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-arc-faint" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder={tr('store.searchPh','Search products…')}
                className="w-full sm:w-64 bg-gradient-to-br from-arc-surface/60 to-arc-surface2/30 ring-1 ring-arc-border focus:ring-arc-primary/50 hover:ring-arc-borderlt rounded-xl pl-9 pr-9 h-10 text-sm text-arc-text placeholder-arc-faint outline-none transition-all duration-200" />
              {q && <button onClick={() => setQ('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md hover:bg-arc-surface2 text-arc-faint hover:text-arc-text flex items-center justify-center transition"><Icon name="x" size={14} /></button>}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {soldOutFiltered.map(p => <ProductCard key={p.id} product={p} onBuy={undefined} onOpen={() => onProduct(p)} />)}
          </div>
          {soldOutFiltered.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 gap-4 text-center pd-fade-in">
              <div className="w-20 h-20 rounded-2xl bg-arc-surface2/60 ring-1 ring-arc-border flex items-center justify-center transition-transform duration-300 hover:scale-110">
                <Icon name="package-x" size={32} className="text-arc-faint" />
              </div>
              <div>
                <div className="text-base font-semibold text-arc-text">{tr('store.noSoldOut','No sold-out products.')}</div>
                <div className="text-xs text-arc-faint mt-1">{tr('pd.allInStock','All products are currently in stock')}</div>
              </div>
              {q && <button onClick={() => setQ('')} className="inline-flex items-center gap-1.5 text-xs font-medium text-arc-accent bg-arc-primary/10 hover:bg-arc-primary/20 ring-1 ring-arc-primary/30 rounded-lg px-4 py-2 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glow"><Icon name="rotate-ccw" size={13} /> Clear search</button>}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-5 space-y-3 max-w-3xl">
          {storeReviews.map((r, i) => (
            <Card key={i} className="p-4 bg-gradient-to-br from-arc-surface to-arc-surface2/50 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glow">
              <div className="flex items-center gap-3">
                <Avatar gradient={r.avatar} name={r.user} size={36} />
                <div className="flex-1">
                  <div className="text-sm font-medium text-arc-text inline-flex items-center gap-1.5">{typeof censorName === 'function' ? censorName(r.user) : r.user} <Icon name="shield-check" size={12} className="text-emerald-500/60" /></div>
                  <div className="flex items-center gap-2"><Stars value={r.rating} size={11} /><span className="text-[11px] text-arc-faint">{r.date}</span></div>
                </div>
              </div>
              <p className="text-sm text-arc-text mt-2.5 leading-relaxed" style={{ textWrap: 'pretty' }}>{r.text}</p>
            </Card>
          ))}
          {storeReviews.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 gap-4 text-center pd-fade-in">
              <div className="w-20 h-20 rounded-2xl bg-arc-surface2/60 ring-1 ring-arc-border flex items-center justify-center transition-transform duration-300 hover:scale-110">
                <Icon name="star" size={32} className="text-arc-faint" />
              </div>
              <div>
                <div className="text-base font-semibold text-arc-text">{tr('store.noReviews','No reviews yet.')}</div>
                <div className="text-xs text-arc-faint mt-1">{tr('pd.beFirstReview','Be the first to review this store')}</div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { ProductDetail, StorePage, ProductArt });
