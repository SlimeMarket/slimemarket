// ============ Storefront (catalog) + Checkout Modal ============

// Staggered card fade-in keyframe (injected once, scoped).
// The ProductCard sets `animationDelay` inline; this keyframe + the
// `.sf-card-in` class make that delay actually produce a visible stagger.
// `both` fill-mode keeps cards hidden (opacity 0) during the delay.
(function () {
  if (document.getElementById('sf-card-anim')) return;
  const s = document.createElement('style');
  s.id = 'sf-card-anim';
  s.textContent =
    '@keyframes sfCardFadeUp { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: translateY(0) } }' +
    '.sf-card-in { animation: sfCardFadeUp .42s cubic-bezier(.2,.8,.2,1) both; }' +
    '@keyframes sfFadeIn { from { opacity: 0 } to { opacity: 1 } }' +
    '.sf-fade-in { animation: sfFadeIn .3s ease both; }';
  document.head.appendChild(s);
})();

function ProductCard({ product, onBuy, onOpen, index }) {
  const variants = product.variants || [{ label: 'Default', price: product.price || 0 }];
  const lowPrice = Math.min(...variants.map(v => v.price));
  const soldOut = product.status === 'soldout';
  return (
    <div
      className="group relative bg-gradient-to-br from-arc-surface to-arc-surface2/50 ring-1 ring-arc-border rounded-2xl overflow-hidden transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glow hover:ring-arc-borderlt flex flex-col sf-card-in"
      style={{ animationDelay: `${(index || 0) * 60}ms` }}
    >
      {/* Full-bleed product image: object-cover fills the 4:3 box (minor edge crop
          acceptable), no letterbox side bars. */}
      <div onClick={onOpen} className={`relative aspect-[4/3] w-full bg-gradient-to-br ${product.gradient || 'from-arc-surface2 to-arc-surface'} grid-noise overflow-hidden ${onOpen ? 'cursor-pointer' : ''}`}>
        {product.img
          ? <img src={product.img} alt={product.title || ''} loading="lazy" className={`absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.04] ${soldOut ? 'opacity-60 saturate-50' : ''}`} />
          : <div className="absolute inset-0 flex items-center justify-center text-white/90 text-6xl blob-float select-none" style={{ textShadow: '0 4px 24px rgba(0,0,0,.4)' }}>{product.glyph}</div>}
        {soldOut && (
          <div className="absolute inset-0 bg-black/55 flex items-center justify-center">
            <span className="text-[11px] font-bold uppercase tracking-widest text-white bg-rose-500/80 ring-1 ring-white/20 rounded-lg px-3 py-1.5 backdrop-blur-sm">{tr('store.tabSoldOut','Sold Out')}</span>
          </div>
        )}
        <div className="absolute top-2.5 left-2.5 flex gap-1.5">
          {product.hot && <PixBadge color="rose">HOT</PixBadge>}
          {product.collateral && <PixBadge color="amber">{tr('sf.collateralBadge','COLLATERAL')}</PixBadge>}
        </div>
        <div className="absolute top-2.5 right-2.5">
          {!soldOut && <DeliveryBadge type={product.delivery} est={product.est} />}
          {soldOut && (
            <div className="w-8 h-8 rounded-lg bg-rose-500/20 ring-1 ring-rose-500/40 flex items-center justify-center">
              <Icon name="circle" size={12} className="text-rose-400" />
            </div>
          )}
        </div>
      </div>
      <div className="p-3.5 flex flex-col gap-2.5 flex-1">
        <div className="flex items-center gap-2 text-[11px] text-arc-muted">
          <Avatar gradient={isImgUrl(product.seller?.avatar) ? '' : (product.seller?.avatar || 'from-slate-600 to-slate-800')} img={isImgUrl(product.seller?.avatar) ? product.seller.avatar : null} name={product.seller?.name} size={18} />
          <span className="truncate">{product.seller?.name}</span>
          <span className="inline-flex items-center gap-0.5 ml-auto text-amber-400"><Icon name="star" size={11} className="fill-amber-400" stroke={0} />{product.seller?.rating}</span>
        </div>
        <h3 onClick={onOpen} className={`font-semibold text-[15px] leading-snug text-arc-text line-clamp-2 ${onOpen ? 'cursor-pointer hover:text-arc-accent transition-colors' : ''}`} style={{ textWrap: 'pretty' }}>{product.title}</h3>
        <div className="flex flex-wrap gap-1.5">
          {variants.slice(0, 3).map(v => (
            <span key={v.label} className="text-[10px] font-medium text-arc-muted bg-arc-surface2 ring-1 ring-arc-border rounded-md px-1.5 py-0.5 hover:ring-arc-primary/30 hover:text-arc-text transition-colors cursor-default">{v.label}</span>
          ))}
        </div>
        <div className="flex items-end justify-between mt-auto pt-1">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-arc-faint">{tr('pd.priceFrom','From')}</div>
            <Usdc value={lowPrice} className="text-emerald-400 font-bold text-lg" />
          </div>
          {soldOut
            ? <span className="text-[11px] font-medium text-rose-300 bg-rose-500/10 ring-1 ring-rose-500/30 rounded-lg px-2.5 py-1.5">{tr('store.tabSoldOut','Sold Out')}</span>
            : <Btn size="sm" icon="zap" disabled={!onBuy} onClick={onBuy ? () => onBuy(product) : undefined} className="transition-transform duration-200 hover:scale-105">{tr('c.buy','Buy')}</Btn>}
        </div>
      </div>
    </div>
  );
}

function Storefront({ onBuy, onProduct, query, cat: catProp, onCatChange }) {
  // The selected category is owned by the parent when `cat` is passed, so the
  // landing-page cards can open the storefront already filtered. Internal state
  // is kept as a fallback so the component still works standalone.
  const [internalCat, setInternalCat] = useState('All');
  // 'Semua' (Indonesian for "All") can still arrive from an older caller or a
  // bookmarked URL; treat it as the sentinel, never as a category name.
  const rawCat = catProp === undefined || catProp === null ? internalCat : catProp;
  const cat = !rawCat || rawCat === 'Semua' ? 'All' : rawCat;
  const setCat = (c) => {
    setInternalCat(c);
    if (onCatChange) onCatChange(c);
  };
  const [q, setQ] = useState('');
  const [retryTick, setRetryTick] = useState(0);
  // "Load more" state: the API pages at 24, so the storefront must be
  // able to pull the next page instead of only ever showing the newest 24.
  const [loadingMore, setLoadingMore] = useState(false);
  const [catalogTick, setCatalogTick] = useState(0);
  useEffect(() => { if (query !== undefined && query !== null) setQ(query); }, [query]);
  // Poll catalog state so the error/empty banners appear as soon as the fetch settles.
  const [catalogState, setCatalogState] = useState(window.CATALOG_STATE || 'loading');
  useEffect(() => {
    setCatalogState(window.CATALOG_STATE || 'loading');
    const t = setInterval(() => setCatalogState(window.CATALOG_STATE || 'loading'), 1200);
    return () => clearInterval(t);
  }, [retryTick]);
  // C2 — hide sold-out items from Explore (store pages keep them for the Sold-Out tab)
  //
  // Search matches the PRODUCT NAME, the CATEGORY, the description and the
  // SELLER name — not just the title. Searching "rimuru" (a username) used to
  // return nothing because only `p.title` was checked.
  const ql = (q || '').trim().toLowerCase();
  const list = (window.PRODUCTS || []).filter(p => {
    if (p.status === 'soldout') return false;
    if (cat !== 'All' && p.cat !== cat) return false;
    if (!ql) return true;
    const haystack = [p.title, p.cat, p.desc, p.seller && p.seller.name, p.seller && p.seller.handle]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(ql);
  });

  // Ask the SERVER too (debounced): the storefront only holds the first page
  // (24 newest), so a match on page 2+ would never be found by the client
  // filter alone. The API searches product name + store name + seller username.
  const firstSearchRun = useRef(true);
  useEffect(() => {
    if (firstSearchRun.current) { firstSearchRun.current = false; return; }
    const qq = (q || '').trim();
    const catArg = cat !== 'All' ? cat : '';
    const t = setTimeout(() => {
      if (window.loadCatalog) window.loadCatalog({ q: qq || undefined, cat: catArg || undefined });
    }, 350);
    return () => clearTimeout(t);
  }, [q, cat]);
  // Referenced so the list re-renders after "Load more" appends to window.PRODUCTS.
  void catalogTick;
  const loading = catalogState === 'loading' || (!window.PRODUCTS && catalogState !== 'error');
  return (
    <div className="anim-view">
      {/* hero strip */}
      <div className="relative overflow-hidden rounded-3xl ring-1 ring-arc-primary/20 arc-mesh p-6 sm:p-8 mb-6">
        <div className="absolute -right-6 -top-8 opacity-30"><SlimeLogo size={180} /></div>
        <div className="relative">
          <Pixel className="text-arc-accent text-[10px]">ARC NETWORK · DUAL ESCROW</Pixel>
          <h1 className="mt-3 text-2xl sm:text-3xl font-bold text-white max-w-lg" style={{ textWrap: 'balance' }}>{tr('sf.title','Buy digital assets without fear of scams.')}</h1>
          <p className="mt-2 text-sm text-arc-muted max-w-md">{tr('sf.subtitle','Smart-contract escrow on every transaction. Gas paid transparently in USDC.')}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-arc-text bg-arc-bg/40 ring-1 ring-arc-border rounded-lg px-3 py-1.5 transition-all duration-200 hover:ring-arc-primary/30 hover:-translate-y-0.5"><Icon name="shield-check" size={14} className="text-emerald-400" /> Non-custodial MPC</span>
            <span className="inline-flex items-center gap-1.5 text-xs text-arc-text bg-arc-bg/40 ring-1 ring-arc-border rounded-lg px-3 py-1.5 transition-all duration-200 hover:ring-arc-primary/30 hover:-translate-y-0.5"><Icon name="lock" size={14} className="text-arc-accent" /> E2E Encrypted</span>
            <span className="inline-flex items-center gap-1.5 text-xs text-arc-text bg-arc-bg/40 ring-1 ring-arc-border rounded-lg px-3 py-1.5 transition-all duration-200 hover:ring-arc-primary/30 hover:-translate-y-0.5"><Icon name="gavel" size={14} className="text-amber-400" /> Tribunal Dispute</span>
          </div>
        </div>
      </div>

      {/* controls */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <div className="flex items-center gap-1.5 flex-wrap">
          {CATEGORIES.map(c => (
            <button key={c} onClick={() => setCat(c)}
              className={`text-xs font-medium rounded-lg px-3 py-2 transition-all duration-200 ring-1 ${cat === c ? 'bg-arc-primary text-white ring-arc-primary shadow-glow hover:brightness-110'
 : 'bg-arc-surface/60 ring-arc-border text-arc-muted hover:text-arc-text hover:ring-arc-primary/30 hover:-translate-y-0.5'}`}>{c === 'All' ? tr('c.all','All') : c}</button>
          ))}
        </div>
        <div className="sm:ml-auto relative">
          <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-arc-faint" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={tr('sf.searchPlaceholder','Search products…')}
            className="w-full sm:w-64 bg-arc-surface/60 ring-1 ring-arc-border focus:ring-arc-primary/50 hover:ring-arc-borderlt rounded-xl pl-9 pr-9 h-10 text-sm text-arc-text placeholder-arc-faint outline-none transition-all duration-200" />
          {q && (
            <button onClick={() => setQ('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md hover:bg-arc-surface2 text-arc-faint hover:text-arc-text flex items-center justify-center transition">
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      </div>

      {/* grid — loading skeletons (8 placeholder cards) */}
      {loading && (
        <div>
          <div className="flex items-center gap-2 mb-4 text-xs text-arc-faint">
            <Icon name="loader" size={13} className="animate-spin text-arc-accent" />
            <span>{tr('sf.loading','Loading products…')}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="bg-gradient-to-br from-arc-surface to-arc-surface2/50 ring-1 ring-arc-border rounded-2xl overflow-hidden">
                <div className="aspect-[4/3] w-full animate-pulse bg-arc-surface2/40 rounded-lg"></div>
                <div className="p-3.5 space-y-2.5">
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 rounded-full animate-pulse bg-arc-surface2/40 rounded-lg"></div>
                    <div className="h-2.5 animate-pulse bg-arc-surface2/40 rounded-lg w-1/3"></div>
                  </div>
                  <div className="h-3 animate-pulse bg-arc-surface2/40 rounded-lg w-3/4"></div>
                  <div className="h-3 animate-pulse bg-arc-surface2/40 rounded-lg w-1/2"></div>
                  <div className="flex gap-1.5 pt-1">
                    <div className="h-4 animate-pulse bg-arc-surface2/40 rounded-lg w-10"></div>
                    <div className="h-4 animate-pulse bg-arc-surface2/40 rounded-lg w-12"></div>
                  </div>
                  <div className="flex justify-between items-end pt-2">
                    <div className="space-y-1.5">
                      <div className="h-2 animate-pulse bg-arc-surface2/40 rounded-lg w-8"></div>
                      <div className="h-4 animate-pulse bg-arc-surface2/40 rounded-lg w-14"></div>
                    </div>
                    <div className="h-8 w-12 animate-pulse bg-arc-surface2/40 rounded-lg"></div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {/* error state — catalog unreachable (show retry, not an eternal skeleton) */}
      {catalogState === 'error' && (
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-center sf-fade-in">
          <div className="w-20 h-20 rounded-2xl bg-red-500/10 ring-1 ring-red-500/30 flex items-center justify-center">
            <Icon name="wifi-off" size={32} className="text-red-400" />
          </div>
          <div>
            <div className="text-base font-semibold text-arc-text">{tr('sf.loadError','Could not load the catalog.')}</div>
            <div className="text-xs text-arc-faint mt-1">{tr('sf.loadErrorHint','Check your connection — the server may be briefly unavailable.')}</div>
          </div>
          <button onClick={() => { setRetryTick(t => t + 1); window.loadCatalog && window.loadCatalog(); }}
            className="inline-flex items-center gap-2 text-sm font-medium bg-arc-primary hover:bg-arc-primarydk text-white rounded-xl px-4 h-10 transition-all duration-200 shadow-glow hover:brightness-110">
            <Icon name="rotate-ccw" size={15} /> {tr('sf.retry','Retry')}
          </button>
        </div>
      )}
      {!loading && catalogState !== 'error' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {list.map((p, i) => <ProductCard key={p.id} product={p} index={i} onBuy={onBuy} onOpen={onProduct ? () => onProduct(p) : undefined} />)}
        </div>
      )}
      {/* "Load more". The API pages at 24 and the SPA used to fetch only
          page 1, so everything after the 24 newest products was unreachable. */}
      {!loading && catalogState !== 'error' && !q && cat === 'All'
        && (window.PRODUCTS || []).length < (window.CATALOG_TOTAL || 0) && (
        <div className="flex flex-col items-center gap-2 mt-8">
          <button
            onClick={async () => {
              setLoadingMore(true);
              await window.loadCatalog({ page: (window.CATALOG_PAGE || 1) + 1, append: true });
              setLoadingMore(false);
              setCatalogTick(t => t + 1);
            }}
            disabled={loadingMore}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-arc-surface2/60 ring-1 ring-arc-border hover:ring-arc-borderlt text-sm text-arc-text transition disabled:opacity-50">
            <Icon name={loadingMore ? 'loader' : 'chevron-down'} size={15} className={loadingMore ? 'animate-spin' : ''} />
            {loadingMore ? tr('sf.loadingMore','Loading…') : tr('sf.loadMore','Load more')}
          </button>
          <div className="text-[11px] text-arc-faint">
            {(window.PRODUCTS || []).length} / {window.CATALOG_TOTAL}
          </div>
        </div>
      )}
      {/* empty state — no matching products (catalog loaded but filter yielded nothing) */}
      {!loading && catalogState !== 'error' && list.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-4 text-center sf-fade-in">
          <div className="w-20 h-20 rounded-2xl bg-arc-surface2/60 ring-1 ring-arc-border flex items-center justify-center transition-transform duration-300 hover:scale-110">
            <Icon name="search-x" size={32} className="text-arc-faint" />
          </div>
          <div>
            <div className="text-base font-semibold text-arc-text">{tr('sf.noProducts','No matching products.')}</div>
            <div className="text-xs text-arc-faint mt-1">{tr('sf.noResults','Try a different search term or category')}</div>
          </div>
          <button onClick={() => { setQ(''); setCat('All'); }}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-arc-accent bg-arc-primary/10 hover:bg-arc-primary/20 ring-1 ring-arc-primary/30 hover:ring-arc-primary/50 rounded-lg px-4 py-2 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glow">
            <Icon name="rotate-ccw" size={13} /> {tr('sf.clearSearch','Clear search')}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- Checkout Modal ----------
function CheckoutModal({ open, product, onClose, onPay }) {
  const [variant, setVariant] = useState(null);
  const [qty, setQty] = useState(1);
  // .C — default to EXTERNAL wallet gasless (Circle arc-ecommerce funnel:
  // connect → sign permit → done; no PIN, no Slime Wallet, no top-up). UCW
  // stays one tap away for users who want platform MPC custody.
  const [paymentMethod, setPaymentMethod] = useState('external');
  const [connecting, setConnecting] = useState(false);
  useEffect(() => { if (product) { setVariant((product.variants || [{ label: 'Default', price: product.price || 0 }])[0]); setQty(1); setPaymentMethod('external'); } }, [product]);
  if (!product || !variant) return null;

  // Per-variant stock count. For instant delivery the stock lives in the
  // variantStock map (migration 0037 product_stock_items). For manual delivery
  // the product-level `stock` number is used (it is not per-variant).
  const variantStockOf = (v) => {
    if (!v) return 0;
    if (product.delivery === 'instant') {
      if (product.variantStock && typeof product.variantStock === 'object') {
        return product.variantStock[v.label] ?? (product.stockItems?.length ?? 0);
      }
      return product.stockItems?.length ?? 0;
    }
    return product.stock ?? 0;
  };
  const variantStock = variantStockOf(variant);
  const maxQty = product.stock >= 999 ? 999 : Math.max(1, variantStock || (product.stock || 1));
  const unit = variant.price;
  const price = +(unit * qty).toFixed(2);
  const adminFee = +(price * 0.02).toFixed(2); // 2% buyer fee (non-refundable)
  const total = +(price + adminFee).toFixed(2);
  // gate on the SAME balance the server checks. In non-custodial mode
  // the authoritative number is the on-chain USDC on Arc; ME.usdc is a display
  // max() that can include a stale DB mirror, which made the button look
  // affordable and then fail at the server gate.
  const balanceForGate = (window.ONCHAIN_FUNDS && typeof ME.usdcOnChain === 'number') ? ME.usdcOnChain : ME.usdc;
  const enough = balanceForGate >= total;
  // Disable variants that are out of stock for instant delivery.
  const variantDisabled = (v) => product.delivery === 'instant' && variantStockOf(v) <= 0;

  return (
    <Modal open={open} onClose={onClose} width="max-w-md">
      <Card className="overflow-hidden">
        <div className={`relative h-24 bg-gradient-to-br ${product.gradient || 'from-arc-surface2 to-arc-surface'} grid-noise`}>
          <button onClick={onClose} className="absolute top-3 right-3 w-8 h-8 rounded-lg bg-arc-bg/40 hover:bg-arc-bg/70 text-white flex items-center justify-center transition"><Icon name="x" size={16} /></button>
          <div className="absolute bottom-3 left-4 flex items-center gap-3">
            <div className="text-4xl">{product.glyph}</div>
            <div>
              <Pixel className="text-white/80 text-[8px]">{tr('sf.checkoutBadge','CHECKOUT')}</Pixel>
              <div className="font-semibold text-white text-sm leading-tight mt-1 max-w-[15rem] line-clamp-1">{product.title}</div>
            </div>
          </div>
        </div>

        <div className="p-5">
          <div className="text-[11px] uppercase tracking-wide text-arc-faint mb-2">{tr('sf.selectVariant','Select Variant')}</div>
          <div className="flex flex-wrap gap-2 mb-4">
            {(product.variants || [variant]).map(v => {
              const disabled = variantDisabled(v);
              const vStock = variantStockOf(v);
              return (
                <button key={v.label} onClick={() => !disabled && setVariant(v)} disabled={disabled}
                  className={`text-xs font-medium rounded-lg px-3 py-2 transition-all duration-200 flex items-center gap-1.5 ${disabled ? 'bg-arc-surface2 text-arc-faint ring-1 ring-arc-border opacity-50 cursor-not-allowed' : variant.label === v.label ? 'bg-arc-primary/20 text-arc-accent ring-1 ring-arc-primary shadow-glow hover:brightness-110' : 'bg-arc-surface2 text-arc-muted ring-1 ring-arc-border hover:ring-arc-borderlt hover:-translate-y-0.5 hover:text-arc-text'}`}>
                  <span>{v.label}</span>
                  <span className="font-mono text-emerald-300">{v.price}</span>
                  {product.delivery === 'instant' && (
                    <span className={`text-[10px] ${vStock > 0 ? 'text-arc-faint' : 'text-rose-400'}`}>· {vStock}</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 mb-4 text-xs">
            <DeliveryBadge type={product.delivery} est={product.est} />
            <span className="text-arc-muted">{product.delivery === 'instant' ? 'Credentials auto-decrypt → status SENT.' : `Seller processes in ~${product.est || 15} min.`}</span>
          </div>

          <div className="flex items-center justify-between bg-gradient-to-br from-arc-bg/50 to-arc-surface2/30 ring-1 ring-arc-border rounded-xl px-3.5 py-3 mb-4">
            <div>
              <div className="text-sm text-arc-text">{tr('sf.quantity','Quantity')}</div>
              <div className="text-[11px] text-arc-faint">{tr('pd.stock','Stock')}: <span className={variantStock > 0 ? 'text-emerald-400 font-medium' : 'text-rose-400 font-medium'}>{variantStock >= 999 ? '999+' : variantStock}</span></div>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setQty(q => Math.max(1, q - 1))} disabled={qty <= 1} className="w-9 h-9 rounded-lg bg-arc-surface2 hover:bg-arc-border text-arc-text flex items-center justify-center transition-all duration-200 hover:scale-105 disabled:opacity-40 disabled:hover:scale-100 disabled:cursor-not-allowed"><Icon name="minus" size={16} /></button>
              <input value={qty} onChange={e => { const v = parseInt(e.target.value.replace(/[^0-9]/g, '')) || 1; setQty(Math.min(maxQty, Math.max(1, v))); }} className="w-12 h-9 text-center bg-arc-bg/60 ring-1 ring-arc-borderlt rounded-lg text-sm text-arc-text font-mono outline-none transition focus:ring-arc-primary/50" />
              <button onClick={() => setQty(q => Math.min(maxQty, q + 1))} disabled={qty >= maxQty} className="w-9 h-9 rounded-lg bg-arc-surface2 hover:bg-arc-border text-arc-text flex items-center justify-center transition-all duration-200 hover:scale-105 disabled:opacity-40 disabled:hover:scale-100 disabled:cursor-not-allowed"><Icon name="plus" size={16} /></button>
            </div>
          </div>

          {/* Payment Method Selector — .C: external wallet FIRST (Circle
              arc-ecommerce pattern: pay with your own wallet, gasless permit,
              no PIN). UCW Balance second = platform MPC custody. */}
          <div className="mb-4">
            <div className="text-[11px] uppercase tracking-wide text-arc-faint mb-2">{tr('sf.paymentMethod','Payment Method')}</div>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => setPaymentMethod('external')}
                className={`flex flex-col items-center gap-1.5 rounded-xl p-3 text-center transition-all duration-200 ring-1 ${paymentMethod === 'external' ? 'ring-2 ring-violet-500 bg-violet-500/10 shadow-glow hover:brightness-110' : 'ring-arc-border bg-arc-surface/60 hover:ring-arc-borderlt hover:-translate-y-0.5'}`}
              >
                <Icon name="wallet" size={18} className={paymentMethod === 'external' ? 'text-violet-400' : 'text-arc-muted'} />
                <div className="text-xs font-medium text-arc-text">{tr('sf.pmExternal','Your Wallet')}</div>
                <div className="text-[10px] text-arc-faint">{window.WalletBridge?.getAddress?.() ? tr('sf.pmConnected','Connected') : tr('sf.connectToPay','Connect to pay')}</div>
              </button>
              <button
                onClick={() => setPaymentMethod('ucw')}
                className={`flex flex-col items-center gap-1.5 rounded-xl p-3 text-center transition-all duration-200 ring-1 ${paymentMethod === 'ucw' ? 'ring-2 ring-arc-primary bg-arc-primary/10 shadow-glow hover:brightness-110' : 'ring-arc-border bg-arc-surface/60 hover:ring-arc-borderlt hover:-translate-y-0.5'}`}
              >
                <Icon name="shield-check" size={18} className={paymentMethod === 'ucw' ? 'text-arc-accent' : 'text-arc-muted'} />
                <div className="text-xs font-medium text-arc-text">{tr('sf.pmSlime','Slime Wallet')}</div>
                {/* Show the balance the GATE actually uses, not ME.usdc. The tile
                    used to advertise the platform-ledger balance (e.g. 49.00)
                    while the pay button gated on the on-chain balance (0.00), so
                    picking a method that read "49.00 USDC" landed on
                    "Insufficient Balance" — the user is told they have funds and
                    then told they don't. */}
                <div className="text-[10px] text-arc-faint"><Usdc value={balanceForGate} /></div>
              </button>
              <button
                disabled
                className="flex flex-col items-center gap-1.5 rounded-xl p-3 text-center ring-1 ring-arc-border bg-arc-surface/40 opacity-50 cursor-not-allowed"
              >
                <Icon name="credit-card" size={18} className="text-arc-faint" />
                <div className="text-xs font-medium text-arc-faint">{tr('sf.cardBank','Card / Bank')}</div>
                <div className="text-[10px] text-arc-faint">{tr('sf.comingSoon','Coming soon')}</div>
              </button>
            </div>
            <div className="text-[10px] text-arc-faint mt-1.5 leading-relaxed">
              {paymentMethod === 'external'
                ? tr('sf.pmExternalNote','MetaMask, Coinbase, WalletConnect — you approve the payment, gas is sponsored by the platform.')
                : paymentMethod === 'ucw'
                ? tr('sf.pmUcwNote','Slime Wallet (MPC, PIN-secured) — needs a PIN and USDC balance.')
                : ''}
            </div>
          </div>

          {/* Checkout summary — premium gradient card with fee breakdown */}
          <div className="bg-gradient-to-br from-arc-bg/60 to-arc-surface2/30 ring-1 ring-arc-border rounded-xl p-4 space-y-2.5">
            <Row label={tr('sf.subtotal','Subtotal')} sub={variant.label + (qty > 1 ? ' × ' + qty : '')}><Usdc value={price} className="text-arc-text" /></Row>
            <Row label={tr('sf.adminFee','Service fee (2%)')} sub={tr('sf.adminFeeSub','Non-refundable platform fee')}><Usdc value={adminFee} className="text-arc-text" /></Row>
            <div className="h-px bg-gradient-to-r from-transparent via-arc-border to-transparent my-1"></div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-arc-text">{tr('sf.totalPay','Total')}</span>
              <Usdc value={total} className="text-emerald-400 font-bold text-lg" />
            </div>
            <div className="text-[10px] text-arc-faint font-mono pt-1">
              Price: ${price.toFixed(2)} · Service fee (2%): ${adminFee.toFixed(2)} · Total: ${total.toFixed(2)}
            </div>
          </div>
          <div className="flex items-start gap-1.5 mt-2 text-[11px] text-arc-faint">
            <Icon name="info" size={12} className="text-arc-faint mt-0.5 shrink-0" /> {tr('sf.feeNote','The 2% service fee is added on top and paid by the buyer. The seller also pays a 2% platform fee on completed sales, so they receive 98% of the item price.')}
          </div>

          {paymentMethod === 'ucw' && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-arc-muted inline-flex items-center gap-1.5"><Icon name="wallet" size={14} className="text-arc-accent" /> {tr('sf.walletBalance','On-chain Balance (Arc)')}</span>
              <span className={enough ? 'text-arc-text' : 'text-rose-400'}><Usdc value={balanceForGate} /></span>
            </div>
            {!enough && (
              <div className="text-[10px] text-rose-400/90 mt-1 text-right">
                {tr('sf.needArcUsdc', 'You need USDC on Arc. Add funds from your wallet page.')}
              </div>
            )}
          </div>
          )}

          <Btn variant="emerald" size="lg" full className="mt-4 transition-all duration-200 hover:scale-[1.02] hover:shadow-glow" icon={connecting ? 'loader' : 'wallet'} disabled={(!enough && paymentMethod === 'ucw') || connecting || variantStock <= 0}
            onClick={() => {
              if (paymentMethod === 'external' && !window.WalletBridge?.isConnected?.()) {
                setConnecting(true);
                window.WalletBridge.connect().catch(() => null).finally(() => setConnecting(false));
                return;
              }
              onPay(product, variant, total, qty, paymentMethod);
            }}>
            {variantStock <= 0 ? tr('sf.outOfStock','Out of Stock') :
             paymentMethod === 'ucw' ? (enough ? tr('sf.payViaWallet','Pay via Wallet') : tr('sf.insufficient','Insufficient Balance')) :
             paymentMethod === 'external' ? (window.WalletBridge?.isConnected?.() ? tr('sf.payExtGasless','Pay via External Wallet (gasless)') : (connecting ? tr('sf.connecting','Connecting...') : tr('sf.connectWalletPay','Connect wallet to pay directly'))) :
             'Coming Soon'}
          </Btn>
          <div className="flex items-center justify-center gap-1.5 mt-3 text-[11px] text-arc-faint">
            <Icon name="shield-check" size={13} className="text-emerald-500/70" /> Funds locked in Smart Contract Escrow. 42h inspection window.
          </div>
        </div>
      </Card>
    </Modal>
  );
}

function Row({ label, sub, badge, children }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div>
          <div className="text-sm text-arc-text flex items-center gap-1.5">{label}{badge && <span className="font-pixel text-[7px] text-arc-accent bg-arc-primary/15 ring-1 ring-arc-primary/30 rounded px-1 py-0.5">{badge}</span>}</div>
          {sub && <div className="text-[11px] text-arc-faint">{sub}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

Object.assign(window, { Storefront, CheckoutModal, ProductCard });
