// ============ View: Home (Landing) ============

function HeroBanner({ banner, onCta }) {
  if (banner.kind === 'promo') {
    return (
      <div className={`relative overflow-hidden rounded-2xl ring-1 ring-arc-border bg-gradient-to-br ${banner.gradient} h-full min-h-[208px] grid-noise`}>
        <div className="relative p-5 sm:p-6 h-full flex flex-col">
          <div className="flex items-start justify-between">
            <PixBadge color="cyan">{banner.badge}</PixBadge>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wide text-white/60">{tr('promo.price','Price')}</div>
              <Usdc value={banner.price} className="text-3xl font-bold text-white" size="text-xs" />
            </div>
          </div>
          <div className="mt-3">
            <div className="text-2xl sm:text-3xl font-bold text-white">{banner.title}</div>
            <div className="text-sm text-white/70 mt-1 max-w-xs">{banner.sub}</div>
          </div>
          <div className="mt-auto pt-4 flex flex-wrap gap-1.5">
            {(banner.features || []).map(f => (
              <span key={f} className="text-[10px] font-medium text-white/90 bg-white/10 ring-1 ring-white/15 rounded-md px-2 py-1 backdrop-blur-sm">{f}</span>
            ))}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="relative overflow-hidden rounded-2xl ring-1 ring-arc-primary/20 arc-mesh h-full min-h-[208px] grid-noise">
      <div className="absolute -right-6 -bottom-10 opacity-25"><SlimeLogo size={200} /></div>
      <div className="relative p-6 sm:p-8 h-full flex flex-col justify-center">
        <Pixel className="text-arc-accent text-[9px]">SLIMEMARKET · ARC ESCROW</Pixel>
        <h1 className="mt-3 text-2xl sm:text-[28px] leading-tight font-bold text-white max-w-md" style={{ textWrap: 'balance' }}>{tr('home.heroTitle','Buy digital assets without fear of scams.')}</h1>
        <p className="mt-2 text-sm text-arc-muted max-w-sm">{tr('home.heroSub','Every transaction is guarded by smart-contract escrow. Anti-scam, money back if it fails.')}</p>
        <div className="mt-5"><Btn variant="primary" icon="shopping-bag" onClick={onCta}>{tr('home.heroCta','Start Shopping')}</Btn></div>
      </div>
    </div>
  );
}

// ---------- Trending products (sales-driven, newest fallback) ----------
// Fetches recent DONE sales once per catalog snapshot and maps them onto
// window.PRODUCTS. Falls back to the newest products when the sales endpoint
// is unavailable or matches fewer than 2 products.
function useTrending(newestFallback) {
  const list = (window.PRODUCTS || []);
  const [trending, setTrending] = useState(null);
  useEffect(() => {
    let cancelled = false;
    const derive = (sales) => {
      const products = (window.PRODUCTS || []);
      const seen = {};
      const matched = [];
      for (const sale of sales || []) {
        const n = (sale.productName || '').trim().toLowerCase();
        if (!n || seen[n]) continue;
        seen[n] = true;
        const p = products.find(x => (x.title || '').trim().toLowerCase() === n);
        if (p) matched.push(p);
      }
      return matched;
    };
    (async () => {
      let matched = [];
      try {
        const res = await fetch((window.SLIME_API || '') + '/api/sales/recent?limit=20', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          matched = derive(data && Array.isArray(data.items) ? data.items : []);
        }
      } catch (e) { /* fallback below */ }
      if (!cancelled) setTrending(matched.length >= 2 ? matched : (newestFallback || []));
    })();
    return () => { cancelled = true; };
  }, [list.length]);
  if (trending && trending.length > 0) return trending;
  return trending && trending.length === 0 ? [] : (newestFallback || []);
}

// D1 — auto-rotating hero slider: one featured product at a time, 5s interval,
// prev/next arrows + dots, pause on hover. Replaces the static promo banner.
function TrendingSlider({ products, onProduct, onBuy }) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const n = products.length;
  useEffect(() => {
    if (paused || n <= 1) return;
    const id = setInterval(() => setIdx(i => (i + 1) % n), 5000);
    return () => clearInterval(id);
  }, [paused, n]);
  useEffect(() => { if (idx >= n) setIdx(0); }, [idx, n]);
  if (n === 0) return null;
  const p = products[idx];
  return (
    <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      className={`relative overflow-hidden rounded-2xl ring-1 ring-arc-border bg-gradient-to-br ${p.gradient || 'from-cyan-600 via-blue-700 to-indigo-900'} h-full min-h-[208px] grid-noise`}>
      {p.img && <img src={p.img} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover opacity-25" />}
      <div className="relative p-5 sm:p-6 h-full flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <PixBadge color="cyan">{p.seller?.name || (String(p.cat || '').toUpperCase())}</PixBadge>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide text-white/60">{tr('promo.price','Price')}</div>
            <Usdc value={p.priceLow != null ? p.priceLow : p.price} className="text-3xl font-bold text-white" size="text-xs" />
          </div>
        </div>
        <div className="mt-3 cursor-pointer" onClick={() => onProduct(p)}>
          <div className="text-2xl sm:text-3xl font-bold text-white leading-tight line-clamp-2">{p.title}</div>
          <div className="text-sm text-white/70 mt-1 max-w-xs">{tr('home.trendingBadge','HOT · recently purchased')}</div>
        </div>
        <div className="mt-auto pt-4 flex items-center gap-2.5">
          {(p.status === 'soldout' || ((p.stock || 0) <= 0 && (p.stockItems?.length || 0) <= 0))
            ? <span className="text-[11px] font-semibold text-rose-300 bg-rose-500/15 ring-1 ring-rose-500/35 rounded-lg px-2.5 py-1.5">{tr('store.tabSoldOut','Sold Out')}</span>
            : <Btn size="sm" icon="zap" onClick={() => onBuy(p)}>{tr('c.buy','Buy')}</Btn>}
          <button onClick={() => onProduct(p)} className="text-xs text-white/80 hover:text-white inline-flex items-center gap-1 transition">{tr('home.view','View')} <Icon name="chevron-right" size={13} /></button>
          <div className="ml-auto flex items-center gap-2">
            <button aria-label="prev" onClick={() => setIdx(i => (i - 1 + n) % n)} className="w-7 h-7 rounded-lg bg-white/10 hover:bg-white/20 ring-1 ring-white/15 text-white flex items-center justify-center transition"><Icon name="chevron-left" size={14} /></button>
            <button aria-label="next" onClick={() => setIdx(i => (i + 1) % n)} className="w-7 h-7 rounded-lg bg-white/10 hover:bg-white/20 ring-1 ring-white/15 text-white flex items-center justify-center transition"><Icon name="chevron-right" size={14} /></button>
          </div>
        </div>
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1.5">
          {products.map((_, i) => (
            <button key={i} aria-label={'slide ' + (i + 1)} onClick={() => setIdx(i)}
              className={`h-1.5 rounded-full transition-all ${i === idx ? 'w-4 bg-white' : 'w-1.5 bg-white/30 hover:bg-white/50'}`}></button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProductRail({ title, accent, products, onProduct, onBuy, onMore }) {
  if (!products || products.length === 0) return null;
  return (
    <section className="mt-8">
      <div className="flex items-center justify-between mb-3.5">
        <h2 className="text-lg font-bold text-white flex items-center gap-2">
          <Icon name="sparkles" size={18} className="text-arc-accent" />
          {title} <span className="text-arc-accent">{accent}</span>
        </h2>
        <button onClick={onMore} className="text-xs text-arc-muted hover:text-arc-text inline-flex items-center gap-1 transition">{tr('home.seeAll','See All')} <Icon name="chevron-right" size={14} /></button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
        {products.map(p => <ProductCard key={p.id} product={p} onBuy={onBuy} onOpen={() => onProduct(p)} />)}
      </div>
    </section>
  );
}

function Beranda({ onProduct, onBuy, onCat, goStore }) {
  const [q, setQ] = useState('');
  // C2 — hide sold-out items from Home (store pages keep them for the Sold-Out tab)
  const list = (window.PRODUCTS || []).filter(p => p.status !== 'soldout');
  const newest = list.slice(0, 10);
  const trending = useTrending(list.slice(0, 5));
  const submitSearch = () => { if (q.trim()) onCat('All', q); };
  // The slider replaces the static promo banner slot; keep all non-promo banners.
  const heroBanners = (typeof BANNERS !== 'undefined' ? BANNERS : []).filter(b => b.kind !== 'promo');

  return (
    <div className="anim-view">
      {/* hero: brand + trending slider */}
      <div className={`grid grid-cols-1 ${heroBanners.length > 0 ? 'lg:grid-cols-2' : ''} gap-4`}>
        {heroBanners.map(b => <HeroBanner key={b.id} banner={b} onCta={() => onCat('All', '')} />)}
        <TrendingSlider products={trending} onProduct={onProduct} onBuy={onBuy} />
      </div>

      {/* search */}
      <div className="mt-5 flex gap-2">
        <div className="relative flex-1">
          <Icon name="search" size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-arc-faint" />
          <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && submitSearch()}
            placeholder={tr('home.searchPh','Search products or stores…')}
            className="w-full bg-arc-surface/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl pl-11 pr-3 h-12 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
        </div>
        <Btn size="lg" onClick={submitSearch}>{tr('home.search','Search')}</Btn>
      </div>

      {/* categories */}
      <div className="mt-6">
        <h2 className="text-base font-bold text-white mb-3">{tr('home.cats','Browse')} <span className="text-arc-accent">{tr('home.catsAccent','Categories')}</span></h2>
        <div className="flex flex-wrap gap-2.5">
          {/* onCat gets c.cat — the real storefront category. Not c.id (an i18n
              key suffix) and not c.label, which used to be passed as a search
              query and matched nothing. */}
          {HOME_CATS.map(c => (
            <button key={c.id} onClick={() => onCat(c.cat, '')}
              className="group inline-flex items-center gap-2.5 bg-arc-surface/60 ring-1 ring-arc-border hover:ring-arc-primary/50 rounded-xl pl-3 pr-4 py-2.5 text-sm font-medium text-arc-text transition">
              <Icon name={c.icon} size={16} className="text-arc-accent" />
              {tr('home.cat.' + c.id, c.label)}
              <Icon name="arrow-right" size={14} className="text-arc-faint group-hover:translate-x-0.5 transition-transform" />
            </button>
          ))}
        </div>
      </div>

      {/* D2 — new products (window.PRODUCTS is newest-first) */}
      <ProductRail title={tr('home.railNewProducts','New Products')} accent="✨" products={newest} onProduct={onProduct} onBuy={onBuy} onMore={() => onCat('All', '')} />

      {/* D1 — trending products rail driven by the same sales-based list */}
      <ProductRail title={tr('home.railTrending','Trending Products')} accent="🔥" products={trending.slice(0, 5)} onProduct={onProduct} onBuy={onBuy} onMore={() => onCat('All', '')} />

      {list.length === 0 && (window.CATALOG_STATE || 'loading') === 'loading' && (
        <div className="text-center text-arc-faint py-20 text-sm">Loading catalog…</div>
      )}
      {list.length === 0 && window.CATALOG_STATE === 'error' && (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-center sf-fade-in">
          <div className="w-16 h-16 rounded-2xl bg-red-500/10 ring-1 ring-red-500/30 flex items-center justify-center">
            <Icon name="wifi-off" size={26} className="text-red-400" />
          </div>
          <div className="text-sm font-semibold text-arc-text">{tr('sf.loadError','Could not load the catalog.')}</div>
          <div className="text-xs text-arc-faint">{tr('sf.loadErrorHint','Check your connection — the server may be briefly unavailable.')}</div>
          <button onClick={() => window.loadCatalog && window.loadCatalog()}
            className="mt-1 inline-flex items-center gap-2 text-sm font-medium bg-arc-primary hover:bg-arc-primarydk text-white rounded-xl px-4 h-10 transition-all duration-200 shadow-glow hover:brightness-110">
            <Icon name="rotate-ccw" size={15} /> {tr('sf.retry','Retry')}
          </button>
        </div>
      )}

      {/* Platform counters + settled-order feed. Sits below the product rails so
          it reads as a summary of the marketplace, not as a competing hero. */}
      <HomePulse />
    </div>
  );
}

// ---------- Home pulse: platform counters + live transaction feed ----------
// Two public endpoints feed this block: /api/stats (aggregate counts) and
// /api/sales/recent (settled orders, buyer already anonymised server-side).
// Both are in PUBLIC_API_PREFIXES, because the strip has to work for a
// logged-out visitor — that is the whole point of showing it.
function PulseTile({ value, label, hint, tone, live }) {
  return (
    <div className="px-0 sm:px-5 sm:border-l sm:border-arc-border sm:first:border-l-0 sm:first:pl-0">
      <div className="flex items-center gap-1.5">
        {live && <PresenceDot online size={6} />}
        <span className={`text-[22px] sm:text-[26px] font-semibold tabular-nums leading-none ${tone || 'text-arc-text'}`}>
          {value}
        </span>
      </div>
      <div className="mt-2 text-[9.5px] font-medium uppercase tracking-[0.16em] text-arc-faint">{label}</div>
      {hint && <div className="mt-0.5 text-[10px] text-arc-faint/70 leading-snug">{hint}</div>}
    </div>
  );
}

function HomePulse() {
  const [stats, setStats] = useState(null);
  const [sales, setSales] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const API = window.SLIME_API || '';
      const [statsRes, salesRes] = await Promise.allSettled([
        fetch(API + '/api/stats', { credentials: 'include' }),
        fetch(API + '/api/sales/recent?limit=6', { credentials: 'include' }),
      ]);
      if (!alive) return;
      if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
        const d = await statsRes.value.json().catch(() => null);
        if (alive && d) setStats(d);
      }
      if (salesRes.status === 'fulfilled' && salesRes.value.ok) {
        const d = await salesRes.value.json().catch(() => null);
        if (alive && d && Array.isArray(d.items)) setSales(d.items);
      }
    };
    load();
    // The feed is the "is anything happening here" signal; 30s keeps it honest
    // without turning the home page into a polling loop.
    const timer = setInterval(load, 30000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const n = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
  const money = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  // "2h ago" beats "Oct 18, 05:30 PM" in a feed whose whole job is to look
  // current; the absolute time stays available on hover.
  const relTime = (iso) => {
    const t = Date.parse(iso || '');
    if (Number.isNaN(t)) return '';
    const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (mins < 1) return tr('pulse.now', 'now');
    if (mins < 60) return tr('pulse.mAgo', '{n}m ago').replace('{n}', String(mins));
    const h = Math.round(mins / 60);
    if (h < 24) return tr('pulse.hAgo', '{n}h ago').replace('{n}', String(h));
    const d = Math.round(h / 24);
    if (d < 7) return tr('pulse.dAgo', '{n}d ago').replace('{n}', String(d));
    return new Date(t).toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
  };

  return (
    <section className="mt-10">
      <div className="rounded-2xl ring-1 ring-arc-border bg-arc-surface overflow-hidden">
        <div className="h-[2px] bg-gradient-to-r from-arc-primary via-arc-accent to-emerald-400" />

        <div className="px-5 sm:px-6 pt-4 pb-5">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-arc-faint">
              <Icon name="activity" size={12} className="text-arc-accent" />
              {tr('pulse.title', 'Network pulse')}
            </span>
            <span className="text-[10px] font-mono uppercase tracking-wider text-arc-faint">ARC MAINNET · 5042</span>
          </div>

          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-y-5">
            <PulseTile value={n(stats && stats.members)} label={tr('pulse.members', 'Members')} hint={tr('pulse.membersHint', 'registered accounts')} />
            <PulseTile value={n(stats && stats.sellers)} label={tr('pulse.sellers', 'Sellers')} hint={tr('pulse.sellersHint', 'with a storefront')} />
            <PulseTile value={n(stats && stats.sales)} label={tr('pulse.sales', 'Sales')} hint={tr('pulse.salesHint', 'orders settled')} />
            <PulseTile
              value={n(stats && stats.online)}
              label={tr('pulse.online', 'Online now')}
              hint={tr('pulse.onlineHint', 'active in the last 2 min')}
              live={!!(stats && stats.online > 0)}
              tone={stats && stats.online > 0 ? 'text-emerald-300' : undefined}
            />
          </div>
        </div>

        <div className="border-t border-arc-border px-5 sm:px-6 py-4 bg-arc-bg/30">
          <div className="flex items-center justify-between gap-3 mb-2">
            <span className="inline-flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-arc-faint">
              <Icon name="receipt" size={12} className="text-arc-accent" />
              {tr('pulse.liveTitle', 'Live transactions')}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
              <PresenceDot online size={5} /> {tr('pulse.live', 'live')}
            </span>
          </div>

          {sales && sales.length > 0 ? (
            <ul className="divide-y divide-arc-border/50">
              {sales.map((sale) => (
                <li key={sale.id} className="flex items-center gap-3 py-2 sf-fade-in">
                  <Icon name="check" size={12} className="text-emerald-400/80 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-arc-text">{sale.productName}</span>
                  <span className="hidden sm:inline text-[11px] text-arc-faint truncate max-w-[10rem]">{sale.storeName}</span>
                  <span className="font-mono text-[11px] tabular-nums text-emerald-300 shrink-0">{money(sale.amount)} <span className="text-emerald-300/60">USDC</span></span>
                  <span title={sale.time} className="w-[3.5rem] whitespace-nowrap text-right text-[10px] font-mono text-arc-faint shrink-0">{relTime(sale.createdAt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="py-3 text-[11px] text-arc-faint">
              {sales === null ? tr('pulse.loading', 'Loading transactions…') : tr('pulse.empty', 'No settled orders yet — be the first.')}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------- Site footer ----------
function SiteFooter() {
  const go = (view, params) => {
    if (!window.SlimeRouter) return;
    window.SlimeRouter.pushPath(view, params || {});
    window.dispatchEvent(new PopStateEvent('popstate'));
    window.scrollTo && window.scrollTo(0, 0);
  };
  const link = 'text-left text-[12px] text-arc-muted hover:text-arc-text transition';
  return (
    <footer className="mt-12 border-t border-arc-border">
      <div className="max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-9">
        <div className="flex flex-col md:flex-row gap-8">
          <div className="md:max-w-[19rem]">
            <div className="flex items-center gap-2">
              <SlimeLogo size={24} />
              <span className="font-bold text-arc-text">SlimeMarket</span>
            </div>
            <p className="mt-2.5 text-[12px] leading-relaxed text-arc-muted">
              {tr('footer.tagline', 'Peer-to-peer marketplace where a smart contract replaces the human middleman. Buyer funds and seller collateral are locked in USDC on Arc.')}
            </p>
          </div>

          <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 gap-6">
            <div>
              <div className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-arc-faint mb-2.5">{tr('footer.marketplace', 'Marketplace')}</div>
              <div className="flex flex-col gap-1.5">
                <button className={link} onClick={() => go('storefront')}>{tr('nav.storefront', 'Explore')}</button>
                <button className={link} onClick={() => go('beranda')}>{tr('nav.beranda', 'Home')}</button>
                <button className={link} onClick={() => go('seller')}>{tr('nav.seller', 'Seller Center')}</button>
              </div>
            </div>
            <div>
              <div className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-arc-faint mb-2.5">{tr('footer.trust', 'Trust')}</div>
              <div className="flex flex-col gap-1.5">
                <button className={link} onClick={() => go('escrow')}>{tr('nav.rekber', 'Escrow')}</button>
                <a className={link} href="https://explorer.arc.io/address/0xfe76c63289dd8b5693277df261e4938bd8779d28" target="_blank" rel="noreferrer">
                  {tr('footer.contract', 'Escrow contract')}
                </a>
                <a className={link} href="https://github.com/SlimeMarket/slimemarket" target="_blank" rel="noreferrer">
                  {tr('footer.source', 'Source code')}
                </a>
              </div>
            </div>
            <div>
              <div className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-arc-faint mb-2.5">{tr('footer.network', 'Network')}</div>
              <div className="flex flex-col gap-1.5 text-[12px] text-arc-muted">
                <span className="inline-flex items-center gap-1.5"><PresenceDot online size={5} /> Arc mainnet · 5042</span>
                <span className="font-mono text-[11px] text-arc-faint">USDC gas · 6 dp</span>
                <span className="font-mono text-[11px] text-arc-faint">escrow 0xfe76…9d28</span>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-7 pt-4 border-t border-arc-border/60 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-arc-faint">
          <span>© 2026 SlimeMarket</span>
          <span className="hidden sm:inline text-arc-border">·</span>
          <span>{tr('footer.note', 'Not audited. Trade small while you learn the flow.')}</span>
          <span className="ml-auto font-mono uppercase tracking-wider">Built on Arc · settled in USDC</span>
        </div>
      </div>
    </footer>
  );
}

Object.assign(window, { Beranda, HomePulse, SiteFooter });
