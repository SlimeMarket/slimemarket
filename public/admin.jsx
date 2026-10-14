// ============ Admin Console (Superadmin only) ============

function AdmStat({ icon, label, value, sub, tone, loading }) {
  const map = {
    rose: ['ring-rose-500/30 bg-rose-500/5', 'text-rose-300', 'text-rose-400', 'shadow-[0_0_24px_-6px_rgba(244,63,94,0.35)]'],
    violet: ['ring-arc-primary/30 bg-arc-primary/5', 'text-arc-accent', 'text-arc-accent', 'shadow-[0_0_24px_-6px_rgba(139,92,246,0.35)]'],
    emerald: ['ring-emerald-500/30 bg-emerald-500/5', 'text-emerald-300', 'text-emerald-400', 'shadow-[0_0_24px_-6px_rgba(16,185,129,0.35)]'],
    amber: ['ring-amber-500/30 bg-amber-500/5', 'text-amber-300', 'text-amber-400', 'shadow-[0_0_24px_-6px_rgba(245,158,11,0.35)]'],
  };
  const [ring, txt, ic, glow] = map[tone] || map.violet;
  if (loading) {
    return (
      <div className="rounded-2xl ring-1 ring-arc-border bg-gradient-to-br from-arc-surface to-arc-surface2/50 p-4">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-arc-muted"><div className="animate-pulse bg-arc-surface2/60 rounded h-3 w-3" /> <div className="animate-pulse bg-arc-surface2/60 rounded h-3 w-20" /></div>
        <div className="animate-pulse bg-arc-surface2/60 rounded-lg h-7 w-24 mt-2" />
        <div className="animate-pulse bg-arc-surface2/40 rounded h-3 w-16 mt-1.5" />
      </div>
    );
  }
  return (
    <div className={`bg-gradient-to-br from-arc-surface to-arc-surface2/50 ring-1 ${ring} rounded-2xl p-4 hover:-translate-y-0.5 hover:${glow} transition-all duration-200`}>
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-arc-muted"><Icon name={icon} size={13} className={ic} /> {label}</div>
      <div className={`text-2xl font-bold mt-1.5 tabular-nums ${txt}`}>{value}</div>
      {sub && <div className="text-[11px] text-arc-faint mt-0.5">{sub}</div>}
    </div>
  );
}

function SkelRow({ cols = 4 }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      {Array.from({ length: cols }).map((_, i) => (
        <div key={i} className="animate-pulse bg-arc-surface2/40 rounded-lg h-4 flex-1" style={{ maxWidth: i === 0 ? '80px' : undefined }} />
      ))}
    </div>
  );
}

function AdminConsole({ notify }) {
  const [tab, setTab] = useState('apps');
  const [apps, setApps] = useState([]);
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [usersQ, setUsersQ] = useState('');
  const [usersFilter, setUsersFilter] = useState('all');
  const [usersLoading, setUsersLoading] = useState(false);
  const [products, setProducts] = useState([]);
  const [productsQ, setProductsQ] = useState('');
  const [productsFilter, setProductsFilter] = useState('all');
  const [productsLoading, setProductsLoading] = useState(false);
  const [stores, setStores] = useState([]);
  const [storesQ, setStoresQ] = useState('');
  const [storesFilter, setStoresFilter] = useState('all');
  const [storesLoading, setStoresLoading] = useState(false);
  const [actionModal, setActionModal] = useState(null);
  const [actionReason, setActionReason] = useState('');
  const [loadedTabs, setLoadedTabs] = useState(new Set());
  const [salesSummary, setSalesSummary] = useState(null);
  const [salesLoading, setSalesLoading] = useState(false);
  const [mmStats, setMmStats] = useState([]);
  const [mmStatsLoading, setMmStatsLoading] = useState(false);
  const [reports, setReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [treasuryData, setTreasuryData] = useState(null);
  const [treasuryLoading, setTreasuryLoading] = useState(false);
  const [withdrawModal, setWithdrawModal] = useState(false);
  const [withdrawForm, setWithdrawForm] = useState({ targetWalletAddress: '', amountUsdc: '', adminPin: '' });
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [withdrawPinError, setWithdrawPinError] = useState('');
  const [withdrawLockedUntil, setWithdrawLockedUntil] = useState(null);
  const [userSearchResults, setUserSearchResults] = useState([]);
  const [disputes, setDisputes] = useState([]);
  const [disputesLoading, setDisputesLoading] = useState(false);
  const [resolveTarget, setResolveTarget] = useState(null);
  // 3 — Middleman (MM) role management
  const [mms, setMms] = useState([]);
  const [mmsLoading, setMmsLoading] = useState(false);
  const [mmEmail, setMmEmail] = useState('');
  const [mmAddBusy, setMmAddBusy] = useState(false);
  // admin sets an MM's PIN (the MM cannot set their own). Without a PIN
  // a promoted middleman cannot use the MM console at all.
  const [mmPinModal, setMmPinModal] = useState(null);
  const [mmPinValue, setMmPinValue] = useState('');
  const [mmPinConfirm, setMmPinConfirm] = useState('');
  const [mmPinError, setMmPinError] = useState('');
  // Admin PIN verification state - use ref for immediate access
  const adminTokenRef = useRef(null);
  const [pinModal, setPinModal] = useState(null); // { action, payload }
  const [pinInput, setPinInput] = useState('');
  const [pinLoading, setPinLoading] = useState(false);
  const [pinError, setPinError] = useState('');

  // Overview dashboard state
  const [dashboard, setDashboard] = useState(null);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [expandedLogRow, setExpandedLogRow] = useState(null);

  // Enhanced audit log state
  const [logFull, setLogFull] = useState([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logSearch, setLogSearch] = useState('');
  const [logDateFrom, setLogDateFrom] = useState('');
  const [logDateTo, setLogDateTo] = useState('');
  const [logActionFilter, setLogActionFilter] = useState('all');
  const [logActorFilter, setLogActorFilter] = useState('all');
  const [logPage, setLogPage] = useState(0);
  const [logExpandedRow, setLogExpandedRow] = useState(null);
  const LOG_PAGE_SIZE = 50;

  // Enhanced treasury state
  const [walletTxs, setWalletTxs] = useState([]);
  const [walletTxsLoading, setWalletTxsLoading] = useState(false);
  const [collectFeesLoading, setCollectFeesLoading] = useState(false);
  const [reconcileStatus, setReconcileStatus] = useState(null);

  const API = window.SLIME_API || '';
  const api = async (path, opts = {}) => {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (adminTokenRef.current) headers['X-Admin-Token'] = adminTokenRef.current;
    const res = await fetch(API + path, { credentials: 'include', headers, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'HTTP ' + res.status);
      err.status = res.status;
      err.code = data.code || null;
      err.payload = data; // structured fields: attemptsRemaining, lockedUntil, ...
      throw err;
    }
    return data;
  };

  // Verify admin PIN and get action token
  const verifyAdminPin = async (pin) => {
    const res = await fetch(API + '/api/admin/verify', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, challengeId: 'dev-bypass' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'PIN verification failed');
    adminTokenRef.current = data.adminToken;
    // BUG FIX: the token used to live only in this component's ref, so the
    // staff-gated buttons in the DEAL ROOM (app.jsx: Release / Refund / Slash /
    // Cancel) never sent X-Admin-Token and always got 401. Publish it so those
    // calls can authenticate too. Cleared on logout and when it expires.
    try { window.__ADMIN_TOKEN = data.adminToken; } catch (e) {}
    return data.adminToken;
  };

  // Execute action with PIN verification
  const requireAdminAuth = (action, payload) => {
    if (adminTokenRef.current) {
      // Token exists, execute directly
      return executeAdminAction(action, payload);
    }
    // Show PIN modal
    setPinModal({ action, payload });
    setPinInput('');
    setPinError('');
  };

  const executeAdminAction = async (action, payload) => {
    try {
      if (action === 'resolveDispute') {
        await api('/api/admin/disputes/' + payload.orderId + '/resolve', {
          method: 'POST', body: JSON.stringify({ decision: payload.decision, reason: payload.reason || 'Admin decision' }),
        });
        setDisputes(list => list.filter(d => d.orderId !== payload.orderId));
        notify('Dispute resolved: ' + payload.decision, 'success');
      } else if (action === 'ban') {
        await api('/api/admin/users/' + payload.id + '/ban', { method: 'POST', body: JSON.stringify({ reason: payload.reason }) });
        notify('User banned', 'success'); fetchUsers();
      } else if (action === 'unban') {
        await api('/api/admin/users/' + payload.id + '/ban', { method: 'DELETE' });
        notify('User unbanned', 'success'); fetchUsers();
      } else if (action === 'roleChange') {
        await api('/api/admin/users/' + payload.id + '/role', { method: 'PATCH', body: JSON.stringify({ role: payload.role }) });
        notify('Role changed to ' + payload.role, 'success'); fetchUsers();
      } else if (action === 'freeze_product') {
        await api('/api/admin/products/' + payload.id + '/freeze', { method: 'POST', body: JSON.stringify({ reason: payload.reason }) });
        notify('Product frozen', 'success'); fetchProducts();
      } else if (action === 'unfreeze_product') {
        await api('/api/admin/products/' + payload.id + '/freeze', { method: 'DELETE' });
        notify('Product unfrozen', 'success'); fetchProducts();
      } else if (action === 'freeze_store') {
        const d = await api('/api/admin/stores/' + payload.id + '/freeze', { method: 'POST', body: JSON.stringify({ reason: payload.reason }) });
        notify('Store frozen' + (d.productsFrozen ? ' · ' + d.productsFrozen + ' products frozen' : ''), 'success'); fetchStores();
      } else if (action === 'unfreeze_store') {
        const d = await api('/api/admin/stores/' + payload.id + '/freeze', { method: 'DELETE' });
        notify('Store unfrozen' + (d.productsUnfrozen ? ' · ' + d.productsUnfrozen + ' products unfrozen' : ''), 'success'); fetchStores();
      } else if (action === 'treasuryWithdraw') {
        try {
          await api('/api/admin/treasury/withdraw', { method: 'POST', body: JSON.stringify(payload) });
          notify('Treasury payout successful', 'success');
          setWithdrawModal(false);
          setWithdrawForm({ recipientUserId: '', amountUsdc: '', memo: '', sourceAccount: 'gas_pool', adminPin: '' });
          setWithdrawPinError('');
          setWithdrawLockedUntil(null);
          setUserSearchResults([]);
          fetchTreasury();
        } catch (e) {
          if (e.code === 'INVALID_PIN') {
            setWithdrawPinError('Invalid admin PIN. ' + (e.payload?.attemptsRemaining ?? '?') + ' attempt(s) remaining.');
          } else if (e.code === 'PIN_LOCKED') {
            setWithdrawLockedUntil(e.payload?.lockedUntil || null);
            setWithdrawPinError('Admin PIN locked. Try again ' + (e.payload?.lockedUntil ? 'after ' + new Date(e.payload.lockedUntil).toLocaleTimeString() : 'in 15 minutes') + '.');
          } else if (e.code === 'ADMIN_PIN_NOT_SET') {
            setWithdrawPinError(e.message || 'Set your admin PIN first.');
          } else if (/admin token/i.test(e.message || '')) {
            // Session token expired — re-run through the PIN modal flow.
            throw e;
          } else {
            setWithdrawPinError('Withdrawal failed: ' + (e.message || 'unknown error'));
          }
          return; // handled inline — do not surface the generic error toast
        }
      } else if (action === 'collectFees') {
        await api('/api/admin/fees/collect', { method: 'POST', body: JSON.stringify({}) });
        notify('Fees collected successfully', 'success');
        fetchTreasury();
        fetchDashboard();
      } else if (action === 'setMmPin') {
        // a promoted MM has no PIN, and without one they cannot pass
        // /api/admin/verify, so the MM console is unusable. Only the admin can
        // set it (the MM cannot set their own).
        await api('/api/admin/mm/' + payload.id + '/set-pin', {
          method: 'POST', body: JSON.stringify({ pin: payload.pin }),
        });
        notify('Middleman PIN set', 'success');
        setMmPinModal(null);
        setMmPinValue(''); setMmPinConfirm(''); setMmPinError('');
        fetchMiddlemen();
      }
    } catch (e) {
      // Token expired? Clear it and show PIN modal
      if (/admin token|unauthorized/i.test(e.message)) {
        adminTokenRef.current = null;
        try { window.__ADMIN_TOKEN = null; } catch (err) {}
        setPinModal({ action, payload });
        setPinInput('');
        setPinError('Session expired. Re-enter PIN.');
        return;
      }
      notify('Action failed: ' + e.message, 'error');
    }
  };

  const handlePinSubmit = async () => {
    if (!pinInput || pinInput.length < 4) { setPinError('PIN must be at least 4 digits'); return; }
    setPinLoading(true);
    setPinError('');
    try {
      await verifyAdminPin(pinInput);
      const { action, payload } = pinModal;
      setPinModal(null);
      await executeAdminAction(action, payload);
    } catch (e) {
      setPinError(e.message);
    }
    setPinLoading(false);
  };

  useEffect(() => {
    (async () => {
      try {
        const [aRes, tRes] = await Promise.all([
          api('/api/admin/seller-applications').catch(() => ({ items: [] })),
          api('/api/admin/treasury').catch(() => ({ auditTrail: [] })),
        ]);
        setApps((aRes.items || aRes || []).map(a => ({
          id: a.id, uid: a.uid || a.id, name: a.name || a.store_name,
          avatar: 'from-arc-surface2 to-arc-surface', store: a.store_name || a.storeName,
          cat: a.category || '', txCount: a.tx_count || 0,
          joined: a.created_at || '', note: a.note || '', contact: a.contact || a.pitch || '',
        })));
        setLog((tRes.auditTrail || []).map(l => ({
          action: l.action, ref: l.refId, by: l.mmUserId === 'auto-release' ? 'system' : 'admin',
          detail: JSON.stringify(l.detail || {}), time: '-',
        })));
        if (tRes.collectedFees) setTreasuryData(tRes);
      } catch (e) { console.error('Admin fetch failed:', e); }
      setLoading(false);
    })();
  }, []);

  const handleApp = async (app, ok) => {
    try {
      await api('/api/admin/seller-applications/' + app.id + '/' + (ok ? 'approve' : 'reject'), { method: 'POST' });
      setApps(list => list.filter(a => a.uid !== app.uid && a.id !== app.id));
      notify(ok ? app.name + ' is now a Seller' : app.name + ' application rejected', ok ? 'success' : 'info');
    } catch (e) { notify('Failed: ' + e.message, 'error'); }
  };

  const fetchUsers = async () => {
    setUsersLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (usersQ) params.set('q', usersQ);
      if (usersFilter !== 'all') params.set(usersFilter === 'banned' ? 'banned' : 'role', usersFilter === 'banned' ? 'true' : usersFilter);
      const d = await api('/api/admin/users?' + params);
      setUsers(d.items || []);
      setLoadedTabs(s => new Set(s).add('users'));
    } catch (e) { notify('Failed to load users: ' + e.message, 'error'); }
    setUsersLoading(false);
  };
  const fetchProducts = async () => {
    setProductsLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (productsQ) params.set('q', productsQ);
      if (productsFilter === 'frozen') params.set('frozen', 'true');
      else if (productsFilter === 'active') params.set('frozen', 'false');
      const d = await api('/api/admin/products?' + params);
      setProducts(d.items || []);
      setLoadedTabs(s => new Set(s).add('products'));
    } catch (e) { notify('Failed to load products: ' + e.message, 'error'); }
    setProductsLoading(false);
  };
  const fetchStores = async () => {
    setStoresLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (storesQ) params.set('q', storesQ);
      if (storesFilter === 'frozen') params.set('frozen', 'true');
      else if (storesFilter === 'active') params.set('frozen', 'false');
      const d = await api('/api/admin/stores?' + params);
      setStores(d.items || []);
      setLoadedTabs(s => new Set(s).add('stores'));
    } catch (e) { notify('Failed to load stores: ' + e.message, 'error'); }
    setStoresLoading(false);
  };

  useEffect(() => {
    if (tab === 'overview' && !dashboard) fetchDashboard();
    if (tab === 'users' && !loadedTabs.has('users')) fetchUsers();
    if (tab === 'products' && !loadedTabs.has('products')) fetchProducts();
    if (tab === 'stores' && !loadedTabs.has('stores')) fetchStores();
    if (tab === 'sales' && !salesSummary) fetchSalesSummary();
    if (tab === 'mmstats' && mmStats.length === 0) fetchMmStats();
    if (tab === 'reports' && reports.length === 0) fetchReports();
    if (tab === 'disputes' && !loadedTabs.has('disputes')) fetchDisputes();
    if (tab === 'middlemen' && !loadedTabs.has('middlemen')) fetchMiddlemen();
    if (tab === 'treasury' && !treasuryData) fetchTreasury();
    if (tab === 'log' && !loadedTabs.has('log')) fetchAuditLog();
  }, [tab]);

  useEffect(() => {
    if (tab === 'treasury') fetchWalletTxs();
  }, [tab]);

  const openActionModal = (type, id, name) => { setActionModal({ type, id, name }); setActionReason(''); };
  const confirmAction = async () => {
    if (!actionModal) return;
    const { type, id } = actionModal;
    setActionModal(null);
    requireAdminAuth(type, { id, reason: actionReason });
  };
  const handleUnban = async (id) => {
    requireAdminAuth('unban', { id });
  };
  const handleRoleChange = async (id, newRole) => {
    requireAdminAuth('roleChange', { id, role: newRole });
  };
  const handleUnfreezeProduct = async (id) => {
    requireAdminAuth('unfreeze_product', { id });
  };
  const handleUnfreezeStore = async (id) => {
    requireAdminAuth('unfreeze_store', { id });
  };

  const fetchSalesSummary = async () => {
    setSalesLoading(true);
    try { const d = await api('/api/admin/sales-summary'); setSalesSummary(d); }
    catch (e) { notify('Failed to load sales summary: ' + e.message, 'error'); }
    setSalesLoading(false);
  };
  const fetchMmStats = async () => {
    setMmStatsLoading(true);
    try { const d = await api('/api/admin/mm/stats'); setMmStats(d.items || d || []); }
    catch (e) { notify('Failed to load MM stats: ' + e.message, 'error'); }
    setMmStatsLoading(false);
  };
  const fetchReports = async () => {
    setReportsLoading(true);
    try { const d = await api('/api/admin/reports'); setReports(d.items || []); }
    catch (e) { notify('Failed to load reports: ' + e.message, 'error'); }
    setReportsLoading(false);
  };
  const fetchDisputes = async () => {
    setDisputesLoading(true);
    try {
      const d = await api('/api/admin/disputes');
      setDisputes(d.items || []);
      setLoadedTabs(s => new Set(s).add('disputes'));
    } catch (e) { console.error('fetch disputes:', e); }
    setDisputesLoading(false);
  };

  // 3 — Middleman (MM) panel. Admin-session auth only (no PIN
  // token needed; reads are safe and writes are plain role changes audited by
  // the API as MM_PROMOTE/MM_DEMOTE).
  const fetchMiddlemen = async () => {
    setMmsLoading(true);
    try {
      const d = await api('/api/admin/middlemen');
      setMms(d.middlemen || []);
      setLoadedTabs(s => new Set(s).add('middlemen'));
    } catch (e) { notify('Failed to load middlemen: ' + e.message, 'error'); }
    setMmsLoading(false);
  };
  const addMiddleman = async () => {
    const email = mmEmail.trim();
    if (!email || mmAddBusy) return;
    setMmAddBusy(true);
    try {
      const d = await api('/api/admin/middlemen', { method: 'POST', body: JSON.stringify({ email }) });
      notify(d.message || ('Promoted to MM: ' + email), 'success');
      setMmEmail('');
      fetchMiddlemen();
    } catch (e) { notify('Promote failed: ' + e.message, 'error'); }
    setMmAddBusy(false);
  };
  const revokeMiddleman = async (m) => {
    try {
      const d = await api('/api/admin/middlemen', { method: 'DELETE', body: JSON.stringify({ userId: m.id }) });
      notify(d.message || ('MM revoked: ' + m.name), 'info');
      fetchMiddlemen();
    } catch (e) { notify('Revoke failed: ' + e.message, 'error'); }
  };
  // validate locally, then go through the admin-token gate.
  const submitMmPin = () => {
    if (!/^\d{6}$/.test(mmPinValue)) { setMmPinError('PIN must be exactly 6 digits'); return; }
    if (mmPinValue !== mmPinConfirm) { setMmPinError('PINs do not match'); return; }
    setMmPinError('');
    requireAdminAuth('setMmPin', { id: mmPinModal.id, pin: mmPinValue });
  };
  const resolveDispute = async (orderId, decision, reason) => {
    setResolveTarget(null);
    requireAdminAuth('resolveDispute', { orderId, decision, reason });
  };
  const handleReportAction = async (id, status) => {
    try { await api('/api/admin/reports/' + id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }); notify('Report ' + status, 'success'); fetchReports(); }
    catch (e) { notify('Failed: ' + e.message, 'error'); }
  };

  const fetchTreasury = async () => {
    setTreasuryLoading(true);
    try { const d = await api('/api/admin/treasury'); setTreasuryData(d); }
    catch (e) { notify('Failed to load treasury: ' + e.message, 'error'); }
    setTreasuryLoading(false);
  };

  // ===== Overview Dashboard =====
  const fetchDashboard = async () => {
    setDashboardLoading(true);
    try {
      const d = await api('/api/admin/dashboard');
      setDashboard(d);
    } catch (e) { console.error('Dashboard fetch failed:', e); }
    setDashboardLoading(false);
  };

  // ===== Enhanced Audit Log =====
  const fetchAuditLog = async () => {
    setLogLoading(true);
    try {
      const d = await api('/api/admin/audit-log');
      const items = d.items || d.auditTrail || d || [];
      setLogFull(items.map(l => ({
        action: l.action || '',
        ref: l.refId || l.ref || '',
        by: l.mmUserId === 'auto-release' ? 'auto_release' : (l.mmUserId === 'platform' ? 'platform' : (l.actor || 'user')),
        actorType: l.mmUserId === 'auto-release' ? 'auto_release' : (l.mmUserId === 'platform' ? 'platform' : 'user'),
        actor: l.actor || l.mmUserId || '',
        detail: l.detail || l.metadata || {},
        detailStr: JSON.stringify(l.detail || l.metadata || {}, null, 2),
        time: l.createdAt || l.created_at || l.timestamp || '',
      })));
      setLoadedTabs(s => new Set(s).add('log'));
    } catch (e) { console.error('Audit log fetch failed:', e); }
    setLogLoading(false);
  };

  const filteredLog = (() => {
    let r = logFull;
    if (logSearch) {
      const q = logSearch.toLowerCase();
      r = r.filter(l =>
        (l.actor || '').toLowerCase().includes(q) ||
        (l.action || '').toLowerCase().includes(q) ||
        (l.ref || '').toLowerCase().includes(q)
      );
    }
    if (logActionFilter !== 'all') r = r.filter(l => l.action === logActionFilter);
    if (logActorFilter !== 'all') r = r.filter(l => l.actorType === logActorFilter);
    if (logDateFrom) {
      const from = new Date(logDateFrom).getTime();
      r = r.filter(l => { const t = new Date(l.time).getTime(); return !t || t >= from; });
    }
    if (logDateTo) {
      const to = new Date(logDateTo).getTime() + 86400000;
      r = r.filter(l => { const t = new Date(l.time).getTime(); return !t || t <= to; });
    }
    return r;
  })();

  const logPageCount = Math.ceil(filteredLog.length / LOG_PAGE_SIZE);
  const logPageItems = filteredLog.slice(logPage * LOG_PAGE_SIZE, (logPage + 1) * LOG_PAGE_SIZE);

  const exportLogCSV = () => {
    const headers = ['Time', 'Actor', 'Action', 'Ref', 'Detail'];
    const rows = filteredLog.map(l => [
      l.time ? new Date(l.time).toISOString() : '',
      l.actor || '',
      l.action || '',
      l.ref || '',
      (typeof l.detail === 'string' ? l.detail : JSON.stringify(l.detail || {})).replace(/"/g, '""'),
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => '"' + c + '"').join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'audit-log-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    notify('Audit log exported (' + filteredLog.length + ' entries)', 'success');
  };

  const LOG_ACTION_TYPES = ['RELEASE_ORDER', 'REFUND_ORDER', 'BAN_USER', 'UNBAN_USER', 'FREEZE_PRODUCT', 'UNFREEZE_PRODUCT', 'FREEZE_STORE', 'UNFREEZE_STORE', 'APPROVE_SELLER', 'REJECT_SELLER', 'ROLE_CHANGE', 'TREASURY_WITHDRAW', 'COLLECT_FEES', 'RESOLVE_DISPUTE'];

  // ===== Treasury enhancements =====
  const fetchWalletTxs = async () => {
    setWalletTxsLoading(true);
    try {
      const d = await api('/api/admin/wallet-txs?limit=20');
      setWalletTxs(d.items || d || []);
    } catch (e) { console.error('Wallet txs fetch failed:', e); }
    setWalletTxsLoading(false);
  };

  const handleCollectFees = async () => {
    setCollectFeesLoading(true);
    try {
      await api('/api/admin/fees/collect', { method: 'POST', body: JSON.stringify({}) });
      notify('Fees collected successfully', 'success');
      fetchTreasury();
      fetchDashboard();
    } catch (e) {
      if (/admin token|unauthorized/i.test(e.message)) {
        requireAdminAuth('collectFees', {});
      } else {
        notify('Failed to collect fees: ' + e.message, 'error');
      }
    }
    setCollectFeesLoading(false);
  };

  const checkReconcile = () => {
    if (!treasuryData || !dashboard) return null;
    const collected = treasuryData.collectedFees?.total ?? 0;
    const balance = dashboard.platformBalance ?? treasuryData.balances?.totalAvailable ?? 0;
    const drift = Math.abs(collected - balance);
    return { balanced: drift < 0.01, drift, collected, balance };
  };
  const searchTreasuryUsers = async (q) => {
    if (!q || q.length < 2) { setUserSearchResults([]); return; }
    try {
      const params = new URLSearchParams({ limit: '10', q });
      const d = await api('/api/admin/users?' + params);
      setUserSearchResults(d.items || []);
    } catch { setUserSearchResults([]); }
  };
  const handleTreasuryWithdraw = async () => {
    setWithdrawPinError('');
    if (!withdrawForm.targetWalletAddress || !withdrawForm.amountUsdc) {
      notify('Address and amount are required', 'error'); return;
    }
    if (!withdrawForm.adminPin) {
      setWithdrawPinError('Enter your admin PIN to confirm this payout.');
      return;
    }
    requireAdminAuth('treasuryWithdraw', withdrawForm);
  };

  const TABS = [
    { id: 'overview', label: 'Overview', icon: 'layout-dashboard' },
    { id: 'apps', label: tr('admin.apps','Seller Apps'), icon: 'store', count: apps.length },
    { id: 'users', label: 'Users', icon: 'users', count: 0 },
    { id: 'products', label: 'Products', icon: 'package', count: 0 },
    { id: 'stores', label: 'Stores', icon: 'store', count: 0 },
    { id: 'sales', label: 'Sales', icon: 'trending-up', count: 0 },
    { id: 'mmstats', label: 'MM Stats', icon: 'shield-check', count: 0 },
    { id: 'reports', label: 'Reports', icon: 'flag', count: 0 },
    { id: 'disputes', label: 'Disputes', icon: 'gavel', count: disputes.length },
    { id: 'middlemen', label: tr('admin.mmTitle','Middlemen (MM)'), icon: 'user-shield', count: mms.length },
    { id: 'treasury', label: 'Treasury', icon: 'wallet', count: 0 },
    { id: 'log', label: tr('admin.log','Audit Log'), icon: 'scroll-text', count: 0 },
  ];

  return (
    <div className="anim-view">
      <div className="flex items-center gap-2.5 mb-1">
        <h1 className="text-xl font-bold text-white">{tr('admin.title','Admin Console')}</h1>
        <PixBadge color="rose">SUPERADMIN</PixBadge>
      </div>
      <p className="text-sm text-arc-muted mb-5">{tr('admin.subtitle','User management, product/store freeze, seller applications, and audit log. All actions recorded.')}</p>

      {/* Enhanced Overview Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <AdmStat icon="store" label={tr('admin.sellerPending','Seller Pending')} value={apps.length} sub={tr('admin.awaitingReview','awaiting review')} tone="amber" loading={loading && apps.length === 0} />
        <AdmStat icon="wallet" label="Collected Fees" value={treasuryData ? (treasuryData.collectedFees?.total ?? 0).toFixed(2) + ' USDC' : '—'} sub={treasuryData ? 'marketplace + escrow' : 'loading...'} tone="violet" loading={!treasuryData} />
        <AdmStat icon="percent" label="Available" value={treasuryData ? (treasuryData.balances?.totalAvailable ?? 0).toFixed(2) + ' USDC' : '—'} sub="withdrawable" tone="emerald" loading={!treasuryData} />
        <AdmStat icon="check-check" label={tr('admin.resolvedStat','Audit Entries')} value={logFull.length} sub={tr('admin.totalRecorded','total recorded')} tone="rose" loading={logLoading} />
      </div>

      {/* tabs */}
      <div className="flex items-center gap-1 border-b border-arc-border mb-5 overflow-x-auto">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition ${tab === t.id ? 'border-rose-500 text-rose-300' : 'border-transparent text-arc-muted hover:text-arc-text'}`}>
            <Icon name={t.icon} size={15} /> {t.label}
            {t.count > 0 && <span className={`text-[10px] font-pixel px-1.5 py-1 rounded ${tab === t.id ? 'bg-rose-500/20 text-rose-300' : 'bg-arc-surface2 text-arc-muted'}`}>{t.count}</span>}
          </button>
        ))}
      </div>

      {/* === Overview Tab === */}
      {tab === 'overview' && (
        <div className="space-y-6 anim-fade">
          {/* 4 Stat Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <AdmStat icon="dollar-sign" label="Today's Revenue" value={dashboardLoading ? '—' : ((dashboard?.today?.revenue ?? 0).toFixed(2) + ' USDC')} sub="marketplace + escrow" tone="emerald" loading={dashboardLoading} />
            <AdmStat icon="store" label="Pending Sellers" value={apps.length} sub="awaiting review" tone="amber" loading={loading && apps.length === 0} />
            <AdmStat icon="gavel" label="Active Disputes" value={disputes.length} sub="needs resolution" tone="rose" loading={disputesLoading && disputes.length === 0} />
            <AdmStat icon="wallet" label="Fee Pool" value={treasuryData ? ((treasuryData.collectedFees?.total ?? 0).toFixed(2) + ' USDC') : '—'} sub="collected all-time" tone="violet" loading={!treasuryData} />
          </div>

          {/* Quick Actions */}
          <div>
            <h3 className="text-sm font-semibold text-arc-text mb-3">Quick Actions</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <button onClick={() => setTab('apps')} className="bg-gradient-to-br from-arc-surface to-arc-surface2/50 ring-1 ring-arc-border rounded-2xl p-4 hover:-translate-y-0.5 hover:shadow-[0_0_24px_-6px_rgba(244,63,94,0.35)] transition-all duration-200 text-left">
                <div className="flex items-center justify-between mb-2">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/15 ring-1 ring-amber-500/30 flex items-center justify-center"><Icon name="store" size={18} className="text-amber-400" /></div>
                  {apps.length > 0 && <span className="text-[10px] font-pixel px-2 py-1 rounded bg-amber-500/20 text-amber-300">{apps.length}</span>}
                </div>
                <div className="text-sm font-semibold text-arc-text">Approve Seller</div>
                <div className="text-xs text-arc-faint mt-1">Review applications</div>
              </button>
              <button onClick={() => setTab('disputes')} className="bg-gradient-to-br from-arc-surface to-arc-surface2/50 ring-1 ring-arc-border rounded-2xl p-4 hover:-translate-y-0.5 hover:shadow-[0_0_24px_-6px_rgba(244,63,94,0.35)] transition-all duration-200 text-left">
                <div className="flex items-center justify-between mb-2">
                  <div className="w-10 h-10 rounded-xl bg-rose-500/15 ring-1 ring-rose-500/30 flex items-center justify-center"><Icon name="gavel" size={18} className="text-rose-400" /></div>
                  {disputes.length > 0 && <span className="text-[10px] font-pixel px-2 py-1 rounded bg-rose-500/20 text-rose-300">{disputes.length}</span>}
                </div>
                <div className="text-sm font-semibold text-arc-text">Resolve Dispute</div>
                <div className="text-xs text-arc-faint mt-1">Review claims</div>
              </button>
              <button onClick={handleCollectFees} disabled={collectFeesLoading} className="bg-gradient-to-br from-arc-surface to-arc-surface2/50 ring-1 ring-arc-border rounded-2xl p-4 hover:-translate-y-0.5 hover:shadow-[0_0_24px_-6px_rgba(16,185,129,0.35)] transition-all duration-200 text-left disabled:opacity-50">
                <div className="flex items-center justify-between mb-2">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/15 ring-1 ring-emerald-500/30 flex items-center justify-center"><Icon name="send" size={18} className="text-emerald-400" /></div>
                </div>
                <div className="text-sm font-semibold text-arc-text">Collect Fees</div>
                <div className="text-xs text-arc-faint mt-1">Transfer to treasury</div>
              </button>
              <button onClick={() => setTab('treasury')} className="bg-gradient-to-br from-arc-surface to-arc-surface2/50 ring-1 ring-arc-border rounded-2xl p-4 hover:-translate-y-0.5 hover:shadow-[0_0_24px_-6px_rgba(139,92,246,0.35)] transition-all duration-200 text-left">
                <div className="flex items-center justify-between mb-2">
                  <div className="w-10 h-10 rounded-xl bg-violet-500/15 ring-1 ring-violet-500/30 flex items-center justify-center"><Icon name="scale" size={18} className="text-violet-400" /></div>
                </div>
                <div className="text-sm font-semibold text-arc-text">Reconcile</div>
                <div className="text-xs text-arc-faint mt-1">Check balances</div>
              </button>
            </div>
          </div>

          {/* Recent Audit Log */}
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-arc-border/60 bg-arc-surface/30">
              <div className="text-sm font-semibold text-arc-text flex items-center gap-2"><Icon name="history" size={14} className="text-arc-muted" /> Recent Activity</div>
              <Btn size="sm" variant="ghost" icon="arrow-right" onClick={() => setTab('log')}>View All →</Btn>
            </div>
            <div className="divide-y divide-arc-border/60 max-h-72 overflow-y-auto">
              {logLoading && Array.from({ length: 5 }).map((_, i) => <SkelRow key={i} cols={4} />)}
              {!logLoading && logFull.length === 0 && <EmptyState text="No recent activity" />}
              {!logLoading && logFull.slice(0, 10).map(l => {
                const toneCls = { RELEASE: 'bg-emerald-500/15 text-emerald-300', REFUND: 'bg-rose-500/15 text-rose-300', APPROVE: 'bg-emerald-500/15 text-emerald-300', REJECT: 'bg-rose-500/15 text-rose-300', BAN_USER: 'bg-rose-500/15 text-rose-300', FREEZE_PRODUCT: 'bg-cyan-500/15 text-cyan-300', FREEZE_STORE: 'bg-cyan-500/15 text-cyan-300' }[l.action] || 'bg-arc-surface2 text-arc-muted';
                const ic = { RELEASE: 'check-check', REFUND: 'undo-2', APPROVE: 'user-check', REJECT: 'user-x', BAN_USER: 'ban', FREEZE_PRODUCT: 'snowflake', FREEZE_STORE: 'snowflake', TREASURY_WITHDRAW: 'arrow-up-right', COLLECT_FEES: 'send' }[l.action] || 'dot';
                return (
                  <div key={l.createdAt || l.created_at} onClick={() => setLogExpandedRow(logExpandedRow === l.id ? null : l.id)} className="flex items-center gap-3 px-4 py-3 hover:bg-arc-surface2/30 cursor-pointer transition">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${toneCls}`}><Icon name={ic} size={15} /></div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-arc-text"><span className="font-pixel text-[8px] mr-2 text-arc-muted">{l.action}</span><span className="font-mono text-xs text-arc-muted truncate block">{l.ref}</span></div>
                      <div className="text-[12px] text-arc-faint truncate">{l.by}</div>
                    </div>
                    <div className="text-[11px] text-arc-faint shrink-0 whitespace-nowrap">{l.time ? new Date(l.time).toLocaleString() : '-'}</div>
                  </div>
                );
              })}
            </div>
            {logExpandedRow && (() => { const row = logFull.find(l => l.createdAt === logExpandedRow || l.created_at === logExpandedRow); if (!row) return null; return (<div className="bg-arc-bg/60 border-t border-arc-border p-4 animate-fade-in"><pre className="text-xs text-arc-muted whitespace-pre-wrap overflow-auto max-h-40">{row.detailStr}</pre></div>); })()}
          </Card>

          {/* Financial Summary */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <Card className="p-5">
              <div className="text-sm font-semibold text-arc-text mb-4 flex items-center gap-2"><Icon name="percent" size={16} className="text-violet-400" /> Marketplace Fees</div>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-arc-muted">Collected</span>
                  <span className="text-emerald-400 font-bold">{treasuryData ? (treasuryData.collectedFees?.marketplace?.platformFee ?? 0).toFixed(2) + ' USDC' : '—'} {treasuryData && '+'} {treasuryData?.collectedFees?.marketplace?.gasPool ?? 0}.00 USDC</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-arc-muted">Platform DCW Balance</span>
                  <span className="text-violet-400 font-bold">{dashboard ? dashboard.platformBalance.toFixed(2) + ' USDC' : '—'} (loading...)</span>
                </div>
              </div>
            </Card>
            <Card className="p-5">
              <div className="text-sm font-semibold text-arc-text mb-4 flex items-center gap-2"><Icon name="shield-check" size={16} className="text-amber-400" /> Escrow Fees</div>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-arc-muted">Collected</span>
                  <span className="text-emerald-400 font-bold">{treasuryData ? (treasuryData.collectedFees?.escrow?.baseFee ?? 0).toFixed(2) + ' USDC' : '—'} {treasuryData && '+'} {treasuryData?.collectedFees?.escrow?.gasPool ?? 0}.00 USDC</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-arc-muted">Total Orders</span>
                  <span className="text-arc-text font-bold">{treasuryData?.stats?.marketplace?.orders ?? 0}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-arc-muted">Escrow Deals</span>
                  <span className="text-arc-text font-bold">{treasuryData?.stats?.escrow?.deals ?? 0}</span>
                </div>
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* === Seller Apps === */}
      {tab === 'apps' && (
        <div className="space-y-3">
          {loading && <div className="text-sm text-arc-muted py-8 text-center">Loading...</div>}
          {!loading && apps.length === 0 && <Empty icon="inbox" text={tr('admin.noApps','No seller applications.')} />}
          {apps.map(a => (
            <Card key={a.uid} className="p-4">
              <div className="flex items-center gap-3 flex-wrap">
                <Avatar gradient={a.avatar} name={a.name} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-arc-text">{a.store || a.name}</span>
                    <span className="text-[10px] font-pixel px-1.5 py-0.5 rounded bg-arc-surface2 text-arc-muted">{a.cat || 'N/A'}</span>
                  </div>
                  <div className="text-[11px] text-arc-faint mt-0.5">@{a.name} · <span className="font-mono">{a.uid}</span> · {a.txCount} tx · {tr('admin.since','since')} {a.joined ? new Date(a.joined).toLocaleDateString('en-US',{month:'short',year:'numeric'}) : ''}</div>
                  {a.contact && <div className="text-[12px] text-arc-accent mt-1.5 flex items-center gap-1.5"><Icon name="message-circle" size={12} /> {a.contact}</div>}
                  {a.note && <div className="text-[12px] text-arc-muted mt-1.5" style={{ textWrap: 'pretty' }}>{a.note}</div>}
                </div>
                <div className="flex gap-2">
                  <Btn size="sm" variant="danger" icon="x" onClick={() => handleApp(a, false)}>{tr('admin.reject','Reject')}</Btn>
                  <Btn size="sm" variant="emerald" icon="check" onClick={() => handleApp(a, true)}>{tr('admin.approve','Approve')}</Btn>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* === Users === */}
      {tab === 'users' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <input value={usersQ} onChange={e => { setUsersQ(e.target.value); }} onKeyDown={e => e.key === 'Enter' && fetchUsers()} placeholder="Search users..."
              className="flex-1 min-w-48 bg-arc-surface/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl px-3 h-10 text-sm text-arc-text placeholder-arc-faint outline-none" />
            <select value={usersFilter} onChange={e => { setUsersFilter(e.target.value); setTimeout(fetchUsers, 0); }}
              className="bg-arc-surface/60 ring-1 ring-arc-border rounded-xl px-3 h-10 text-sm text-arc-text outline-none">
              <option value="all">All Roles</option><option value="Member">Member</option><option value="Buyer">Buyer</option><option value="Seller">Seller</option><option value="Admin">Admin</option><option value="banned">Banned</option>
            </select>
            <Btn size="sm" variant="ghost" icon="search" onClick={fetchUsers}>Search</Btn>
          </div>
          {usersLoading && <div className="text-sm text-arc-muted py-8 text-center">Loading users...</div>}
          {!usersLoading && users.length === 0 && <Empty icon="users" text="No users found." />}
          {users.map(u => (
            <Card key={u.id} className="p-4">
              <div className="flex items-center gap-3 flex-wrap">
                <Avatar gradient="from-arc-primary to-arc-accent" name={u.name} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-arc-text">{u.name}</span>
                    <span className="text-[11px] text-arc-faint font-mono">{u.uid}</span>
                    {u.handle && <span className="text-[11px] text-arc-muted">{u.handle}</span>}
                    <span className={`text-[10px] font-pixel px-1.5 py-0.5 rounded ${u.role === 'Admin' ? 'bg-rose-500/15 text-rose-300' : u.role === 'Seller' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-arc-surface2 text-arc-muted'}`}>{u.role}</span>
                    {u.banned && <span className="text-[10px] font-pixel px-1.5 py-0.5 rounded bg-red-500/20 text-red-300">BANNED</span>}
                  </div>
                  <div className="text-[11px] text-arc-faint mt-0.5">{u.email} · {u.tx_count} tx · {new Date(u.joined_at).toLocaleDateString()}</div>
                  {u.banned && u.banned_reason && <div className="text-[11px] text-red-300 mt-1">Reason: {u.banned_reason}</div>}
                </div>
                <div className="flex items-center gap-2">
                  {!u.banned ? (
                    <Btn size="sm" variant="danger" icon="ban" onClick={() => openActionModal('ban', u.id, u.name)}>Ban</Btn>
                  ) : (
                    <Btn size="sm" variant="emerald" icon="undo" onClick={() => handleUnban(u.id)}>Unban</Btn>
                  )}
                  <select value={u.role} onChange={e => handleRoleChange(u.id, e.target.value)} disabled={u.id === (window.ME?.id)}
                    className="bg-arc-surface/60 ring-1 ring-arc-border rounded-lg px-2 h-9 text-xs text-arc-text outline-none">
                    <option value="Member">Member</option><option value="Buyer">Buyer</option><option value="Seller">Seller</option><option value="Admin">Admin</option>
                  </select>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* === Products === */}
      {tab === 'products' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <input value={productsQ} onChange={e => setProductsQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && fetchProducts()} placeholder="Search products..."
              className="flex-1 min-w-48 bg-arc-surface/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl px-3 h-10 text-sm text-arc-text placeholder-arc-faint outline-none" />
            <select value={productsFilter} onChange={e => { setProductsFilter(e.target.value); setTimeout(fetchProducts, 0); }}
              className="bg-arc-surface/60 ring-1 ring-arc-border rounded-xl px-3 h-10 text-sm text-arc-text outline-none">
              <option value="all">All</option><option value="active">Active</option><option value="frozen">Frozen</option>
            </select>
            <Btn size="sm" variant="ghost" icon="search" onClick={fetchProducts}>Search</Btn>
          </div>
          {productsLoading && <div className="text-sm text-arc-muted py-8 text-center">Loading products...</div>}
          {!productsLoading && products.length === 0 && <Empty icon="package" text="No products found." />}
          {products.map(p => (
            <Card key={p.id} className="p-4">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="w-10 h-10 rounded-xl bg-arc-primary/15 text-arc-accent flex items-center justify-center shrink-0"><Icon name="package" size={18} /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-arc-text">{p.name}</span>
                    {p.frozen && <span className="text-[10px] font-pixel px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300">FROZEN</span>}
                    <span className={`text-[10px] font-pixel px-1.5 py-0.5 rounded ${p.status === 'active' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-arc-surface2 text-arc-muted'}`}>{p.status}</span>
                  </div>
                  <div className="text-[11px] text-arc-faint mt-0.5">{p.store_name} · {p.category || 'uncategorized'} · stock {p.stock} · sold {p.sold}</div>
                  {p.frozen && p.frozen_reason && <div className="text-[11px] text-cyan-300 mt-1">Reason: {p.frozen_reason}</div>}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <Usdc value={Number(p.price) / 1000000} className="text-emerald-400 font-bold" />
                  {p.frozen ? (
                    <Btn size="sm" variant="emerald" icon="unlock" onClick={() => handleUnfreezeProduct(p.id)}>Unfreeze</Btn>
                  ) : (
                    <Btn size="sm" variant="danger" icon="snowflake" onClick={() => openActionModal('freeze_product', p.id, p.name)}>Freeze</Btn>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* === Stores === */}
      {tab === 'stores' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <input value={storesQ} onChange={e => setStoresQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && fetchStores()} placeholder="Search stores..."
              className="flex-1 min-w-48 bg-arc-surface/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl px-3 h-10 text-sm text-arc-text placeholder-arc-faint outline-none" />
            <select value={storesFilter} onChange={e => { setStoresFilter(e.target.value); setTimeout(fetchStores, 0); }}
              className="bg-arc-surface/60 ring-1 ring-arc-border rounded-xl px-3 h-10 text-sm text-arc-text outline-none">
              <option value="all">All</option><option value="active">Active</option><option value="frozen">Frozen</option>
            </select>
            <Btn size="sm" variant="ghost" icon="search" onClick={fetchStores}>Search</Btn>
          </div>
          {storesLoading && <div className="text-sm text-arc-muted py-8 text-center">Loading stores...</div>}
          {!storesLoading && stores.length === 0 && <Empty icon="store" text="No stores found." />}
          {stores.map(s => (
            <Card key={s.id} className="p-4">
              <div className="flex items-center gap-3 flex-wrap">
                <Avatar gradient="from-cyan-500 to-blue-600" name={s.name} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-arc-text">{s.name}</span>
                    {s.frozen && <span className="text-[10px] font-pixel px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300">FROZEN</span>}
                    {s.handle && <span className="text-[11px] text-arc-muted">{s.handle}</span>}
                    <span className="text-[11px] text-amber-400">★ {Number(s.rating).toFixed(1)} ({s.rating_count})</span>
                  </div>
                  <div className="text-[11px] text-arc-faint mt-0.5">{s.owner_name} · {s.owner_email}</div>
                  {s.frozen && s.frozen_reason && <div className="text-[11px] text-cyan-300 mt-1">Reason: {s.frozen_reason}</div>}
                </div>
                {s.frozen ? (
                  <Btn size="sm" variant="emerald" icon="unlock" onClick={() => handleUnfreezeStore(s.id)}>Unfreeze</Btn>
                ) : (
                  <Btn size="sm" variant="danger" icon="snowflake" onClick={() => openActionModal('freeze_store', s.id, s.name)}>Freeze Store</Btn>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* === Sales Summary === */}
      {tab === 'sales' && (
        <div className="space-y-5">
          {salesLoading && <div className="text-sm text-arc-muted py-8 text-center">Loading sales data...</div>}
          {!salesLoading && salesSummary && (
            <>
              {/* Combined overview */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <AdmStat icon="dollar-sign" label="Total Volume" value={(salesSummary.combined?.totalVolume ?? 0).toFixed(2) + ' USDC'} sub="marketplace + escrow" tone="emerald" />
                <AdmStat icon="percent" label="Total Revenue" value={(salesSummary.combined?.totalRevenue ?? 0).toFixed(2) + ' USDC'} sub="platform fees + base" tone="violet" />
                <AdmStat icon="shopping-bag" label="Total Orders" value={salesSummary.combined?.totalOrders ?? 0} sub="completed" tone="amber" />
                <AdmStat icon="trending-up" label="Avg Order" value={((salesSummary.combined?.totalVolume ?? 0) / Math.max(1, salesSummary.combined?.totalOrders ?? 1)).toFixed(2) + ' USDC'} sub="per transaction" tone="rose" />
              </div>

              {/* Marketplace vs Escrow split */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {/* Marketplace */}
                <Card className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="text-sm font-semibold text-arc-text flex items-center gap-2"><Icon name="store" size={16} className="text-arc-accent" /> Marketplace</div>
                    <span className="text-[10px] font-pixel px-2 py-1 rounded bg-arc-accent/15 text-arc-accent">2% FEE</span>
                  </div>
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-arc-muted">Volume</span>
                      <span className="text-emerald-400 font-mono font-semibold">{(salesSummary.marketplace?.totalVolume ?? 0).toFixed(2)} USDC</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-arc-muted">Platform Fees (2%)</span>
                      <span className="text-violet-400 font-mono font-semibold">{(salesSummary.marketplace?.platformFees ?? 0).toFixed(2)} USDC</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-arc-muted">Orders</span>
                      <span className="text-arc-text font-mono">{salesSummary.marketplace?.totalOrders ?? 0}</span>
                    </div>
                  </div>
                  <div className="mt-4 pt-4 border-t border-arc-border">
                    <div className="text-xs font-semibold text-arc-faint mb-2 uppercase tracking-wide">Top Sellers</div>
                    <div className="space-y-2">
                      {(salesSummary.marketplace?.topSellers || []).map((s, i) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2"><span className="text-arc-faint w-4">{i+1}</span> <span className="text-arc-text">{s.name}</span> <span className="text-arc-faint">{s.orderCount} orders</span></div>
                          <span className="text-emerald-400 font-mono font-semibold">{s.volume.toFixed(2)} USDC</span>
                        </div>
                      ))}
                      {(!salesSummary.marketplace?.topSellers || salesSummary.marketplace.topSellers.length === 0) && <div className="text-xs text-arc-faint text-center py-3">No data</div>}
                    </div>
                  </div>
                </Card>

                {/* WL Escrow */}
                <Card className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="text-sm font-semibold text-arc-text flex items-center gap-2"><Icon name="shield-check" size={16} className="text-amber-400" /> WL Escrow</div>
                    <span className="text-[10px] font-pixel px-2 py-1 rounded bg-amber-500/15 text-amber-300">2% FEE</span>
                  </div>
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-arc-muted">Volume</span>
                      <span className="text-emerald-400 font-mono font-semibold">{(salesSummary.escrow?.totalVolume ?? 0).toFixed(2)} USDC</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-arc-muted">Base Fee Revenue</span>
                      <span className="text-amber-400 font-mono font-semibold">{(salesSummary.escrow?.baseFeeRevenue ?? 0).toFixed(2)} USDC</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-arc-muted">Circle/Gas Revenue</span>
                      <span className="text-cyan-400 font-mono font-semibold">{(salesSummary.escrow?.circleGasRevenue ?? 0).toFixed(2)} USDC</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-arc-muted">Deals</span>
                      <span className="text-arc-text font-mono">{salesSummary.escrow?.totalDeals ?? 0}</span>
                    </div>
                  </div>
                  <div className="mt-4 pt-4 border-t border-arc-border">
                    <div className="text-xs font-semibold text-arc-faint mb-2 uppercase tracking-wide">Top Escrow Sellers</div>
                    <div className="space-y-2">
                      {(salesSummary.escrow?.topSellers || []).map((s, i) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2"><span className="text-arc-faint w-4">{i+1}</span> <span className="text-arc-text">{s.name}</span> <span className="text-arc-faint">{s.dealCount} deals</span></div>
                          <span className="text-emerald-400 font-mono font-semibold">{s.volume.toFixed(2)} USDC</span>
                        </div>
                      ))}
                      {(!salesSummary.escrow?.topSellers || salesSummary.escrow.topSellers.length === 0) && <div className="text-xs text-arc-faint text-center py-3">No data</div>}
                    </div>
                  </div>
                </Card>
              </div>

              {/* Top Products (marketplace only) */}
              <Card className="p-5">
                <div className="text-sm font-semibold text-arc-text mb-4 flex items-center gap-2"><Icon name="package" size={16} className="text-arc-accent" /> Top Products (Marketplace)</div>
                <div className="space-y-2.5">
                  {(salesSummary.marketplace?.topProducts || []).map((p, i) => (
                    <div key={i} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2"><span className="text-arc-faint w-5">{i+1}</span> <span className="text-arc-text">{p.name}</span> <span className="text-[11px] text-arc-faint">{p.sold} sold</span></div>
                      <span className="text-emerald-400 font-mono font-semibold">{p.revenue.toFixed(2)} USDC</span>
                    </div>
                  ))}
                  {(!salesSummary.marketplace?.topProducts || salesSummary.marketplace.topProducts.length === 0) && <div className="text-sm text-arc-faint text-center py-4">No sales data yet</div>}
                </div>
              </Card>
            </>
          )}
        </div>
      )}

      {/* === MM Stats === */}
      {tab === 'mmstats' && (
        <div className="space-y-3">
          {mmStatsLoading && <div className="text-sm text-arc-muted py-8 text-center">Loading MM stats...</div>}
          {!mmStatsLoading && mmStats.length === 0 && <Empty icon="shield-check" text="No middleman activity yet." />}
          {mmStats.map((m, i) => (
            <Card key={i} className="p-4">
              <div className="flex items-center gap-3 flex-wrap">
                <Avatar gradient="from-violet-500 to-arc-accent" name={m.middlemanName || m.name || 'MM'} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-arc-text">{m.middlemanName || m.name || 'Unknown MM'}</div>
                  <div className="text-[11px] text-arc-faint mt-0.5 flex gap-3">
                    <span className="text-emerald-400">{m.releaseCount || m.releases || 0} releases</span>
                    <span className="text-rose-400">{m.refundCount || m.refunds || 0} refunds</span>
                    <span>{m.dealCount || m.totalDeals || 0} total deals</span>
                    {m.lastActionAt && <span>· last: {new Date(m.lastActionAt).toLocaleDateString()}</span>}
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* === Reports === */}
      {tab === 'reports' && (
        <div className="space-y-3">
          {reportsLoading && <div className="text-sm text-arc-muted py-8 text-center">Loading reports...</div>}
          {!reportsLoading && reports.length === 0 && <Empty icon="flag" text="No reports submitted." />}
          {reports.map(r => (
            <Card key={r.id} className="p-4">
              <div className="flex items-start gap-3 flex-wrap">
                <div className="w-10 h-10 rounded-xl bg-rose-500/15 text-rose-300 flex items-center justify-center shrink-0"><Icon name="flag" size={18} /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-arc-text">{r.reason}</span>
                    <span className="text-[10px] font-pixel px-1.5 py-0.5 rounded bg-arc-surface2 text-arc-muted">{r.targetType?.toUpperCase()}</span>
                    <span className={`text-[10px] font-pixel px-1.5 py-0.5 rounded ${r.status === 'pending' ? 'bg-amber-500/15 text-amber-300' : r.status === 'resolved' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>{r.status?.toUpperCase()}</span>
                  </div>
                  {r.detail && <div className="text-[12px] text-arc-muted mt-1" style={{ textWrap: 'pretty' }}>{r.detail}</div>}
                  <div className="text-[11px] text-arc-faint mt-1">by {r.reporterName} · {new Date(r.createdAt).toLocaleDateString()}</div>
                </div>
                {r.status === 'pending' && (
                  <div className="flex gap-2">
                    <Btn size="sm" variant="emerald" icon="check" onClick={() => handleReportAction(r.id, 'resolved')}>Resolve</Btn>
                    <Btn size="sm" variant="danger" icon="x" onClick={() => handleReportAction(r.id, 'dismissed')}>Dismiss</Btn>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* === Enhanced Audit Log === */}
      {tab === 'log' && (
        <div className="space-y-4">
          {/* Filters & Actions */}
          <Card className="p-4">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
              <input value={logSearch} onChange={e => setLogSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && fetchAuditLog()} placeholder="Search actor, action, ref..."
                className="md:col-span-2 bg-arc-surface/60 ring-1 ring-arc-border focus:ring-rose-500/50 rounded-xl px-3 h-10 text-sm text-arc-text placeholder-arc-faint outline-none" />
              <input type="date" value={logDateFrom} onChange={e => setLogDateFrom(e.target.value)}
                className="bg-arc-surface/60 ring-1 ring-arc-border rounded-xl px-3 h-10 text-sm text-arc-text outline-none" title="From date" />
              <input type="date" value={logDateTo} onChange={e => setLogDateTo(e.target.value)}
                className="bg-arc-surface/60 ring-1 ring-arc-border rounded-xl px-3 h-10 text-sm text-arc-text outline-none" title="To date" />
              <select value={logActionFilter} onChange={e => setLogActionFilter(e.target.value)}
                className="bg-arc-surface/60 ring-1 ring-arc-border rounded-xl px-3 h-10 text-sm text-arc-text outline-none">
                <option value="all">All Actions</option>
                {LOG_ACTION_TYPES.map(a => (<option key={a} value={a}>{a.replace('_', ' ')}</option>))}
              </select>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
              <select value={logActorFilter} onChange={e => setLogActorFilter(e.target.value)}
                className="bg-arc-surface/60 ring-1 ring-arc-border rounded-xl px-3 h-10 text-sm text-arc-text outline-none">
                <option value="all">All Actors</option>
                <option value="user">User</option>
                <option value="platform">Platform</option>
                <option value="auto_release">Auto Release</option>
              </select>
              <div className="flex items-center gap-2 justify-end">
                <span className="text-xs text-arc-muted">{filteredLog.length} entries</span>
                <Btn size="sm" variant="emerald" icon="download" onClick={exportLogCSV}>Export CSV</Btn>
              </div>
            </div>
          </Card>

          {/* Log Table */}
          <Card className="overflow-hidden">
            <div className="divide-y divide-arc-border/60 max-h-96 overflow-y-auto">
              {logLoading && Array.from({ length: 8 }).map((_, i) => <SkelRow key={i} cols={4} />)}
              {!logLoading && logPageItems.length === 0 && <EmptyState text="No audit entries match filters" />}
              {!logLoading && logPageItems.map(l => {
                const toneCls = { RELEASE: 'bg-emerald-500/15 text-emerald-300', REFUND: 'bg-rose-500/15 text-rose-300', APPROVE: 'bg-emerald-500/15 text-emerald-300', REJECT: 'bg-rose-500/15 text-rose-300', BAN_USER: 'bg-rose-500/15 text-rose-300', FREEZE_PRODUCT: 'bg-cyan-500/15 text-cyan-300', FREEZE_STORE: 'bg-cyan-500/15 text-cyan-300' }[l.action] || 'bg-arc-surface2 text-arc-muted';
                const ic = { RELEASE: 'check-check', REFUND: 'undo-2', APPROVE: 'user-check', REJECT: 'user-x', BAN_USER: 'ban', FREEZE_PRODUCT: 'snowflake', FREEZE_STORE: 'snowflake', TREASURY_WITHDRAW: 'arrow-up-right', COLLECT_FEES: 'send' }[l.action] || 'dot';
                return (
                  <div key={l.createdAt || l.created_at} onClick={() => setLogExpandedRow(logExpandedRow === l.id ? null : l.id)} className={`flex items-center gap-3 px-4 py-3 hover:bg-arc-surface2/30 cursor-pointer transition ${logExpandedRow === l.id ? 'bg-arc-surface2/50' : ''}`}>
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${toneCls}`}><Icon name={ic} size={15} /></div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-arc-text"><span className="font-pixel text-[8px] mr-2 text-arc-muted">{l.action}</span><span className="font-mono text-xs text-arc-muted truncate block">{l.ref}</span></div>
                    <div className="text-[12px] text-arc-faint truncate">{l.actor || l.by || 'unknown'}</div>
                  </div>
                    <div className="text-[11px] text-arc-faint shrink-0 whitespace-nowrap">{l.time ? new Date(l.time).toLocaleString() : '-'}</div>
                  </div>
                );
              })}
            </div>
            {logExpandedRow && (() => { const row = logFull.find(l => l.createdAt === logExpandedRow || l.created_at === logExpandedRow); if (!row) return null; return (<div className="bg-arc-bg/60 border-t border-arc-border p-4 animate-fade-in"><pre className="text-xs text-arc-muted whitespace-pre-wrap overflow-auto max-h-40">{row.detailStr}</pre></div>); })()}

            {/* Pagination */}
            {logPageCount > 1 && (
              <div className="flex items-center justify-between px-4 py-3 bg-arc-surface/30 border-t border-arc-border/60">
                <Btn size="sm" variant="ghost" disabled={logPage === 0} onClick={() => setLogPage(p => Math.max(0, p - 1))}><Icon name="chevron-left" size={14} /></Btn>
                <span className="text-xs text-arc-muted">Page {logPage + 1} of {logPageCount}</span>
                <Btn size="sm" variant="ghost" disabled={logPage >= logPageCount - 1} onClick={() => setLogPage(p => Math.min(logPageCount - 1, p + 1))}><Icon name="chevron-right" size={14} /></Btn>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* === Disputes === */}
      {tab === 'disputes' && (
        <div className="space-y-3">
          {disputesLoading && <div className="text-sm text-arc-muted py-8 text-center">Loading disputes...</div>}
          {!disputesLoading && disputes.length === 0 && (
            <div className="text-center py-16">
              <Icon name="party-popper" size={32} className="text-emerald-400 mx-auto mb-3" />
              <div className="text-sm text-arc-muted">No active disputes. All clear!</div>
            </div>
          )}
          {disputes.map(d => (
            <Card key={d.orderId} className="p-4">
              <div className="flex items-start gap-3 flex-wrap">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-rose-500/15 text-rose-300">
                  <Icon name="gavel" size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs text-arc-muted">{d.orderId?.slice(0, 8)}…</span>
                    <PixBadge color="rose">DISPUTED</PixBadge>
                  </div>
                  <div className="text-sm font-semibold text-arc-text mt-1">{d.productName}</div>
                  <div className="text-[12px] text-arc-muted mt-1">
                    Buyer: {d.buyerName} · Seller: {d.sellerName} · Amount: {Number(d.amount) / 1000000} USDC
                  </div>
                  {d.reason && <div className="text-[12px] text-arc-muted mt-1">Reason: {d.reason}</div>}
                  {d.chatThreadId && (
                    <a href={'/chat'} onClick={(e) => { e.preventDefault(); window.SlimeRouter?.pushPath?.('dm', {}); }} className="text-[11px] text-arc-accent hover:brightness-125 mt-1 inline-block">Open Tribunal Chat →</a>
                  )}
                </div>
                <div className="flex gap-2 ml-auto">
                  <Btn size="sm" variant="danger" icon="undo-2" onClick={() => setResolveTarget({ orderId: d.orderId, decision: 'refund' })}>Refund Buyer</Btn>
                  <Btn size="sm" variant="emerald" icon="check-check" onClick={() => setResolveTarget({ orderId: d.orderId, decision: 'release' })}>Release to Seller</Btn>
                </div>
              </div>
            </Card>
          ))}

          {/* Resolve modal */}
          {resolveTarget && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setResolveTarget(null)}>
              <Card className="p-6 max-w-md w-full mx-4" onClick={e => e.stopPropagation()}>
                <h3 className="text-lg font-bold text-arc-text mb-2">Resolve Dispute</h3>
                <p className="text-sm text-arc-muted mb-4">
                  Decision: <span className={resolveTarget.decision === 'refund' ? 'text-rose-300' : 'text-emerald-300'}>{resolveTarget.decision === 'refund' ? 'Refund Buyer' : 'Release to Seller'}</span>
                </p>
                <textarea
                  id="resolve-reason"
                  rows={3}
                  placeholder="Enter reason for this decision..."
                  className="w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-rose-500/50 rounded-xl px-3 py-2 text-sm text-arc-text placeholder-arc-faint outline-none resize-none mb-4"
                />
                <div className="flex gap-2 justify-end">
                  <Btn variant="ghost" onClick={() => setResolveTarget(null)}>Cancel</Btn>
                  <Btn variant={resolveTarget.decision === 'refund' ? 'danger' : 'emerald'} icon="gavel"
                    onClick={() => {
                      const reason = (document.getElementById('resolve-reason')?.value || '').trim();
                      resolveDispute(resolveTarget.orderId, resolveTarget.decision, reason);
                    }}>Confirm {resolveTarget.decision === 'refund' ? 'Refund' : 'Release'}</Btn>
                </div>
              </Card>
            </div>
          )}
        </div>
      )}

      {/* === Middlemen (MM) === */}
      {tab === 'middlemen' && (
        <div className="space-y-3">
          <Card className="p-4">
            <div className="flex items-center gap-2 flex-wrap">
              <input value={mmEmail} onChange={e => setMmEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && addMiddleman()} placeholder={tr('admin.mmEmailPh','User email to promote to MM…')}
                className="flex-1 min-w-[220px] bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
              <Btn variant="primary" icon="user-plus" disabled={mmAddBusy || !mmEmail.trim()} onClick={addMiddleman}>{mmAddBusy ? tr('admin.mmAdding','Adding…') : tr('admin.mmAdd','Add Middleman')}</Btn>
            </div>
            <div className="text-[11px] text-arc-faint mt-2 flex items-start gap-1.5"><Icon name="info" size={11} className="mt-0.5 shrink-0" /> {tr('admin.mmHint','MMs can release or refund WL escrow deals (PIN + device verified, platform-relayed). Promotion: Member/Buyer/Seller → MM. All changes are audit-logged.')}</div>
          </Card>
          {mmsLoading && <div className="text-sm text-arc-muted py-8 text-center">Loading middlemen...</div>}
          {!mmsLoading && mms.length === 0 && (
            <div className="text-center py-16">
              <Icon name="shield-check" size={32} className="text-arc-faint mx-auto mb-3" />
              <div className="text-sm text-arc-muted">{tr('admin.mmNone','No middlemen yet. Add one by email above.')}</div>
            </div>
          )}
          {mms.map(m => (
            <Card key={m.id} className="p-4">
              <div className="flex items-start gap-3 flex-wrap">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-arc-primary/15 text-arc-accent">
                  <Icon name="shield-check" size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-arc-text">{m.name}</span>
                    <PixBadge color="violet">MM</PixBadge>
                    {m.handle && <span className="text-[11px] text-arc-faint">@{String(m.handle).replace(/^@/, '')}</span>}
                  </div>
                  <div className="text-[12px] text-arc-muted mt-1">{m.email}</div>
                  <div className="text-[11px] text-arc-faint mt-1">
                    {m.address
                      ? <span className="font-mono" title={m.address}>{String(m.address).slice(0, 10)}…{String(m.address).slice(-8)}</span>
                      : <span>{tr('admin.mmNoWallet','No wallet address')}</span>}
                    {m.joinedAt ? <span> · {tr('admin.since','since')} {new Date(m.joinedAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</span> : null}
                  </div>
                </div>
                <div className="flex gap-2 ml-auto">
                  <Btn size="sm" variant="primary" icon="key-round" onClick={() => { setMmPinModal(m); setMmPinValue(''); setMmPinConfirm(''); setMmPinError(''); }}>{tr('admin.mmSetPin','Set PIN')}</Btn>
                  <Btn size="sm" variant="danger" icon="user-minus" onClick={() => revokeMiddleman(m)}>{tr('admin.mmRevoke','Revoke')}</Btn>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* === Enhanced Treasury === */}
      {tab === 'treasury' && (
        <div className="space-y-5 anim-fade">
          {treasuryLoading && <div className="text-sm text-arc-muted py-8 text-center">Loading treasury data...</div>}
          {!treasuryLoading && treasuryData && (
            <>
              {/* Real-time Platform DCW Balance & Quick Stats */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <AdmStat icon="wallet" label="Platform DCW Balance" value={(dashboard?.platformBalance ?? treasuryData.balances?.totalAvailable ?? 0).toFixed(2) + ' USDC'} sub="real-time" tone="violet" loading={dashboardLoading} />
                <AdmStat icon="percent" label="Collected Fees" value={(treasuryData.collectedFees?.total ?? 0).toFixed(2) + ' USDC'} sub="all-time" tone="emerald" />
                <AdmStat icon="arrow-right-left" label="Pending Escrow Fees" value={(treasuryData.collectedFees?.escrow?.baseFee ?? 0).toFixed(2) + ' USDC'} sub="2% × deal volume" tone="amber" loading={!treasuryData} />
                <AdmStat icon="arrow-right-left" label="Pending Marketplace Fees" value={(treasuryData.collectedFees?.marketplace?.platformFee ?? 0).toFixed(2) + ' USDC'} sub="2% × volume" tone="rose" loading={!treasuryData} />
              </div>

              {/* Reconcile Status Indicator */}
              {checkReconcile() && (() => {
                const r = checkReconcile();
                if (!r) return null;
                return (
                  <Card className={`p-4 flex items-center justify-between ${r.balanced ? 'bg-emerald-500/5 ring-1 ring-emerald-500/30' : 'bg-rose-500/5 ring-1 ring-rose-500/30'}`}>
                    <div className="flex items-center gap-3">
                      <Icon name={r.balanced ? 'circle-check-big' : 'alert-triangle'} size={20} className={r.balanced ? 'text-emerald-400' : 'text-rose-400'} />
                      <div>
                        <div className={`text-sm font-semibold ${r.balanced ? 'text-emerald-300' : 'text-rose-300'}`}>{r.balanced ? 'Treasury Reconciliation: BALANCED' : 'Treasury Reconciliation: DRIFT DETECTED'}</div>
                        {!r.balanced && <div className="text-xs text-arc-muted mt-0.5">Collected: {(r.collected).toFixed(2)} USDC · Available: {(r.balance).toFixed(2)} USDC · Drift: {(r.drift).toFixed(2)} USDC</div>}
                      </div>
                    </div>
                    <span className="text-[10px] font-pixel px-2 py-1 rounded bg-arc-accent/15 text-arc-accent">AUTO-CHECK</span>
                  </Card>
                );
              })()}

              {/* Fee Collection */}
              <Card className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-sm font-semibold text-arc-text flex items-center gap-2"><Icon name="send" size={16} className="text-emerald-400" /> Fee Collection</div>
                  <Btn size="sm" variant="emerald" icon={collectFeesLoading ? 'loader' : 'zap'} onClick={handleCollectFees} disabled={collectFeesLoading}>{collectFeesLoading ? 'Collecting...' : 'Collect Fees'}</Btn>
                </div>
                <div className="text-sm text-arc-muted">
                  This action transfers all collected marketplace and escrow fees to the platform treasury wallet.
                  Fees are collected per-order but may not yet be in the treasury account.
                </div>
              </Card>

              {/* Treasury Balances */}
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
                <AdmStat icon="wallet" label="Total Available" value={(treasuryData.balances?.totalAvailable ?? 0).toFixed(2) + ' USDC'} sub="withdrawable" tone="emerald" loading={!treasuryData} />
                <AdmStat icon="percent" label="Platform Fee Pool" value={(treasuryData.balances?.platformFee?.available ?? 0).toFixed(2) + ' USDC'} sub="2% marketplace" tone="violet" loading={!treasuryData} />
                <AdmStat icon="fuel" label="Gas Pool" value={(treasuryData.balances?.gasPool?.available ?? 0).toFixed(2) + ' USDC'} sub="circle+gas+base" tone="amber" loading={!treasuryData} />
                <AdmStat icon="banknote" label="Total Collected" value={(treasuryData.collectedFees?.total ?? 0).toFixed(2) + ' USDC'} sub="all-time" tone="rose" loading={!treasuryData} />
              </div>

              {/* Fee Breakdown by Source */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {/* Marketplace fees */}
                <Card className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="text-sm font-semibold text-arc-text flex items-center gap-2"><Icon name="store" size={16} className="text-arc-accent" /> Marketplace Fees</div>
                    <span className="text-[10px] font-pixel px-2 py-1 rounded bg-arc-accent/15 text-arc-accent">2% + GAS</span>
                  </div>
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-arc-muted">Platform Fee (2%)</span>
                      <span className="text-violet-400 font-mono font-semibold">{(treasuryData.collectedFees?.marketplace?.platformFee ?? 0).toFixed(2)} USDC</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-arc-muted">Circle + Gas</span>
                      <span className="text-cyan-400 font-mono font-semibold">{(treasuryData.collectedFees?.marketplace?.gasPool ?? 0).toFixed(2)} USDC</span>
                    </div>
                    <div className="flex items-center justify-between text-sm pt-2 border-t border-arc-border">
                      <span className="text-arc-text font-semibold">Subtotal</span>
                      <span className="text-emerald-400 font-mono font-bold">{(treasuryData.collectedFees?.marketplace?.total ?? 0).toFixed(2)} USDC</span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-arc-faint">
                      <span>Orders: {treasuryData.stats?.marketplace?.orders ?? 0}</span>
                      <span>Volume: {(treasuryData.stats?.marketplace?.volume ?? 0).toFixed(2)} USDC</span>
                    </div>
                  </div>
                </Card>

                {/* WL Escrow fees */}
                <Card className="p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div className="text-sm font-semibold text-arc-text flex items-center gap-2"><Icon name="shield-check" size={16} className="text-amber-400" /> Escrow (WL) Fees</div>
                    <span className="text-[10px] font-pixel px-2 py-1 rounded bg-amber-500/15 text-amber-300">2% FEE + GAS</span>
                  </div>
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-arc-muted">Escrow Fee (2%)</span>
                      <span className="text-amber-400 font-mono font-semibold">{(treasuryData.collectedFees?.escrow?.baseFee ?? 0).toFixed(2)} USDC</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-arc-muted">Circle + Gas</span>
                      <span className="text-cyan-400 font-mono font-semibold">{(treasuryData.collectedFees?.escrow?.gasPool ?? 0).toFixed(2)} USDC</span>
                    </div>
                    <div className="flex items-center justify-between text-sm pt-2 border-t border-arc-border">
                      <span className="text-arc-text font-semibold">Subtotal</span>
                      <span className="text-emerald-400 font-mono font-bold">{(treasuryData.collectedFees?.escrow?.total ?? 0).toFixed(2)} USDC</span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-arc-faint">
                      <span>Deals: {treasuryData.stats?.escrow?.deals ?? 0}</span>
                      <span>Volume: {(treasuryData.stats?.escrow?.volume ?? 0).toFixed(2)} USDC</span>
                    </div>
                  </div>
                </Card>
              </div>

              {/* Treasury Transaction History */}
              <Card className="p-5">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-sm font-semibold text-arc-text flex items-center gap-2"><Icon name="history" size={16} className="text-arc-muted" /> Treasury Transactions</div>
                  <div className="flex gap-2">
                    <Btn size="sm" variant="ghost" icon="refresh-cw" onClick={fetchWalletTxs} loading={walletTxsLoading}>Refresh</Btn>
                    <Btn size="sm" variant="emerald" icon="arrow-up-right" onClick={() => setWithdrawModal(true)}>Withdraw Fee</Btn>
                  </div>
                </div>
                <div className="space-y-2 max-h-72 overflow-y-auto">
                  {walletTxsLoading && <div className="text-sm text-arc-muted py-4 text-center">Loading transactions...</div>}
                  {(walletTxs.length || (treasuryData.auditTrail || []).filter(l => l.action === 'TREASURY_WITHDRAW').length) === 0 && !walletTxsLoading && (
                    <EmptyState text="No treasury transactions yet" />
                  )}
                  {walletTxs.map((tx, i) => (
                    <div key={i} className="flex items-center justify-between text-sm py-2 border-b border-arc-border/40 last:border-0">
                      <div className="flex items-center gap-2">
                        <span className="text-arc-faint font-mono text-xs">{(tx.sourceAccount || tx.account || 'gas_pool').toUpperCase()}</span>
                        <span className="text-arc-text">{tx.recipientName || tx.to || 'Unknown'}</span>
                        <span className="text-arc-faint text-xs">{tx.memo || ''}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-emerald-400 font-mono font-semibold">{Number(tx.amountUsdc || tx.amount || 0).toFixed(2)} USDC</span>
                        <span className="text-[10px] font-pixel px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300">{tx.status === 'success' ? 'SUCCESS' : 'PENDING'}</span>
                      </div>
                    </div>
                  ))}
                  {walletTxs.length === 0 && treasuryData.auditTrail && (
                    <>{treasuryData.auditTrail.filter(l => l.action === 'TREASURY_WITHDRAW').map((l, i) => {
                      const d = l.detail || l.metadata || {};
                      return (
                        <div key={i} className="flex items-center justify-between text-sm py-2 border-b border-arc-border/40 last:border-0">
                          <div className="flex items-center gap-2">
                            <span className="text-arc-faint font-mono text-xs">{(d.sourceAccount || 'gas_pool').toUpperCase()}</span>
                            <span className="text-arc-text">{d.recipientName || 'Unknown'}</span>
                            <span className="text-arc-faint text-xs">{d.memo || ''}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-emerald-400 font-mono font-semibold">{d.amount || '0'} USDC</span>
                            <span className="text-[10px] font-pixel px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300">PAID</span>
                          </div>
                        </div>
                      );
                    })}</>
                  )}
                </div>
              </Card>

              {/* Contract info */}
              <Card className="p-4">
                <div className="flex items-center gap-3 text-xs text-arc-faint">
                  <Icon name="link" size={14} className="text-arc-muted" />
                  <span>Treasury: <span className="font-mono text-arc-muted">{treasuryData.treasury || 'not configured'}</span></span>
                  <span>·</span>
                  <span>Contract: <span className="font-mono text-arc-muted">{treasuryData.escrowContract || 'not deployed'}</span></span>
                  <span>·</span>
                  <span className={treasuryData.contractReady ? 'text-emerald-400' : 'text-arc-faint'}>{treasuryData.contractReady ? 'READY' : 'NOT READY'}</span>
                </div>
              </Card>
            </>
          )}
          {!treasuryLoading && !treasuryData && (
            <Card className="py-16 flex flex-col items-center gap-3">
              <div className="w-14 h-14 rounded-2xl bg-arc-surface2/60 ring-1 ring-arc-border flex items-center justify-center"><Icon name="wallet" size={26} className="text-arc-faint" /></div>
              <div className="text-sm text-arc-muted">Failed to load treasury data</div>
              <Btn size="sm" variant="ghost" icon="refresh-cw" onClick={fetchTreasury}>Retry</Btn>
            </Card>
          )}
        </div>
      )}

      {/* === Action Modal (ban/freeze) === */}
      <Modal open={!!actionModal} onClose={() => setActionModal(null)} width="max-w-md">
        <Card className="overflow-hidden">
          <div className="flex items-center gap-3 px-5 py-4 border-b border-arc-border bg-rose-500/5">
            <div className="w-10 h-10 rounded-xl bg-rose-500/15 ring-1 ring-rose-500/30 flex items-center justify-center text-rose-300"><Icon name={actionModal?.type?.includes('store') ? 'store' : actionModal?.type?.includes('product') ? 'package' : 'ban'} size={18} /></div>
            <div>
              <div className="font-semibold text-arc-text">{actionModal?.type === 'ban' ? 'Ban User' : actionModal?.type === 'freeze_product' ? 'Freeze Product' : 'Freeze Store'}</div>
              <div className="text-xs text-arc-muted">{actionModal?.name}</div>
            </div>
            <button onClick={() => setActionModal(null)} className="ml-auto w-8 h-8 rounded-lg hover:bg-arc-surface2 text-arc-muted flex items-center justify-center"><Icon name="x" size={16} /></button>
          </div>
          <div className="p-5 space-y-4">
            {actionModal?.type === 'freeze_store' && (
              <div className="rounded-xl ring-1 ring-amber-500/30 bg-amber-500/5 px-3.5 py-2.5 text-[11px] text-amber-300">
                All products in this store will also be frozen.
              </div>
            )}
            <div>
              <div className="text-xs uppercase tracking-wide text-arc-faint mb-2">Reason (optional)</div>
              <textarea rows={2} value={actionReason} onChange={e => setActionReason(e.target.value)} placeholder="Reason for this action..."
                className="w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-rose-500/40 rounded-xl px-3 py-2.5 text-sm text-arc-text placeholder-arc-faint outline-none resize-none"></textarea>
            </div>
            <div className="flex gap-3">
              <Btn variant="ghost" full onClick={() => setActionModal(null)}>Cancel</Btn>
              <Btn variant="danger" full icon="gavel" onClick={confirmAction}>Confirm</Btn>
            </div>
          </div>
        </Card>
      </Modal>

      {/* === Treasury Withdraw Modal (Simplified — Send to Address) === */}
      <Modal open={withdrawModal} onClose={() => setWithdrawModal(false)} width="max-w-md">
        <Card className="overflow-hidden">
          <div className="flex items-center gap-3 px-5 py-4 border-b border-arc-border bg-emerald-500/5">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/15 ring-1 ring-emerald-500/30 flex items-center justify-center text-emerald-300"><Icon name="send" size={18} /></div>
            <div>
              <div className="font-semibold text-arc-text">Send Treasury Payout</div>
              <div className="text-xs text-arc-muted">Transfer USDC to any Arc wallet address</div>
            </div>
            <button onClick={() => setWithdrawModal(false)} className="ml-auto w-8 h-8 rounded-lg hover:bg-arc-surface2 text-arc-muted flex items-center justify-center"><Icon name="x" size={16} /></button>
          </div>
          <div className="p-5 space-y-4">
            {/* Wallet Address */}
            <div>
              <div className="text-xs uppercase tracking-wide text-arc-faint mb-2">Recipient Address</div>
              <input
                value={withdrawForm.targetWalletAddress}
                onChange={e => setWithdrawForm(f => ({ ...f, targetWalletAddress: e.target.value }))}
                placeholder="0x..."
                className="w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/40 rounded-xl px-3 py-2.5 text-sm text-arc-text placeholder-arc-faint outline-none font-mono"
              />
            </div>

            {/* Amount */}
            <div>
              <div className="text-xs uppercase tracking-wide text-arc-faint mb-2">Amount (USDC)</div>
              <input type="number" step="0.01" value={withdrawForm.amountUsdc}
                onChange={e => setWithdrawForm(f => ({ ...f, amountUsdc: e.target.value }))}
                placeholder="e.g. 50.00"
                className="w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/40 rounded-xl px-3 py-2.5 text-sm text-arc-text placeholder-arc-faint outline-none" />
            </div>

            {/* Admin PIN */}
            <div>
              <div className="text-xs uppercase tracking-wide text-arc-faint mb-2">Admin PIN</div>
              <input type="password" inputMode="numeric" value={withdrawForm.adminPin}
                onChange={e => { setWithdrawForm(f => ({ ...f, adminPin: e.target.value })); setWithdrawPinError(''); }}
                placeholder="Admin PIN"
                disabled={!!withdrawLockedUntil && new Date(withdrawLockedUntil) > new Date()}
                className="w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-emerald-500/40 rounded-xl px-3 py-2.5 text-sm text-arc-text placeholder-arc-faint outline-none tracking-[0.3em] disabled:opacity-50" />
              <p className="text-[11px] text-arc-faint mt-1.5">Enter admin PIN to confirm payout.</p>
              {withdrawPinError && <p className="text-xs text-rose-400 mt-1.5">{withdrawPinError}</p>}
            </div>

            <div className="flex gap-3">
              <Btn variant="ghost" full onClick={() => { setWithdrawModal(false); setWithdrawPinError(''); setWithdrawLockedUntil(null); }}>Cancel</Btn>
              <Btn variant="emerald" full icon="send" onClick={handleTreasuryWithdraw}
                disabled={withdrawLoading || (!!withdrawLockedUntil && new Date(withdrawLockedUntil) > new Date())}>
                {withdrawLoading ? 'Processing...' : (withdrawLockedUntil && new Date(withdrawLockedUntil) > new Date()) ? 'PIN Locked' : 'Send Payout'}
              </Btn>
            </div>
          </div>
        </Card>
      </Modal>

      {/* === Admin PIN Verification Modal === */}
      {pinModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setPinModal(null)}>
          <Card className="p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-rose-500/15 ring-1 ring-rose-500/30 flex items-center justify-center">
                <Icon name="shield-alert" size={20} className="text-rose-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-arc-text">Admin Verification</h3>
                <p className="text-xs text-arc-muted">Enter your admin PIN to continue</p>
              </div>
            </div>
            <input
              type="password"
              value={pinInput}
              onChange={e => { setPinInput(e.target.value); setPinError(''); }}
              onKeyDown={e => e.key === 'Enter' && handlePinSubmit()}
              placeholder="Enter admin PIN"
              autoFocus
              className="w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-rose-500/50 rounded-xl px-4 py-3 text-center text-lg tracking-[0.3em] text-arc-text placeholder-arc-faint placeholder:tracking-normal outline-none mb-3"
            />
            {pinError && <p className="text-sm text-rose-400 mb-3 text-center">{pinError}</p>}
            <div className="flex gap-2">
              <Btn variant="ghost" full onClick={() => setPinModal(null)}>Cancel</Btn>
              <Btn variant="danger" full icon="lock" onClick={handlePinSubmit} disabled={pinLoading}>
                {pinLoading ? 'Verifying...' : 'Verify'}
              </Btn>
            </div>
            <p className="text-[11px] text-arc-faint text-center mt-3">Token valid for 5 minutes after verification</p>
          </Card>
        </div>
      )}

      {/* set/reset a middleman's PIN. Only an admin can do this, and
          without a PIN a promoted MM cannot pass /api/admin/verify, so the MM
          console (escrow release/refund) is unreachable for them. */}
      {mmPinModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setMmPinModal(null)}>
          <Card className="p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-violet-500/15 ring-1 ring-violet-500/30 flex items-center justify-center">
                <Icon name="key-round" size={20} className="text-violet-300" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-arc-text">{tr('admin.mmSetPinTitle','Set Middleman PIN')}</h3>
                <p className="text-xs text-arc-muted">{mmPinModal.name} · {mmPinModal.email}</p>
              </div>
            </div>
            <div className="text-[11px] text-arc-muted mb-3 leading-relaxed">
              {tr('admin.mmSetPinHelp','The middleman uses this PIN to approve escrow release/refund. Share it with them securely — they can change it later from their profile.')}
            </div>
            <input
              type="password"
              inputMode="numeric"
              value={mmPinValue}
              onChange={e => { setMmPinValue(e.target.value.replace(/\D/g, '').slice(0, 6)); setMmPinError(''); }}
              placeholder={tr('admin.mmNewPin','6-digit PIN')}
              autoFocus
              className="w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-violet-500/50 rounded-xl px-4 py-3 text-center text-lg tracking-[0.3em] text-arc-text placeholder-arc-faint placeholder:tracking-normal outline-none mb-2"
            />
            <input
              type="password"
              inputMode="numeric"
              value={mmPinConfirm}
              onChange={e => { setMmPinConfirm(e.target.value.replace(/\D/g, '').slice(0, 6)); setMmPinError(''); }}
              onKeyDown={e => e.key === 'Enter' && submitMmPin()}
              placeholder={tr('admin.mmConfirmPin','Confirm PIN')}
              className="w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-violet-500/50 rounded-xl px-4 py-3 text-center text-lg tracking-[0.3em] text-arc-text placeholder-arc-faint placeholder:tracking-normal outline-none mb-3"
            />
            {mmPinError && <p className="text-sm text-rose-400 mb-3 text-center">{mmPinError}</p>}
            <div className="flex gap-2">
              <Btn variant="ghost" full onClick={() => setMmPinModal(null)}>{tr('c.cancel','Cancel')}</Btn>
              <Btn variant="primary" full icon="key-round" onClick={submitMmPin}>{tr('admin.mmSavePin','Save PIN')}</Btn>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function Empty({ icon, text }) {
  return (
    <Card className="py-16 flex flex-col items-center gap-3">
      <div className="w-14 h-14 rounded-2xl bg-arc-surface2/60 ring-1 ring-arc-borderlt flex items-center justify-center"><Icon name={icon} size={26} className="text-arc-faint" /></div>
      <div className="text-sm text-arc-muted">{text}</div>
    </Card>
  );
}

function EmptyState({ text }) {
  return (
    <div className="py-16 text-center flex flex-col items-center gap-3 animate-fade-in">
      <Icon name="inbox" size={32} className="text-arc-faint mx-auto mb-2" />
      <div className="text-sm text-arc-muted">{text}</div>
    </div>
  );
}

Object.assign(window, { AdminConsole, AdmStat, Empty });
