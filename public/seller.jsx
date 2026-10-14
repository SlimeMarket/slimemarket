// ============ View 5: Seller Center ============
// .C1: "My Store" removed; the profile IS the storefront.
// Income dashboard + enhanced transaction log (shadcn/ui + recharts patterns):
//  - Income tab: 4 stat cards (This/Last/All-time/Avg) with skeleton loading,
//    monthly revenue BarChart, top-5 products, order-status PieChart,
//    date-range selector + CSV export.
//  - Orders table: full-text search, date-range + amount + status filters,
//    sortable columns, 20/page pagination, CSV export, row-click detail modal,
//    skeleton loading rows (no spinners).
//  - Premium card styles: ring borders, hover-lift, staggered fade-in.

function SellerCenter({ orders, onAdvance, onDecline, onOpenOrder, earnings, forumBalance, products, setProducts, notify, onChat }) {
  const [tab, setTab] = useState('ringkasan');
  const [ostab, setOstab] = useState('all');
  const active = orders.filter(o => ['PENDING', 'PROCESS', 'SENT'].includes(o.status)).length;
  const disputes = orders.filter(o => o.status === 'DISPUTED').length;
  const OSTABS = [
    ['all', tr('c.all','All'), null],
    ['PENDING', tr('sel.incoming','Incoming'), 'PENDING'],
    ['PROCESS', tr('ord.inProgress','In Progress'), 'PROCESS'],
    ['SENT', tr('sel.sent','Sent'), 'SENT'],
    ['DONE', tr('ord.completed','Completed'), 'DONE'],
  ];
  const oCount = (st) => st ? orders.filter(o => o.status === st).length : orders.length;
  const visibleOrders = ostab === 'all' ? orders : orders.filter(o => o.status === ostab);
  const doneOrders = orders.filter(o => o.status === 'DONE');
  const totalSales = doneOrders.length;
  const ratedOrders = doneOrders.filter(o => o.review && o.review.rating);
  const avgRating = ratedOrders.length > 0
    ? (ratedOrders.reduce((s, o) => s + o.review.rating, 0) / ratedOrders.length).toFixed(1)
    : '\u2014';

  return (
    <div className="anim-view">
      <div className="flex items-center gap-2.5 mb-5 flex-wrap">
        <h1 className="text-xl font-bold text-white">{tr('sel.title','Seller Center')}</h1>
        <PixBadge color="amber">{((typeof ME !== 'undefined' && ME.role) || 'Seller').toUpperCase()}</PixBadge>
        <span className="text-xs text-arc-faint inline-flex items-center gap-1.5"><Icon name="lock" size={12} /> {tr('sel.accessNote','Seller & Admin only')}</span>
      </div>

      {/* tabs — Summary / Income / Products */}
      <div className="flex items-center gap-1 mb-5 border-b border-arc-border overflow-x-auto">
        {[['ringkasan', 'layout-dashboard', tr('sel.summary','Summary')], ['income', 'bar-chart-3', tr('sel.income','Income')], ['produk', 'package', tr('sel.products','My Products')]].map(([id, ic, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition whitespace-nowrap ${tab === id ? 'border-arc-primary text-arc-accent' : 'border-transparent text-arc-muted hover:text-arc-text'}`}>
            <Icon name={ic} size={15} /> {label}
          </button>
        ))}
      </div>

      {tab === 'produk' && <ProductManager products={products} setProducts={setProducts} notify={notify} />}
      {tab === 'income' && <IncomeDashboard orders={orders} earnings={earnings} products={products} notify={onOpenOrder ? notify : null} />}
      {tab === 'ringkasan' && (
      <>
      {/* balance cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
        {/* wallet balance */}
        <div className="relative overflow-hidden rounded-2xl ring-1 ring-emerald-500/25 bg-gradient-to-br from-emerald-600/15 via-arc-surface to-arc-surface p-5 hover-lift transition-all">
          <div className="absolute -right-4 -bottom-4 opacity-10"><Icon name="wallet" size={120} className="text-emerald-400" /></div>
          <div className="relative">
            <div className="text-[11px] uppercase tracking-wide text-emerald-300/80 flex items-center gap-1.5"><Icon name="wallet" size={13} /> {tr('sel.walletBalance','Wallet Balance')}</div>
            <div className="mt-2"><Usdc value={earnings} className="text-3xl font-bold text-emerald-300" /></div>
            {/* there is no withdraw step in the on-chain flow: escrow
                releases pay this wallet directly, and refunds return to the
                buyer directly. The button (and the whole custodial branch) is
                gone; the card is a read-out, not an action. */}
            <div className="text-[11px] text-arc-muted mt-1">{tr('sel.earningsNoteOnchain','On-chain USDC · ARC · includes faucet + sales revenue')}</div>
            <div className="mt-4 text-[11px] text-emerald-300/80 inline-flex items-center gap-1.5 bg-emerald-500/10 ring-1 ring-emerald-500/25 rounded-lg px-2.5 py-1.5"><Icon name="shield-check" size={13} /> {tr('sel.paidAtRelease','Funds land in your wallet when escrow releases — no manual withdraw needed.')}</div>
          </div>
        </div>
        {/* forum — paid threads disabled */}
        <div className="relative overflow-hidden rounded-2xl ring-1 ring-arc-border bg-arc-surface/40 p-5 hover-lift transition-all">
          <div className="absolute -right-4 -bottom-4 opacity-[0.06]"><Icon name="book-open" size={120} className="text-arc-muted" /></div>
          <div className="relative">
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wide text-arc-faint flex items-center gap-1.5"><Icon name="book-text" size={13} /> {tr('sel.forumBalance','Forum Balance')}</div>
              <PixBadge color="slate">SOON</PixBadge>
            </div>
            <div className="mt-2 text-3xl font-bold text-arc-faint font-mono">—</div>
            <div className="text-[11px] text-arc-faint mt-1">{tr('sel.forumDisabled','Paid threads are temporarily disabled.')}</div>
            <Btn variant="subtle" full className="mt-4 opacity-60" icon="lock" disabled>{tr('sel.claimForum','Claim Forum Balance')}</Btn>
          </div>
        </div>
        {/* stats */}
        <div className="rounded-2xl ring-1 ring-arc-border bg-arc-surface/60 p-5 grid grid-cols-2 gap-3 content-start hover-lift transition-all">
          <Stat icon="package" label={tr('sel.activeOrders','Active Orders')} value={active} color="cyan" />
          <Stat icon="gavel" label={tr('ord.disputes','Disputes')} value={disputes} color="rose" />
          <Stat icon="star" label={tr('sel.rating','Rating')} value={avgRating} color="amber" />
          <Stat icon="badge-check" label={tr('sel.totalSales','Total Sales')} value={totalSales} color="emerald" />
        </div>
      </div>

      {/* orders table — upgraded with search, filters, sort, pagination */}
      <EnhancedOrdersTable
        orders={visibleOrders}
        ostab={ostab}
        setOstab={setOstab}
        OSTABS={OSTABS}
        oCount={oCount}
        onAdvance={onAdvance}
        onDecline={onDecline}
        onOpenOrder={onOpenOrder}
        onChat={onChat}
      />
      </>
      )}
    </div>
  );
}

// ============ Income Dashboard tab ============
// Skeleton loading (no spinners), 4 stat cards, monthly BarChart, top-5
// products by revenue, status PieChart, date-range selector + CSV export.
function IncomeDashboard({ orders = [], earnings = 0, products = [], notify, onOpenOrder }) {
  // Skeleton gate: orders take a beat to arrive from /api/my/orders.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { const t = setTimeout(() => setLoaded(true), 600); return () => clearTimeout(t); }, []);
  useEffect(() => { if ((orders || []).length > 0) setLoaded(true); }, [orders]);

  // ---- date-range filter ----
  const RANGES = [['30d','Last 30 days'],['90d','Last 90 days'],['12m','Last 12 months'],['ytd','Year to date'],['all','All time']];
  const [range, setRange] = useState('12m');
  const [rangeOpen, setRangeOpen] = useState(false);
  useEffect(() => { setRangeOpen(false); }, [range]);

  // ---- revenue computations (defensive against missing fields) ----
  const doneOrReleased = orders.filter(o => ['DONE','SENT','RELEASED','COMPLETED'].includes(o.status));
  // marketplace orders carry a 2% SELLER fee deducted at release, so
  // the gross order amount is NOT what the seller received. Every figure below
  // is derived from these two so the dashboard can show gross vs net honestly.
  const SELLER_NET_RATE = 0.98;
  const grossOf = (list) => list.reduce((s, o) => s + (Number(o.amount) || 0), 0);
  const netOf = (gross) => gross * SELLER_NET_RATE;
  const allTimeGross = grossOf(doneOrReleased);
  const allTime = netOf(allTimeGross); // NET — what actually lands in the wallet

  // Build last-12-months buckets from order createdAt/time. No synthetic
  // fallback: if there are no timestamped orders, the chart shows an empty
  // state instead of invented bars.
  const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const buildMonthly = (list) => {
    const now = new Date();
    const buckets = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({ key: d.getFullYear() + '-' + d.getMonth(), month: monthLabels[d.getMonth()], revenue: 0, orders: 0 });
    }
    list.forEach(o => {
      const ts = o.createdAt || o.time || o.date;
      const d = ts ? new Date(ts) : null;
      if (!d || isNaN(d.getTime())) return;
      const key = d.getFullYear() + '-' + d.getMonth();
      const b = buckets.find(x => x.key === key);
      if (b) { b.revenue += (Number(o.amount) || 0) * SELLER_NET_RATE; b.orders += 1; }
    });
    return buckets;
  };
  const monthly = buildMonthly(doneOrReleased);
  const hasMonthlyData = monthly.some(m => m.orders > 0 || m.revenue > 0);
  let run = 0;
  const cumulative = monthly.map(m => { run += m.revenue; return { month: m.month, cumulative: Math.round(run * 100) / 100 }; });

  // This month / last month totals (for stat cards + % change).
  const now = new Date();
  const thisKey = now.getFullYear() + '-' + now.getMonth();
  const lastKey = (now.getMonth() === 0 ? (now.getFullYear() - 1) + '-11' : now.getFullYear() + '-' + (now.getMonth() - 1));
  const thisMonth = monthly.find(m => m.key === thisKey)?.revenue || 0;
  const lastMonth = monthly.find(m => m.key === lastKey)?.revenue || 0;
  const avgOrder = doneOrReleased.length > 0 ? allTime / doneOrReleased.length : 0;  const change = window.Fmt ? window.Fmt.formatPercentageChange(thisMonth, lastMonth) : { isPositive: true, display: '0%', symbol: '\u2014' };

  // ---- top 5 products by revenue ----
  const prodRevenue = {};
  doneOrReleased.forEach(o => { const n = o.product || o.title || 'Unknown'; prodRevenue[n] = (prodRevenue[n] || 0) + (Number(o.amount) || 0); });
  const topProducts = Object.entries(prodRevenue).map(([name, rev]) => ({ name, revenue: rev })).sort((a, b) => b.revenue - a.revenue).slice(0, 5);
  const maxRev = topProducts.length > 0 ? topProducts[0].revenue : 1;

  // ---- order status breakdown (pie) ----
  const statusCounts = {};
  orders.forEach(o => { statusCounts[o.status] = (statusCounts[o.status] || 0) + 1; });
  const pieColors = (window.INCOME_CHART_COLORS || {}).STATUS_COLORS || {};
  const pieData = Object.entries(statusCounts).map(([name, value]) => ({ name, value, color: pieColors[name] || '#8A9BB8' }));

  // ---- CSV export ----
  const exportCsv = () => {
    if (!window.Fmt) { notify && notify('Export unavailable (format module missing)', 'error'); return; }
    const rows = doneOrReleased.map(o => ({ id: o.id, date: o.createdAt || o.time || o.date || '', product: o.product || o.title || '', buyer: o.buyer || '', status: o.status, amount: Number(o.amount) || 0 }));
    const ok = window.Fmt.exportToCsv('slimemarket-income-' + new Date().toISOString().slice(0,10) + '.csv', rows, [
      { key: 'id', label: 'Order ID' }, { key: 'date', label: 'Date' }, { key: 'product', label: 'Product' },
      { key: 'buyer', label: 'Buyer' }, { key: 'status', label: 'Status' }, { key: 'amount', label: 'Amount (USDC)' },
    ]);
    notify && notify(ok ? 'Income CSV exported' : 'No data to export', ok ? 'success' : 'info');
  };

  return (
    <div className="space-y-5">
      {/* toolbar: date range + export */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <button onClick={() => setRangeOpen(o => !o)} className="inline-flex items-center gap-2 h-10 px-3.5 rounded-xl bg-arc-surface/60 ring-1 ring-arc-border hover:ring-arc-primary/50 text-sm text-arc-text transition">
            <Icon name="calendar" size={15} className="text-arc-accent" />
            <span>{RANGES.find(r => r[0] === range)?.[1] || 'All time'}</span>
            <Icon name="chevron-down" size={14} className={`text-arc-faint transition-transform ${rangeOpen ? 'rotate-180' : ''}`} />
          </button>
          {rangeOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setRangeOpen(false)} />
              <div className="absolute left-0 mt-2 z-40 w-48 bg-arc-surface2 ring-1 ring-arc-borderlt rounded-xl shadow-2xl overflow-hidden anim-modal">
                {RANGES.map(([id, label]) => (
                  <button key={id} onClick={() => setRange(id)} className={`w-full flex items-center gap-2 px-3.5 py-2.5 text-sm transition ${range === id ? 'bg-arc-primary/15 text-arc-accent' : 'text-arc-text hover:bg-arc-surface'}`}>
                    <Icon name={range === id ? 'check' : 'calendar'} size={14} className={range === id ? 'text-arc-accent' : 'text-arc-faint'} /> {label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <Btn variant="outline" size="md" icon="download" className="ml-auto" onClick={exportCsv}>{tr('sel.exportCsv','Export CSV')}</Btn>
      </div>

      {/* 4 stat cards with skeleton loading. revenue is reported as
          GROSS (order value) and NET (after the 2% platform fee) so the seller
          can see their real margin, not just turnover. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <IncomeStatCard loaded={loaded} icon="calendar-clock" label={tr('sel.thisMonthNet','This Month (net)')} value={thisMonth} isUsdc change={change} delay={0} />
        <IncomeStatCard loaded={loaded} icon="calendar-minus" label={tr('sel.lastMonthNet','Last Month (net)')} value={lastMonth} isUsdc delay={60} />
        <IncomeStatCard loaded={loaded} icon="infinity" label={tr('sel.allTimeGross','All-Time Gross')} value={allTimeGross} isUsdc delay={120} />
        <IncomeStatCard loaded={loaded} icon="wallet" label={tr('sel.allTimeNet','All-Time Net (98%)')} value={allTime} isUsdc delay={180} />
      </div>

      {/* gross → fee → net breakdown */}
      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl ring-1 ring-arc-border bg-arc-surface/50 px-4 py-3 text-xs">
        <span className="text-arc-muted">{tr('sel.grossLabel','Gross sales')}: <Usdc value={allTimeGross} className="text-arc-text" /></span>
        <span className="text-arc-muted">{tr('sel.platformFee2','Platform fee (2%)')}: <Usdc value={allTimeGross - allTime} className="text-rose-300" /></span>
        <span className="text-arc-muted">{tr('sel.netLabel','You received')}: <Usdc value={allTime} className="text-emerald-300" /></span>
        <span className="text-arc-faint ml-auto">{tr('sel.avgOrderNet','Avg order (net)')}: <Usdc value={avgOrder} className="text-arc-text" /></span>
      </div>

      {/* BarChart: monthly revenue */}
      <Card className="p-5 hover-lift transition-all">
        <div className="flex items-center gap-2 mb-4">
          <Icon name="bar-chart-3" size={16} className="text-emerald-400" />
          <span className="text-sm font-semibold text-arc-text">{tr('sel.monthlyRevenue','Monthly Revenue')}</span>
          <span className="ml-auto text-[11px] text-arc-faint">{tr('sel.netAfterFee','net after 2% fee')} · USDC</span>
        </div>
        {loaded ? (hasMonthlyData ? <MonthlyRevenueBarChart data={monthly} height={280} /> : (
          <div className="h-[280px] flex flex-col items-center justify-center gap-2 text-center">
            <div className="w-12 h-12 rounded-2xl bg-arc-surface2 flex items-center justify-center"><Icon name="bar-chart-3" size={22} className="text-arc-faint" /></div>
            <div className="text-sm text-arc-muted">{tr('sel.noSalesData','No sales data yet')}</div>
          </div>
        )) : <div className="h-[280px] rounded-xl bg-arc-surface2/40 ring-1 ring-arc-border/60 animate-pulse" />}
      </Card>

      {/* two-column: top products + status pie */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-5 hover-lift transition-all">
          <div className="flex items-center gap-2 mb-4">
            <Icon name="trophy" size={16} className="text-amber-400" />
            <span className="text-sm font-semibold text-arc-text">{tr('sel.topProducts','Top Products by Revenue')}</span>
          </div>
          {loaded ? (topProducts.length > 0 ? (
            <div className="space-y-2.5">
              {topProducts.map((p, i) => (
                <div key={i} className="group">
                  <div className="flex items-center gap-2 text-sm mb-1">
                    <span className="w-5 h-5 rounded-md bg-arc-surface2 ring-1 ring-arc-border text-[10px] font-mono text-arc-muted flex items-center justify-center shrink-0">{i + 1}</span>
                    <span className="text-arc-text font-medium truncate flex-1">{p.name}</span>
                    <Usdc value={p.revenue} className="text-emerald-400 font-semibold shrink-0" />
                  </div>
                  <div className="h-1.5 rounded-full bg-arc-surface2 overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-emerald-500 to-emerald-300 rounded-full transition-all duration-500 group-hover:brightness-110" style={{ width: (p.revenue / maxRev * 100) + '%' }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <div className="w-12 h-12 rounded-2xl bg-arc-surface2 flex items-center justify-center"><Icon name="package-open" size={22} className="text-arc-faint" /></div>
              <div className="text-sm text-arc-muted">{tr('sel.noRevenueYet','No completed sales yet.')}</div>
            </div>
          )) : (
            <div className="space-y-2.5">{[0,1,2,3,4].map(i => <div key={i} className="h-8 rounded-lg bg-arc-surface2/40 ring-1 ring-arc-border/60 animate-pulse" />)}</div>
          )}
        </Card>

        <Card className="p-5 hover-lift transition-all">
          <div className="flex items-center gap-2 mb-4">
            <Icon name="pie-chart" size={16} className="text-arc-accent" />
            <span className="text-sm font-semibold text-arc-text">{tr('sel.orderStatusBreakdown','Order Status Breakdown')}</span>
          </div>
          {loaded ? <OrderStatusPieChart data={pieData} height={240} /> : (
            <div className="flex items-center justify-center h-[240px]"><div className="w-32 h-32 rounded-full bg-arc-surface2/40 ring-1 ring-arc-border/60 animate-pulse" /></div>
          )}
        </Card>
      </div>

      {/* cumulative area chart */}
      <Card className="p-5 hover-lift transition-all">
        <div className="flex items-center gap-2 mb-4">
          <Icon name="trending-up" size={16} className="text-emerald-400" />
          <span className="text-sm font-semibold text-arc-text">{tr('sel.cumulativeRevenue','Cumulative Revenue Trend')}</span>
        </div>
        {loaded ? (hasMonthlyData ? <CumulativeRevenueAreaChart data={cumulative} height={240} /> : (
          <div className="h-[240px] flex flex-col items-center justify-center gap-2 text-center">
            <div className="w-12 h-12 rounded-2xl bg-arc-surface2 flex items-center justify-center"><Icon name="trending-up" size={22} className="text-arc-faint" /></div>
            <div className="text-sm text-arc-muted">{tr('sel.noSalesData','No sales data yet')}</div>
          </div>
        )) : <div className="h-[240px] rounded-xl bg-arc-surface2/40 ring-1 ring-arc-border/60 animate-pulse" />}
      </Card>
    </div>
  );
}

// ---- Income stat card with skeleton loading + % change badge ----
function IncomeStatCard({ loaded, icon, label, value, isUsdc, change, delay = 0 }) {
  return (
    <div className="relative overflow-hidden rounded-2xl ring-1 ring-arc-border bg-arc-surface/60 p-4 hover-lift transition-all" style={{ animationDelay: delay + 'ms' }}>
      <div className="flex items-center gap-2 mb-2">
        <span className="w-7 h-7 rounded-lg bg-arc-surface2 ring-1 ring-arc-border flex items-center justify-center shrink-0">
          <Icon name={icon} size={14} className="text-arc-accent" />
        </span>
        <span className="text-[11px] uppercase tracking-wide text-arc-faint">{label}</span>
        {change && (
          <span className={`ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded ${change.isPositive ? 'bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/25' : 'bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/25'}`}>
            {change.symbol} {change.display}
          </span>
        )}
      </div>
      {loaded ? (
        isUsdc ? <Usdc value={value} className="text-2xl font-bold text-arc-text tabular-nums" /> : <div className="text-2xl font-bold text-arc-text tabular-nums">{value}</div>
      ) : (
        <div className="h-8 w-24 rounded-lg bg-arc-surface2/50 animate-pulse" />
      )}
    </div>
  );
}

// ============ Enhanced Orders Table ============
// Upgraded from the bare table: full-text search (order ID, buyer, product),
// advanced filters (date range, amount range, status multi-select), column
// sorting (date/amount/status/buyer), 20/page pagination, CSV export of the
// filtered result, row-click → order detail modal, and skeleton loading rows
// (no spinners).
function EnhancedOrdersTable({ orders, ostab, setOstab, OSTABS, oCount, onAdvance, onDecline, onOpenOrder, onChat }) {
  // ---- skeleton gate ----
  const [loaded, setLoaded] = useState(false);
  useEffect(() => { const t = setTimeout(() => setLoaded(true), 500); return () => clearTimeout(t); }, []);
  useEffect(() => { if ((orders || []).length > 0) setLoaded(true); }, [orders]);

  // ---- search (full text: id, buyer, product) ----
  const [q, setQ] = useState('');
  // ---- advanced filters ----
  const [filterOpen, setFilterOpen] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [amtMin, setAmtMin] = useState('');
  const [amtMax, setAmtMax] = useState('');
  const [statusSel, setStatusSel] = useState([]); // multi-select
  const toggleStatus = (s) => setStatusSel(sel => sel.includes(s) ? sel.filter(x => x !== s) : [...sel, s]);
  const clearFilters = () => { setDateFrom(''); setDateTo(''); setAmtMin(''); setAmtMax(''); setStatusSel([]); };
  const activeFilterCount = (dateFrom?1:0) + (dateTo?1:0) + (amtMin?1:0) + (amtMax?1:0) + statusSel.length;

  // ---- sorting ----
  // sortKey: 'date' | 'amount' | 'status' | 'buyer' | 'id'
  // sortDir: 'asc' | 'desc'
  const [sortKey, setSortKey] = useState('date');
  const [sortDir, setSortDir] = useState('desc');
  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  // ---- pagination (20/page) ----
  const PER_PAGE = 20;
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, ostab, sortKey, sortDir, dateFrom, dateTo, amtMin, amtMax, statusSel.join(',')]);

  // ---- order detail modal (row click) ----
  const [detailOrder, setDetailOrder] = useState(null);

  // ---- derive the filtered + sorted list (memoized-lite) ----
  const ql = q.trim().toLowerCase();
  const filtered = (orders || []).filter(o => {
    // full-text search across id, buyer, product
    if (ql) {
      const hay = ((o.id||'') + ' ' + (o.buyer||'') + ' ' + (o.product||'') + ' ' + (o.title||'')).toLowerCase();
      if (!hay.includes(ql)) return false;
    }
    // status multi-select (empty = all)
    if (statusSel.length > 0 && !statusSel.includes(o.status)) return false;
    // amount range
    const amt = Number(o.amount) || 0;
    if (amtMin && amt < parseFloat(amtMin)) return false;
    if (amtMax && amt > parseFloat(amtMax)) return false;
    // date range (compare against createdAt/time/date — best-effort)
    const ts = o.createdAt || o.time || o.date;
    const d = ts ? new Date(ts) : null;
    if (dateFrom && (!d || isNaN(d.getTime()) || d < new Date(dateFrom))) return false;
    if (dateTo && (!d || isNaN(d.getTime()) || d > new Date(dateTo + 'T23:59:59'))) return false;
    return true;
  });
  // sort
  const sorted = filtered.slice().sort((a, b) => {
    let av, bv;
    if (sortKey === 'amount') { av = Number(a.amount) || 0; bv = Number(b.amount) || 0; }
    else if (sortKey === 'status') { av = a.status || ''; bv = b.status || ''; }
    else if (sortKey === 'buyer') { av = a.buyer || ''; bv = b.buyer || ''; }
    else if (sortKey === 'id') { av = a.id || ''; bv = b.id || ''; }
    else { // date (default)
      av = new Date(a.createdAt || a.time || a.date || 0).getTime() || 0;
      bv = new Date(b.createdAt || b.time || b.date || 0).getTime() || 0;
    }
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
  const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  const curPage = Math.min(page, totalPages);
  const pageStart = (curPage - 1) * PER_PAGE;
  const pageItems = sorted.slice(pageStart, pageStart + PER_PAGE);

  // ---- CSV export of filtered results ----
  const exportCsv = () => {
    if (!window.Fmt) return;
    const rows = sorted.map(o => ({ id: o.id, date: o.createdAt || o.time || o.date || '', product: o.product || o.title || '', buyer: o.buyer || '', status: o.status, amount: Number(o.amount) || 0 }));
    const ok = window.Fmt.exportToCsv('slimemarket-orders-' + new Date().toISOString().slice(0,10) + '.csv', rows, [
      { key: 'id', label: 'Order ID' }, { key: 'date', label: 'Date' }, { key: 'product', label: 'Product' },
      { key: 'buyer', label: 'Buyer' }, { key: 'status', label: 'Status' }, { key: 'amount', label: 'Amount (USDC)' },
    ]);
  };

  // sortable column header
  const SortHdr = ({ label, k, align = 'left', className = '' }) => (
    <th className={`font-medium px-3 py-3 select-none cursor-pointer hover:text-arc-text transition ${align === 'right' ? 'text-right' : ''} ${className}`} onClick={() => toggleSort(k)}>
      <span className="inline-flex items-center gap-1">
        {label}
        <Icon name={sortKey === k ? (sortDir === 'asc' ? 'chevron-up' : 'chevron-down') : 'chevrons-up-down'} size={12} className={sortKey === k ? 'text-arc-accent' : 'text-arc-faint/50'} />
      </span>
    </th>
  );

  return (
    <Card className="overflow-hidden hover-lift transition-all">
      {/* header */}
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-arc-border flex-wrap">
        <Icon name="inbox" size={16} className="text-arc-accent" />
        <span className="text-sm font-semibold text-arc-text">{tr('sel.orders','Orders')}</span>
        <span className="ml-auto text-xs text-arc-faint tabular-nums">{sorted.length} {tr('sel.ordersUnit','orders')}</span>
      </div>

      {/* status sub-tabs */}
      <div className="flex items-center gap-1 px-3 pt-3 overflow-x-auto">
        {OSTABS.map(([id, label, st]) => (
          <button key={id} onClick={() => setOstab(id)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium whitespace-nowrap transition ${ostab === id ? 'bg-arc-primary text-white shadow-glow' : 'bg-arc-surface2/60 text-arc-muted hover:text-arc-text'}`}>
            {label}
            <span className={`text-[10px] font-pixel px-1 py-0.5 rounded ${ostab === id ? 'bg-white/20 text-white' : 'bg-arc-surface/70 text-arc-faint'}`}>{oCount(st)}</span>
          </button>
        ))}
      </div>

      {/* toolbar: search + filter + export */}
      <div className="flex items-center gap-2 px-3 py-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Icon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-arc-faint" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={tr('sel.searchOrders','Search order ID, buyer, product…')}
            className="w-full bg-arc-surface/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl pl-9 pr-3 h-10 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
        </div>
        <div className="relative">
          <button onClick={() => setFilterOpen(o => !o)}
            className={`inline-flex items-center gap-2 h-10 px-3.5 rounded-xl ring-1 text-sm transition ${activeFilterCount > 0 ? 'ring-arc-primary/50 bg-arc-primary/10 text-arc-accent' : 'ring-arc-border bg-arc-surface/60 text-arc-muted hover:text-arc-text'}`}>
            <Icon name="sliders-horizontal" size={15} /> {tr('sel.filters','Filters')}
            {activeFilterCount > 0 && <span className="text-[10px] font-mono bg-arc-primary text-white rounded-full w-4 h-4 flex items-center justify-center">{activeFilterCount}</span>}
          </button>
          {filterOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setFilterOpen(false)} />
              <div className="absolute right-0 mt-2 z-40 w-72 bg-arc-surface2 ring-1 ring-arc-borderlt rounded-2xl shadow-2xl p-4 anim-modal">
                <div className="flex items-center gap-2 mb-3">
                  <Icon name="sliders-horizontal" size={14} className="text-arc-accent" />
                  <span className="text-sm font-semibold text-arc-text">{tr('sel.advancedFilters','Advanced Filters')}</span>
                  {activeFilterCount > 0 && <button onClick={clearFilters} className="ml-auto text-[11px] text-rose-400 hover:text-rose-300 inline-flex items-center gap-1"><Icon name="x" size={11} /> Clear</button>}
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="text-[11px] uppercase tracking-wide text-arc-faint">{tr('sel.dateRange','Date Range')}</label>
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="flex-1 bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-lg px-2.5 h-9 text-xs text-arc-text outline-none transition" />
                      <Icon name="arrow-right" size={12} className="text-arc-faint shrink-0" />
                      <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="flex-1 bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-lg px-2.5 h-9 text-xs text-arc-text outline-none transition" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] uppercase tracking-wide text-arc-faint">{tr('sel.amountRange','Amount Range (USDC)')}</label>
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <input value={amtMin} onChange={e => setAmtMin(e.target.value.replace(/[^0-9.]/g,''))} placeholder="Min" className="flex-1 bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-lg px-2.5 h-9 text-xs text-arc-text placeholder-arc-faint outline-none font-mono transition" />
                      <Icon name="minus" size={12} className="text-arc-faint shrink-0" />
                      <input value={amtMax} onChange={e => setAmtMax(e.target.value.replace(/[^0-9.]/g,''))} placeholder="Max" className="flex-1 bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-lg px-2.5 h-9 text-xs text-arc-text placeholder-arc-faint outline-none font-mono transition" />
                    </div>
                  </div>
                  <div>
                    <label className="text-[11px] uppercase tracking-wide text-arc-faint">{tr('sel.statusMulti','Status')}</label>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {['PENDING','PROCESS','SENT','DONE','DISPUTED','DECLINED'].map(s => (
                        <button key={s} onClick={() => toggleStatus(s)}
                          className={`text-[10px] font-medium rounded-md px-2 py-1 ring-1 transition ${statusSel.includes(s) ? 'bg-arc-primary/20 text-arc-accent ring-arc-primary' : 'bg-arc-surface/60 text-arc-muted ring-arc-border hover:ring-arc-borderlt'}`}>
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
        <Btn variant="outline" size="sm" icon="download" onClick={exportCsv}>{tr('sel.exportCsv','Export CSV')}</Btn>
      </div>

      {/* table */}
      <div className="overflow-x-auto mt-1">
        <table className="w-full text-sm min-w-[760px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-arc-faint border-b border-arc-border">
              <SortHdr label={tr('sel.orderId','Order ID')} k="id" className="px-5" />
              <th className="font-medium px-3 py-3">{tr('sel.product','Product')}</th>
              <SortHdr label={tr('sel.buyer','Buyer')} k="buyer" />
              <SortHdr label={tr('sel.statusCol','Status')} k="status" />
              <SortHdr label={tr('sel.value','Value')} k="amount" align="right" />
              <th className="font-medium px-5 py-3 text-right">{tr('sel.action','Action')}</th>
            </tr>
          </thead>
          <tbody>
            {loaded ? pageItems.map(o => (
              <tr key={o.id} className="border-b border-arc-border/60 hover:bg-arc-surface2/20 hover-lift-row transition cursor-pointer"
                onClick={(e) => { if (e.target.closest('button, a')) return; setDetailOrder(o); }}>
                <td className="px-5 py-3.5">
                  <button onClick={() => onOpenOrder ? onOpenOrder(o) : setDetailOrder(o)} className="font-mono text-xs text-arc-accent hover:brightness-125 hover:underline inline-flex items-center gap-1 transition">{o.id} <Icon name="arrow-up-right" size={12} className="opacity-60" /></button>
                  <div className="mt-0.5">{typeof PayerBadge === 'function' ? <PayerBadge type={o.payerWalletType} /> : null}</div>
                </td>
                <td className="px-3 py-3.5">
                  <button onC
lick={() => onOpenOrder ? onOpenOrder(o) : setDetailOrder(o)} className="text-left">
                    <div className="text-arc-text font-medium leading-tight hover:text-arc-accent transition">{o.product}</div>
                    <div className="text-[11px] text-arc-faint flex items-center gap-1.5">{o.variant} · {o.delivery === 'instant' ? <span className="text-emerald-400">instant</span> : <span className="text-amber-400">manual</span>}</div>
                  </button>
                </td>
                <td className="px-3 py-3.5 text-arc-muted">@{o.buyer}</td>
                <td className="px-3 py-3.5"><StatusPill status={o.status} /></td>
                <td className="px-3 py-3.5 text-right"><Usdc value={o.amount} className="text-arc-text" /></td>
                <td className="px-5 py-3.5 text-right" onClick={e => e.stopPropagation()}>
                  <SellerActions o={o} onAdvance={onAdvance} onDecline={onDecline} onOpenOrder={onOpenOrder} onChat={onChat} />
                </td>
              </tr>
            )) : (
              // skeleton loading rows (not a spinner)
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-arc-border/60">
                  <td className="px-5 py-3.5"><div className="h-4 w-24 rounded bg-arc-surface2/50 animate-pulse" /></td>
                  <td className="px-3 py-3.5"><div className="h-4 w-40 rounded bg-arc-surface2/50 animate-pulse" /></td>
                  <td className="px-3 py-3.5"><div className="h-4 w-20 rounded bg-arc-surface2/50 animate-pulse" /></td>
                  <td className="px-3 py-3.5"><div className="h-5 w-16 rounded bg-arc-surface2/50 animate-pulse" /></td>
                  <td className="px-3 py-3.5 text-right"><div className="h-4 w-16 rounded bg-arc-surface2/50 animate-pulse ml-auto" /></td>
                  <td className="px-5 py-3.5"><div className="h-7 w-20 rounded bg-arc-surface2/50 animate-pulse ml-auto" /></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {loaded && pageItems.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-14 text-center">
            <div className="w-12 h-12 rounded-2xl bg-arc-surface2 flex items-center justify-center"><Icon name="inbox" size={22} className="text-arc-faint" /></div>
            <div className="text-sm text-arc-muted">{tr('sel.noOrdersMatch','No orders match your filters.')}</div>
            {activeFilterCount > 0 && <button onClick={clearFilters} className="text-xs text-arc-accent hover:brightness-125 inline-flex items-center gap-1"><Icon name="x" size={12} /> Clear filters</button>}
          </div>
        )}
      </div>

      {/* pagination */}
      {loaded && sorted.length > PER_PAGE && (
        <div className="flex items-center justify-between px-5 py-3 border-t border-arc-border">
          <span className="text-xs text-arc-faint tabular-nums">Page {curPage} of {totalPages} · {sorted.length} orders</span>
          <div className="flex items-center gap-1">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={curPage <= 1}
              className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg ring-1 ring-arc-border bg-arc-surface/60 text-xs text-arc-muted hover:text-arc-text hover:ring-arc-borderlt disabled:opacity-40 disabled:pointer-events-none transition">
              <Icon name="chevron-left" size={13} /> Prev
            </button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={curPage >= totalPages}
              className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg ring-1 ring-arc-border bg-arc-surface/60 text-xs text-arc-muted hover:text-arc-text hover:ring-arc-borderlt disabled:opacity-40 disabled:pointer-events-none transition">
              Next <Icon name="chevron-right" size={13} />
            </button>
          </div>
        </div>
      )}

      {/* row-click order detail modal */}
      <OrderDetailModal order={detailOrder} onClose={() => setDetailOrder(null)} onAdvance={onAdvance} onDecline={onDecline} onOpenOrder={onOpenOrder} onChat={onChat} />
    </Card>
  );
}

// ============ Order Detail Modal (simplified row-click) ============
// Renders a simplified view when a row is clicked. Can also deep-link via onOpenOrder.
function OrderDetailModal({ order, onClose, onAdvance, onDecline, onOpenOrder, onChat }) {
  if (!order) return null;
  const canClose = onOpenOrder ? undefined : true;
  const Modal = typeof Modal === 'function' ? Modal : ({ open, onClose, children }) => {
    useEffect(() => { if (!open) return; const h = e => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [open, onClose]);
    if (!open) return null;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 anim-fade">
        <div className="absolute inset-0 bg-arc-bg/80 backdrop-blur-sm" onClick={onClose}></div>
        <div className={`relative w-full max-w-md anim-modal`}>{children}</div>
      </div>
    );
  };

  const isManual = order.delivery === 'manual';
  const done = order.status === 'DONE';
  const disputed = order.status === 'DISPUTED';
  const declined = order.status === 'DECLINED';

  return (
    <Modal open={!!order} onClose={() => { onOpenOrder ? onOpenOrder(order) : onClose(); }} width="max-w-lg">
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-4 border-b border-arc-border">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-arc-primary to-arc-accent flex items-center justify-center shrink-0"><Icon name="package" size={18} className="text-white" /></div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-arc-text truncate">{order.product || order.title || 'Order #' + (order.id)}</div>
            <div className="text-xs text-arc-muted mt-0.5 flex items-center gap-1.5">@{order.buyer} · {order.id}</div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg hover:bg-arc-surface2 text-arc-muted flex items-center justify-center transition"><Icon name="x" size={16} /></button>
        </div>
        <div className="p-5 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wide text-arc-faint">{tr('sel.status','Status')}</span>
            <StatusPill status={order.status} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wide text-arc-faint">{tr('sel.amount','Amount')}</span>
            <Usdc value={order.amount} className="text-emerald-400 font-bold" />
          </div>
          <div className="text-xs text-arc-muted">
            Delivery: <span className="text-arc-text">{order.delivery === 'instant' ? 'Instant' : 'Manual'}</span> · Variant: <span className="text-arc-text">{order.variant || 'Default'}</span>
          </div>
          {disputed && onChat && (
            <Btn variant="danger" full icon="gavel" onClick={() => { onClose(); onChat(order); }}>{tr('sel.openTribunal','Open Tribunal Chat')}</Btn>
          )}
          {!done && !disputed && !declined && (
            <div className="pt-1">
              <div className="text-[11px] uppercase tracking-wide text-arc-faint mb-1.5">{tr('sel.actions','Actions')}</div>
              {order.status === 'PENDING' ? (
                <div className="flex gap-2">
                  <Btn variant="emerald" full icon="check" onClick={() => onAdvance ? onAdvance(order.id, 'PROCESS') : null}>{tr('sel.acceptProcess','Accept & Process')}</Btn>
                  <Btn variant="danger" icon="ban" onClick={() => onDecline ? onDecline(order) : null}>{tr('sel.decline','Decline')}</Btn>
                </div>
              ) : order.status === 'PROCESS' ? (
                <Btn variant="emerald" full icon="send" onClick={() => onAdvance ? onAdvance(order.id, 'SENT') : null}>{tr('sel.sendToBuyer','Send to Buyer')}</Btn>
              ) : order.status === 'SENT' ? (
                <div className="text-xs text-cyan-300 bg-cyan-500/10 ring-1 ring-cyan-500/30 rounded-xl px-3 py-2 text-center">{tr('sel.waitingBuyer','Waiting for buyer confirmation')}</div>
              ) : null}
            </div>
          )}
        </div>
      </Card>
    </Modal>
  );
}

// ============ Seller Actions Component ============
function SellerActions({ o, onAdvance, onDecline, onOpenOrder, onChat }) {
  if (o.status === 'PENDING')
    return (
      <div className="inline-flex items-center gap-2 justify-end">
        {o.delivery === 'instant'
          ? <Btn size="sm" variant="primary" icon="zap" onClick={() => onAdvance(o.id, 'SENT')}>{tr('sel.autoDeliver','Auto-Deliver')}</Btn>
          : <Btn size="sm" variant="outline" icon="cog" onClick={() => onAdvance(o.id, 'PROCESS')}>{tr('sel.setProcess','Set Process')}</Btn>}
        <Btn size="sm" variant="danger" icon="ban" onClick={() => onDecline(o)}>{tr('sel.decline','Decline')}</Btn>
      </div>
    );
  if (o.status === 'PROCESS')
    return (
      <div className="inline-flex items-center gap-2 justify-end">
        {o.delivery === 'manual'
          ? <Btn size="sm" variant="primary" icon="package" onClick={() => onOpenOrder ? onOpenOrder(o) : null}>{tr('sel.deliverItem','Deliver Item')}</Btn>
          : <Btn size="sm" variant="primary" icon="send" onClick={() => onAdvance(o.id, 'SENT')}>{tr('sel.setSent','Set Sent')}</Btn>}
        <Btn size="sm" variant="danger" icon="ban" onClick={() => onDecline(o)}>{tr('sel.decline','Decline')}</Btn>
      </div>
    );
  if (o.status === 'SENT')
    return <span className="text-[11px] text-cyan-300 inline-flex items-center gap-1"><Icon name="timer" size={12} /> Waiting buyer</span>;
  if (o.status === 'DISPUTED')
    return <Btn size="sm" variant="danger" icon="gavel" onClick={() => onChat && onChat(o)}>{tr('sel.openTribunal','Open Tribunal')}</Btn>;
  if (o.status === 'DECLINED')
    return <span className="text-[11px] text-rose-300 inline-flex items-center gap-1"><Icon name="ban" size={12} /> Declined</span>;
  if (o.status === 'DONE')
    return <span className="text-[11px] text-emerald-400 inline-flex items-center gap-1"><Icon name="check-check" size={12} /> Completed</span>;
  return <span className="text-[11px] text-arc-faint">\u2014</span>;
}

// ============ Stat Component (reused in Summary tab) ============
function Stat({ icon, label, value, color }) {
  const c = { cyan: 'text-cyan-400', rose: 'text-rose-400', amber: 'text-amber-400', emerald: 'text-emerald-400' }[color];
  return (
    <div className="bg-arc-bg/40 ring-1 ring-arc-border rounded-xl p-3 hover-lift transition-all">
      <Icon name={icon} size={16} className={c} />
      <div className="text-xl font-bold text-arc-text mt-1.5 tabular-nums">{value}</div>
      <div className="text-[11px] text-arc-faint">{label}</div>
    </div>
  );
}

// ============ Original SellerOrderPage Component (for deep link via onOpenOrder) ============
function SellerOrderPage({ order, onBack, onAdvance, onDecline, onSend, onChat, notify }) {
  const [items, setItems] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { setItems(''); setNote(''); }, [order && order.id]);
  if (!order) return null;
  const isManual = order.delivery === 'manual';
  const lines = items.split('\n').map(s => s.trim()).filter(Boolean);
  const canSend = order.status === 'PROCESS' && (isManual ? lines.length > 0 : true);
  const ICON_TILE = (
    <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-arc-primary via-arc-primarydk to-arc-bg grid-noise flex items-center justify-center text-2xl shrink-0">{isManual ? '\u{F63A}' : '\u{98CCB}'}</div>
  );
  return (
    <div className="anim-view">
      {/* header */}
      <div className="flex flex-col sm:flex-row sm:items-start gap-2 mb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold text-white font-mono">{order.id}</h1>
            <StatusPill status={order.status} />
          </div>
          <div className="text-xs text-arc-faint mt-0.5">{order.time} · Buyer @{order.buyer}</div>
        </div>
        <button onClick={onBack} className="sm:ml-auto inline-flex items-center gap-1.5 text-sm text-arc-accent hover:brightness-125 transition"><Icon name="arrow-left" size={15} /> Back to Seller Center</button>
      </div>
      {/* stepper placeholder (use existing Stepper from elsewhere) */}
      <Card className="p-5 mb-5">{typeof Stepper === 'function' ? <Stepper status={order.status} /> : <span className="text-xs text-arc-muted">{tr('sel.stepperMissing','Stepper not loaded')}</span>}</Card>
      {/* actions by status - simplified for now, real version would mirror SellerActions logic but in modal form */}
      <Card className="p-5 space-y-4">
        <div className="flex items-center gap-3">
          {ICON_TILE}
          <div>
            <div className="text-sm font-semibold text-arc-text">{order.product}</div>
            <div className="text-[11px] text-arc-muted">Variant: {order.variant || 'Default'} · Delivery: {order.delivery}</div>
          </div>
          <Usdc value={order.amount} className="text-emerald-400 font-bold ml-auto" />
        </div>
        {order.status === 'PENDING' && (
          <div className="flex gap-2">
            <Btn variant="emerald" full icon="check" onClick={() => onAdvance(order.id, 'PROCESS')}>{tr('sel.acceptProcess','Accept & Process')}</Btn>
            <Btn variant="danger" icon="ban" onClick={() => onDecline(order)}>{tr('sel.decline','Decline')}</Btn>
          </div>
        )}
        {order.status === 'PROCESS' && (
          <>
            {isManual ? (
              <div>
                <label className="text-[11px] uppercase tracking-wide text-arc-faint">Items (1 line = 1 entry)</label>
                <textarea rows={4} value={items} onChange={e => setItems(e.target.value)} placeholder="login: user@email.com\npass: secret123\n2FA: ABCDEF" className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 py-2.5 text-sm text-arc-text placeholder-arc-faint outline-none resize-none font-mono leading-relaxed transition"></textarea>
                <div className="text-[11px] text-arc-faint mt-1.5 flex items-center gap-1.5"><Icon name="lock" size={11} className="text-arc-accent" /> {lines.length} entries will be sent · E2E encrypted</div>
              </div>
            ) : (
              <div className="text-xs text-arc-muted">Instant product — mark as sent to forward access.</div>
            )}
            <Btn variant="emerald" full icon="send" disabled={!canSend} onClick={() => onSend(order.id, isManual ? lines : ['Access delivered'], note)}>{tr('sel.sendToBuyer','Send to Buyer')}</Btn>
          </>
        )}
        {(order.status === 'SENT' || order.status === 'DONE') && (
          <div className="text-xs text-cyan-300 bg-cyan-500/10 ring-1 ring-cyan-500/30 rounded-xl px-3 py-2 text-center">{tr('sel.orderCompleted','Order completed successfully')}</div>
        )}
      </Card>
    </div>
  );
}

Object.assign(window, { SellerCenter, SellerOrderPage });
