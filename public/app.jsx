// ============ SlimeMarket — App shell & state ============

// ============ SlimeMarket — App shell & state ============

// ---- Cart cookie mirror ----
// middleware.ts reads a `slimemarket-cart` cookie and guards /checkout on it.
// Format: `count:encodeURIComponent(JSON.stringify(items))` where count is the
// total quantity. middleware decodes + parses `count` / `items` back out.
// The SPA itself is instant-buy (no persistent cart — localStorage only holds
// slime_authed/slime_lang), so the cart is empty on load and briefly holds the
// in-flight purchase during checkout. Every mutation point routes through
// syncCartCookie() so the middleware view is never stale.
function cartItemsFromProduct(product, qty) {
  const v = (product && Array.isArray(product.variants) && product.variants[0]) || {};
  return product && product.id ? [{
    productId: product.id,
    qty: Number(qty) || 1,
    variantLabel: v.label,
    price: Number(v.price != null ? v.price : product.price) || 0,
  }] : [];
}
function syncCartCookie(items) {
  try {
    const list = Array.isArray(items) ? items : [];
    const count = list.reduce((sum, it) => sum + (Number(it && it.qty) || 0), 0);
    document.cookie = 'slimemarket-cart=' + count + ':' +
      encodeURIComponent(JSON.stringify(list)) +
      '; path=/; max-age=2592000; samesite=lax';
  } catch (e) { /* non-fatal — cookie mirror only */ }
}
function clearCartCookie() { syncCartCookie([]); }
Object.assign(window, { syncCartCookie, clearCartCookie, cartItemsFromProduct });

// Error boundary to prevent blank page on crash
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError: false, error: null }; }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, info) { console.error('SlimeMarket crash:', error, info); }
  render() {
    if (this.state.hasError) {
      return React.createElement('div', { className: 'min-h-screen bg-arc-bg flex items-center justify-center p-8' },
        React.createElement('div', { className: 'max-w-md text-center' },
          React.createElement('h1', { className: 'text-2xl font-bold text-rose-400 mb-4' }, 'Something went wrong'),
          React.createElement('p', { className: 'text-arc-muted mb-4' }, String(this.state.error?.message || 'Unknown error')),
          React.createElement('button', {
            className: 'px-4 py-2 bg-arc-primary text-white rounded-xl',
            // Don't clear the session on a UI crash — the crash is a render bug,
            // not an auth failure. Wiping slime_authed here caused logout-on-crash.
            onClick: () => { window.location.reload(); }
          }, 'Reload App')
        )
      );
    }
    return this.props.children;
  }
}

function Toast({ toast }) {
  if (!toast) return null;
  const c = { success: 'emerald', info: 'blue', error: 'rose' }[toast.type] || 'blue';
  const cls = { emerald: 'ring-emerald-500/40 text-emerald-200 bg-emerald-500/10', blue: 'ring-arc-primary/40 text-arc-accent bg-arc-primary/10', rose: 'ring-rose-500/40 text-rose-200 bg-rose-500/10' }[c];
  const ic = { success: 'check-check', info: 'info', error: 'octagon-alert' }[toast.type] || 'info';
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] anim-modal">
      <div className={`flex items-center gap-2.5 rounded-xl ring-1 backdrop-blur px-4 py-3 text-sm shadow-2xl ${cls}`}>
        <Icon name={ic} size={16} /> {toast.text}
      </div>
    </div>
  );
}

function Sidebar({ active, setView, open, setOpen, role, guest }) {
  const canSell = role === 'Seller' || role === 'Admin';
  const isAdmin = role === 'Admin';
  let nav = NAV_BUYER.filter(n => n.id !== 'seller' || canSell);
  if (guest) nav = nav.filter(n => ['beranda', 'storefront'].includes(n.id));
  // the Middleman console is reachable by Admin AND the new 'MM' DB
  // role (app/api/admin/middlemen grants it); Admin Console stays Admin-only.
  if (isAdmin || role === 'MM') nav = [...nav, { id: 'mm', label: 'Middleman', icon: 'shield', desc: 'Escrow & Tribunal' }];
  if (isAdmin) nav = [...nav, { id: 'admin', label: 'Admin Console', icon: 'shield-alert', desc: 'Users & Stores' }];
  return (
    <>
      {open && <div className="fixed inset-0 bg-arc-bg/70 z-30 lg:hidden anim-fade" onClick={() => setOpen(false)}></div>}
      <aside className={`fixed lg:sticky top-0 z-40 h-screen w-[248px] shrink-0 bg-arc-surface/80 backdrop-blur-xl border-r border-arc-border flex flex-col transition-transform duration-200 ${open ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className="flex items-center gap-2.5 px-5 h-16 border-b border-arc-border">
          <SlimeLogo size={34} />
          <div className="leading-none">
            <div className="font-bold text-[15px] text-white tracking-tight">Slime<span className="text-arc-accent">Market</span></div>
            <Pixel className="text-[7px] text-arc-faint">ARC ESCROW</Pixel>
          </div>
          <button onClick={() => setOpen(false)} className="ml-auto lg:hidden text-arc-muted"><Icon name="x" size={18} /></button>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          <div className="px-2 py-1.5 text-[10px] uppercase tracking-wider text-arc-faint">{tr('menu','Menu')}</div>
          {nav.map(n => (
            <button key={n.id} onClick={() => { setView(n.id); setOpen(false); }}
              className={`group w-full flex items-center gap-3 rounded-xl px-3 py-2.5 transition-all ${active === n.id ? 'bg-arc-primary/15 text-white ring-1 ring-arc-primary/40' : 'text-arc-muted hover:bg-arc-surface2 hover:text-arc-text'}`}>
              <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition ${active === n.id ? 'bg-arc-primary text-white shadow-glow' : 'bg-arc-surface2 text-arc-muted group-hover:text-arc-text'}`}>
                <Icon name={n.icon} size={17} />
              </span>
              <div className="text-left leading-tight">
                <div className="text-sm font-medium">{tr('nav.' + n.id, n.label)}</div>
                <div className="text-[10px] text-arc-faint">{tr('nav.' + n.id + '.desc', n.desc)}</div>
              </div>
              {active === n.id && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-arc-accent pulse-glow"></span>}
            </button>
          ))}
        </nav>

        <div className="p-3 border-t border-arc-border">
          <div className="flex items-center gap-2.5 rounded-xl bg-arc-bg/50 ring-1 ring-arc-border px-3 py-2.5">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400"></span>
            </span>
            <div className="leading-tight">
              <div className="text-xs font-medium text-arc-text">Arc Testnet</div>
              <div className="text-[10px] text-arc-faint">Gas ~0.001 USDC · Online</div>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

function Topbar({ usdc, onMenu, setView, onSearch, onLogout, role, onApply, txCount, notifs, onReadNotifs, onClearNotifs }) {
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState(false);
  const canSell = role === 'Seller' || role === 'Admin';
  const toBuyer = role === 'Member' ? Math.max(0, 3 - txCount) : 0;
  return (
    <header className="sticky top-0 z-20 h-16 bg-arc-bg/80 backdrop-blur-xl border-b border-arc-border flex items-center gap-3 px-4 sm:px-6">
      <button onClick={onMenu} className="lg:hidden w-10 h-10 rounded-xl bg-arc-surface ring-1 ring-arc-border flex items-center justify-center text-arc-text"><Icon name="menu" size={18} /></button>
      <div className="relative hidden sm:block">
        <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-arc-faint" />
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && onSearch(q)} placeholder={tr('search.placeholder','Search products, sellers, order ID…')}
className="w-72 bg-arc-surface/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl pl-9 pr-3 h-10 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
      </div>
      <div className="ml-auto flex items-center gap-2.5">
        <LangSwitcher />
        <button onClick={() => setView('balance')} className="flex items-center gap-2 bg-arc-surface/60 ring-1 ring-emerald-500/25 hover:ring-emerald-500/50 rounded-xl pl-2.5 pr-3 h-10 transition">
          <span className="w-6 h-6 rounded-lg bg-emerald-500/15 flex items-center justify-center"><Icon name="wallet" size={14} className="text-emerald-400" /></span>
          <Usdc value={usdc} className="text-sm font-semibold text-emerald-300" />
        </button>
        <NotifBell notifs={notifs} onReadAll={onReadNotifs} onClear={onClearNotifs} onGo={setView} />

        {/* profile dropdown */}
        <div className="relative">
          <button onClick={() => setMenu(m => !m)} className="flex items-center gap-1.5 rounded-xl hover:bg-arc-surface2 pl-1 pr-2 h-10 transition">
            <Avatar gradient={ME.avatar} img={ME.avatarImg} name={ME.name} size={36} ring />
            <Icon name="chevron-down" size={14} className={`text-arc-muted transition-transform ${menu ? 'rotate-180' : ''}`} />
          </button>
          {menu && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMenu(false)}></div>
              <div className="absolute right-0 mt-2 z-40 w-64 bg-arc-surface2 ring-1 ring-arc-borderlt rounded-2xl shadow-2xl overflow-hidden anim-modal">
                <div className="p-4 border-b border-arc-border">
                  <div className="flex items-center gap-3">
                    <Avatar gradient={ME.avatar} img={ME.avatarImg} name={ME.name} size={40} />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-arc-text truncate">{ME.name}</div>
                      <div className="text-[11px] text-arc-faint truncate">{ME.email}</div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between bg-arc-bg/60 ring-1 ring-arc-border rounded-xl px-3 py-2">
                    <span className="text-xs text-arc-muted inline-flex items-center gap-1.5"><Icon name={(DISC_ROLE_META[role]||{}).icon||'user'} size={13} className="text-arc-accent" /> {role}</span>
                    <Usdc value={usdc} className="text-sm font-semibold text-emerald-300" />
                  </div>
                  {role === 'Member' && (
                    <div className="mt-2 bg-arc-bg/60 ring-1 ring-arc-primary/25 rounded-xl px-3 py-2">
                      <div className="flex items-center justify-between text-[11px] mb-1.5">
                        <span className="text-arc-muted inline-flex items-center gap-1"><Icon name="trending-up" size={11} className="text-arc-accent" /> {tr('role.toBuyer','Progress to Buyer')}</span>
                        <span className="text-arc-accent font-medium">{Math.min(txCount,3)}/3 tx</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-arc-border overflow-hidden"><div className="h-full bg-arc-primary rounded-full transition-all" style={{ width: Math.min(100, (txCount/3)*100) + '%' }}></div></div>
                      <div className="text-[10px] text-arc-faint mt-1">{toBuyer > 0 ? toBuyer + ' ' + tr('role.txleft') : tr('role.ready')}</div>
                    </div>
                  )}
                </div>
                <div className="py-1.5">
                  {PROFILE_MENU.map(it => (
                    <button key={it.id} onClick={() => { setMenu(false); setView(it.id); }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-arc-text hover:bg-arc-surface hover:text-white transition">
                      <Icon name={it.icon} size={16} className="text-arc-muted" /> {tr('pm.' + it.id, it.label)}
                    </button>
                  ))}
                  {canSell
                    ? <button onClick={() => { setMenu(false); setView('seller'); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-emerald-300 hover:bg-emerald-500/10 transition"><Icon name="layout-dashboard" size={16} /> {tr('seller.center','Seller Center')}</button>
                    : <button onClick={() => { setMenu(false); onApply(); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-emerald-300 hover:bg-emerald-500/10 transition"><Icon name="store" size={16} /> {tr('apply.seller','Apply as Seller')}</button>}
                </div>
                <div className="border-t border-arc-border py-1.5">
                  <button onClick={() => { setMenu(false); onLogout(); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-rose-400 hover:bg-rose-500/10 transition">
                    <Icon name="log-out" size={16} /> {tr('logout','Logout')}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

// ---- Order / seller chat drawer ----
function ChatModal({ ctx, messages, onSend, onClose }) {
  const controlled = !!onSend;
  const [localMsgs, setLocalMsgs] = useState([]);
  const [draft, setDraft] = useState('');
  const ref = useRef(null);
  useEffect(() => { if (ctx && !controlled) setLocalMsgs(ctx.seed || []); }, [ctx]);
  const msgs = controlled ? (messages || []) : localMsgs;
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [msgs.length]);
  if (!ctx) return null;
  const send = () => { if (!draft.trim()) return; if (controlled) onSend(draft); else setLocalMsgs(m => [...m, { from: 'buyer', text: draft, time: 'now' }]); setDraft(''); };
  return (
    <Modal open={!!ctx} onClose={onClose} width="max-w-md">
      <Card className="overflow-hidden flex flex-col h-[560px]">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-arc-border">
          <Avatar gradient={isImgUrl(ctx.avatar) ? '' : ctx.avatar} img={isImgUrl(ctx.avatar) ? ctx.avatar : null} name={ctx.title} size={36} />
          <div>
            <div className="text-sm font-semibold text-arc-text">{ctx.title}</div>
            <div className="text-[11px] text-emerald-400 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> {ctx.sub || 'Online'}</div>
          </div>
          <button onClick={onClose} className="ml-auto w-8 h-8 rounded-lg hover:bg-arc-surface2 text-arc-muted flex items-center justify-center"><Icon name="x" size={16} /></button>
        </div>
        <div ref={ref} className="flex-1 overflow-y-auto p-4 space-y-3">
          {msgs.map((c, i) => <ChatBubble key={i} c={c} me="buyer" />)}
          {msgs.length === 0 && <div className="text-center text-arc-faint text-sm py-10">{tr('chat.startWith','Start a conversation with')} {ctx.title}</div>}
        </div>
        <div className="p-3 border-t border-arc-border flex items-center gap-2">
          <button className="w-10 h-10 rounded-xl bg-arc-surface2 hover:bg-arc-border text-arc-muted flex items-center justify-center transition shrink-0"><Icon name="paperclip" size={16} /></button>
          <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder={tr('chat.typeMsg','Type a message…')}
            className="flex-1 bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl px-3 h-10 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
          <Btn icon="send" className="shrink-0" onClick={send}>{tr('c.send','Send')}</Btn>
        </div>
      </Card>
    </Modal>
  );
}

/** WL deals + P2P escrow (rekber) are parked until after the mainnet push. */
function FeatureComingSoon({ onBack }) {
  return (
    <div className="anim-view flex flex-col items-center justify-center text-center py-24">
      <div className="w-16 h-16 rounded-2xl bg-arc-surface2/60 ring-1 ring-arc-border flex items-center justify-center mb-4"><Icon name="shield-check" size={28} className="text-arc-faint" /></div>
      <h1 className="text-xl font-bold text-white">{tr('cs.title','Coming soon')}</h1>
      <p className="text-sm text-arc-muted mt-1.5 max-w-sm">{tr('cs.body','WL & P2P Escrow is temporarily disabled while we finish the mainnet migration. Marketplace checkout, orders and escrow-protected purchases keep working.')}</p>
      <Btn variant="primary" className="mt-5" icon="home" onClick={onBack}>{tr('cs.back','Back to Home')}</Btn>
    </div>
  );
}

function SellerLocked({ onApply }) {
  return (
    <div className="anim-view flex flex-col items-center justify-center text-center py-24">
      <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 ring-1 ring-emerald-500/25 flex items-center justify-center mb-4"><Icon name="store" size={28} className="text-emerald-400" /></div>
      <h1 className="text-xl font-bold text-white">{tr('sel.lockedTitle','Seller Center locked')}</h1>
      <p className="text-sm text-arc-muted mt-1.5 max-w-sm">{tr('sel.lockedPre','This area is for')} <span className="text-arc-text font-medium">{tr('sel.lockedRoles','Sellers & Admins')}</span>. {tr('sel.lockedPost','Apply to become a seller — applications are reviewed manually by admins.')}</p>
      <Btn variant="emerald" className="mt-5" icon="store" onClick={onApply}>{tr('apply.seller','Apply as Seller')}</Btn>
    </div>
  );
}

function GuestTopbar({ onMenu, onSearch, onSignIn }) {
  const [q, setQ] = useState('');
  return (
    <header className="sticky top-0 z-20 h-16 bg-arc-bg/80 backdrop-blur-xl border-b border-arc-border flex items-center gap-3 px-4 sm:px-6">
      <button onClick={onMenu} className="lg:hidden w-10 h-10 rounded-xl bg-arc-surface ring-1 ring-arc-border flex items-center justify-center text-arc-text"><Icon name="menu" size={18} /></button>
      <div className="relative hidden sm:block">
        <Icon name="search" size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-arc-faint" />
        <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.key === 'Enter' && onSearch(q)} placeholder={tr('search.placeholder','Search products, sellers, order ID…')}
          className="w-72 bg-arc-surface/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl pl-9 pr-3 h-10 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
      </div>
      <div className="ml-auto flex items-center gap-2.5">
        <LangSwitcher />
        <button onClick={onSignIn} className="flex items-center gap-2 bg-arc-primary hover:bg-arc-primarydk text-white rounded-xl px-4 h-10 text-sm font-medium transition">
          <Icon name="log-in" size={16} /> {tr('auth.signIn','Sign In')}
        </button>
      </div>
    </header>
  );
}

function App() {
  useLang();
  const [authed, setAuthed] = useState(() => {
    try { return localStorage.getItem('slime_authed') === '1'; } catch (e) { return false; }
  });
  // Parse URL path → {view, storeName?, productId?} — PURE, no side effects
  const parsePath = (p) => window.SlimeRouter.parsePath(p || '/');
  const init = parsePath(window.__PATH__ || '/');
  const [view, setView] = useState(init.view);
  const [selStore, setSelStore] = useState(init.handle || null);
  // Restore entity from URL on mount (product / order / deal by id)
  if (typeof window !== 'undefined') {
    setTimeout(() => {
      if (init.view === 'product' && init.id) {
        const p = (window.PRODUCTS || []).find(x => x.id === init.id);
        if (p) { setSelProduct(p); }
        else fetch((window.SLIME_API || '') + '/api/products/' + init.id, { credentials: 'include' })
          .then(r => r.json()).then(data => { if (data && data.id) setSelProduct(data); }).catch(() => {});
      }
      // BUG FIX: `dealroom` was never restored from the URL. Only the popstate
      // handler (line ~512) set selDeal, and that fires on back/forward — not on a
      // fresh load. So opening /escrow/<id> directly, or just reloading the page
      // while inside a deal room, left selDeal null and the room stuck on
      // "Loading deal…" forever. The room resolves the deal from the wlDeals list
      // by id, so storing the id is all that is needed.
      if (init.view === 'dealroom' && init.id) setSelDeal(init.id);
    }, 0);
  }
  const [, setCatalogVer] = useState(0);
  const bumpCatalog = () => setCatalogVer(v => v + 1);

  // BLOCKING PIN-setup gate: when /api/auth/me (real sessions)
  // reports needsPinSetup, the whole authenticated app is blocked behind a
  // full-screen "Set up your 6-digit PIN" gate that runs Circle's hosted UI
  // (Create PIN → Verify ×2 → security questions). Legacy accounts that have
  // a wallet but never set a PIN (Rimuru) land here too — the backend now
  // offers a pin-only challenge for them. Old users with PIN ENABLED pass
  // straight through (no gate).
  const [pinGate, setPinGate] = useState(null); // { challengeId } | null
  const [pinGateBusy, setPinGateBusy] = useState(false);
  // LAZY wallet setup: a wallet-creation challenge reported by /api/auth/me but
  // NOT shown as a blocking gate at boot. It is kept here so wallet-dependent
  // actions (Send / checkout) can open the Circle hosted UI on demand instead
  // of forcing every new user through a popup right after sign-in.
  const [pendingWalletChallenge, setPendingWalletChallenge] = useState(null); // { challengeId, action } | null
  // .C — one-tap dismissal of the boot PIN gate. Skipped users browse +
  // pay via external wallet (no PIN needed). The gate re-arms on next reload,
  // and choosing Slime Wallet checkout prompts it again (422 PIN_SETUP_REQUIRED).
  //
  // DEFAULT TRUE since 2026-10-14. A second popup immediately after the Circle
  // registration iframe reads as a broken flow — users close it and report
  // "my PIN was never set". Circle in fact auto-provisions the PIN for email
  // accounts, so for the common case the gate is pure noise. The one case that
  // genuinely needs the hosted UI — an account whose PIN really is UNSET — is
  // still caught, at the moment it matters: sending money returns 422
  // PIN_SETUP_REQUIRED and the same gate opens from the action handler.
  const [pinGateSkipped, setPinGateSkipped] = useState(true);
  // action to auto-retry once the PIN gate completes (e.g. the
  // checkout that hit 422 PIN_SETUP_REQUIRED). One-shot, cleared after use.
  const pinRetryRef = useRef(null);
  // In-flight guard for buyer "confirm received" (prevents a double submit that
  // used to surface "order status DONE cannot release" after a stale-looking UI).
  const confirmingRef = useRef(null);

  // Auto-load catalog on mount (regardless of auth)
  useEffect(() => {
    if (window.loadCatalog) window.loadCatalog().then(ok => { if (ok) bumpCatalog(); });
    if (window.loadStores) window.loadStores().then(ok => { if (ok) bumpCatalog(); });
  }, []);

  // Cart cookie mirror on load: the SPA holds no persistent cart (instant-buy
  // model), so reset the slimemarket-cart cookie to the empty state on boot.
  // Any stale cookie from a previous session can't reflect real state anyway.
  useEffect(() => { syncCartCookie([]); }, []);

  // Bootstrap: restore session on page reload (httpOnly cookies invisible to JS),
  // and — critically — evaluate PIN provisioning right after a fresh sign-in.

  // BUG FIX (session never restored on a fresh browser profile):
  // this effect used to start with `if (!authed) return;`. But `authed` is
  // hydrated from localStorage, and `slime_authed` is ONLY ever written by the
  // sign-in handler. So the guard was circular: it restored the session only if
  // localStorage already proved you were signed in — which is exactly the state
  // we are trying to recover. The session cookie is httpOnly, so JS cannot see
  // it, and the app therefore showed the SIGN-IN screen to anyone holding a
  // perfectly valid session whose localStorage was empty: a new device or
  // browser, a cleared/incognito profile, or any user who reloaded after
  // "clear site data". Deep links into /admin, /orders, /wallet all bounced to
  // sign-in for the same reason.

  // The call itself is the test for "am I signed in?" — so it must always run.
  // 401/403 below is what logs you out; a successful restore now also flips
  // `authed` true so the other `if (!authed)` gates (notifications, orders)
  // open without needing a manual sign-in.
  useEffect(() => {
    fetch((window.SLIME_API || '') + '/api/auth/me', { credentials: 'include' })
      .then(r => {
        // Only explicit unauthorized (missing/expired session) should log out.
        // Transient failures (network, 500, 429) must NOT wipe the session —
        // that was causing logout-on-reload for valid sessions.
        if (r.status === 401 || r.status === 403) {
          const err = new Error('unauthorized');
          err.status = r.status;
          throw err;
        }
        if (!r.ok) {
          const err = new Error('HTTP ' + r.status);
          err.status = r.status;
          throw err;
        }
        return r.json();
      })
      .then(data => {
        ME.name = data.name; ME.email = data.email; ME.uid = data.uid;
        // BUG FIX: the deal room decides which seat you hold by comparing
        // `ME.uid` (4 chars) against `deal.buyerId` / `deal.sellerId`, but the API
        // returns those as UUIDs (users.id). The comparison could never be true,
        // so "Seller Actions" (Mark as Delivered) and the buyer's Confirm button
        // never rendered for anyone. Keep the UUID too and match on that.
        ME.id = data.id || '';
        ME.handle = data.handle; ME.role = data.role; setRoleState(data.role);
        ME.txCount = data.txCount; setTxCount(data.txCount);
        ME.preferred_lang = data.preferredLang || 'en';
        if (data.avatarUrl) ME.avatarImg = data.avatarUrl;
        if (data.avatarGradient) ME.avatar = data.avatarGradient;
        if (data.joinedAt) ME.joined = data.joinedAt;
        if (data.walletAddress) ME.wallet = data.walletAddress;
        // A successful restore means the cookie session is valid — reflect that
        // in `authed` so the other `if (!authed)` gates open on a fresh profile
        // without forcing a redundant manual sign-in.
        try { localStorage.setItem('slime_authed', '1'); } catch (e) {}
        setAuthed(true);
        refreshWallet(); refreshOrders();
        if (data.role === 'Seller' || data.role === 'Admin') { refreshAllSellerData(); }
        refreshChats();
        refreshWlListings();
        refreshWlDeals();
        refreshBanks();

        // Surface any wallet-setup error captured during login (auth.jsx sets
        // window.__SLIME_WALLET_ERR) so it is visible without DevTools.
        if (window.__SLIME_WALLET_ERR) {
          notify('Wallet setup error: ' + window.__SLIME_WALLET_ERR, 'error');
          window.__SLIME_WALLET_ERR = null;
        }

        // WALLET SETUP: /api/auth/me reliably reports the Circle wallet
        // challenge (unlike the login response, which can omit it when the
        // Circle status probe fails). Open the blocking gate so the hosted UI
        // actually runs — without it a new user ends up wallet-less forever.
        // Once the wallet exists the gate never appears again.
        if (data.needsPinSetup && data.pinSetupChallengeId && typeof window.executeUcwChallenge === 'function') {
          setPendingWalletChallenge({ challengeId: data.pinSetupChallengeId, action: data.pinSetupAction || 'full-challenge' });
          setPinGate({ challengeId: data.pinSetupChallengeId, action: data.pinSetupAction || 'full-challenge' });
        } else if (data.needsPinSetup) {
          notify(tr('pin.bootIncomplete', 'Wallet setup incomplete — retry from Profile'), 'warn');
        }

        // If we have no wallet address yet, poll a few times — Circle indexes a
        // freshly-created wallet asynchronously, so it can be missing from the
        // very first /api/wallet read right after the hosted-UI challenge. This
        // makes the address appear without the user having to reload.
        if (!ME.wallet) {
          let tries = 0;
          const t = setInterval(async () => {
            tries += 1;
            try { await refreshWallet(); } catch (e) { /* ignore */ }
            if (ME.wallet || tries >= 6) clearInterval(t);
          }, 2500);
        }
      })
      .catch((err) => {
        if (err && (err.status === 401 || err.status === 403)) {
          // Genuinely not authenticated → log out. `authed` flips to false, the
          // effect re-runs once and the guard above stops it (no loop).
          try { localStorage.removeItem('slime_authed'); } catch (e) {}
          setAuthed(false);
        } else {
          // Transient error (network/500/429) — keep the session, warn only.
          console.warn('[auth] bootstrap transient error (session kept):', err && err.message);
        }
      });
    // Deps stay `[authed]` so a fresh sign-in (false→true) re-runs this and the
    // PIN gate is evaluated. Running again is harmless: the restore is
    // idempotent and setAuthed(true) on an already-true value does not re-render.
  }, [authed]);

  // run the BLOCKING PIN-setup hosted-UI challenge. On success we
  // tell the server to flip wallet_provisioned, then clear the gate. On any
  // error the gate STAYS open (the user must complete PIN setup before the
  // app is usable) and we show the message.
  const runPinSetupGate = async () => {
    if (!pinGate || !pinGate.challengeId) return;
    // Capture BEFORE the gate is cleared. 'wallet-only-challenge' creates the
    // wallet and sets no PIN — reporting it as "your PIN is set" is false.
    const walletOnly = pinGate.action === 'wallet-only-challenge';
    setPinGateBusy(true);
    try {
      const result = await window.executeUcwChallenge(pinGate.challengeId, { isPinSetup: true });

      // FIX `executeUcwChallenge` RESOLVES WITH `null` — it does not
      // throw — when `/api/my/ucw-credentials` has no valid session (see
      // ucw-helper.jsx). Previously that null was ignored, the gate closed and
      // the UI claimed "Wallet secured!" while no PIN was set and no wallet
      // existed; `wallet_provisioned` stayed false and the gate silently
      // re-armed on every reload. Treat a null result as a hard failure.
      if (!result) {
        notify(
          tr('pin.gateRequired', 'PIN setup is required — please complete it.') +
            ' (wallet session expired — reload the page and try again)',
          'error',
        );
        return;
      }

      // Only close the gate once the SERVER confirms a wallet row exists.
      let provisioned = false;
      try {
        const r = await fetch((window.SLIME_API || '') + '/api/wallet/ucw-provisioning-complete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        provisioned = r.ok;
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          // 409 = Circle hasn't surfaced the wallet yet (async). Keep the gate.
          console.warn('[pin] provisioning-complete failed:', r.status, d && d.error);
        }
      } catch (e2) { console.warn('provisioning-complete call failed (retries next load):', e2.message); }

      if (!provisioned) {
        notify(tr('pin.bootIncomplete', 'Wallet setup incomplete — retry from Profile'), 'warn');
        return; // gate stays open; user is NOT told it succeeded
      }

      setPinGate(null);
      setPinGateSkipped(false);
      notify(
        walletOnly
          ? tr('pin.bootWalletDone', 'Wallet ready! Your Slime Wallet is set up.')
          : tr('pin.bootDone', 'Wallet secured! Your PIN is set.'),
        'success',
      );
      refreshWallet();
      // Circle indexes the new wallet asynchronously — poll briefly so the
      // address shows up without a manual reload.
      (function pollForWallet(n) {
        if (ME.wallet || n <= 0) return;
        setTimeout(async () => {
          try { await refreshWallet(); } catch (e) { /* ignore */ }
          pollForWallet(n - 1);
        }, 2500);
      })(6);
      // auto-retry the action that was blocked by the missing PIN
      // (e.g. the checkout that returned 422). One-shot.
      const retry = pinRetryRef.current;
      pinRetryRef.current = null;
      if (typeof retry === 'function') setTimeout(() => retry(), 400);
    } catch (e) {
      const detail = window.__SLIME_WALLET_ERR || (e && e.message ? e.message : '');
      notify('Wallet setup failed: ' + detail, 'error');
    } finally {
      setPinGateBusy(false);
    }
  };

  // .C — dismiss the boot PIN gate for this session (one tap, no popup).
  // Browsing and external-wallet checkout are unaffected; the gate re-arms on
  // reload, and a Slime Wallet checkout that 422s re-shows it via pinRetryRef.
  const skipPinGate = () => {
    setPinGate(null);
    setPinGateSkipped(true);
    notify(tr('pin.skipToast', 'Skipped for now — set up your PIN anytime from Profile, or pay with your own wallet.'), 'info');
  };

  // ---- helpers ----
  const openProductById = (id) => {
    setView('product');
    const p = (window.PRODUCTS || []).find(x => x.id === id);
    if (p) { setSelProduct(p); return; }
    fetch((window.SLIME_API||'') + '/api/products/' + id, {credentials:'include'})
      .then(r => r.json()).then(data => { if (data && data.id) { setSelProduct(data); bumpCatalog(); } }).catch(()=>{});
  };

  // ---- Clean URL routing via SlimeRouter ----
  const syncURL = (v, extra) => { window.SlimeRouter.pushPath(v, extra || {}); };
  useEffect(() => {
    const onPop = () => { const r = parsePath(window.location.pathname); setView(r.view); if (r.handle) setSelStore(r.handle); if (r.view === 'product' && r.id) { const p = (window.PRODUCTS||[]).find(x=>x.id===r.id); if (p) setSelProduct(p); } if (r.view === 'dealroom' && r.id) setSelDeal(r.id); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Phase 4.2 — fetch /api/health on boot to sync the non-custodial checkout
  // flag from the server. This lets staging/prod toggle ONCHAIN_WALLET_FUNDS
  // without rebuilding the FE.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch((window.SLIME_API || '') + '/api/health');
        // NOTE: do NOT gate on `r.ok`. /api/health returns 503 when the service
        // is DEGRADED (e.g. the escrow indexer is lagging), but the body is still
        // valid JSON and still carries `onChainFunds`. Gating on r.ok meant that
        // any degradation left window.ONCHAIN_FUNDS false, so the UI offered the
        // custodial rail while the server was in on-chain mode — every checkout
        // then failed with CUSTODIAL_RAIL_DISABLED and the buyer could not pay.
        const h = await r.json().catch(() => null);
        if (h) {
          if (h.onChainFunds) window.ONCHAIN_FUNDS = true;
          // .D3 — contract addresses for EOA WalletBridge calldata.
          if (h.escrowAddress) window.SLIME_ESCROW_ADDRESS = h.escrowAddress;
          if (h.usdcAddress) window.SLIME_USDC_ADDRESS = h.usdcAddress;
          // Explorer BASE for the ACTIVE network. Every tx link in the UI is
          // built from this, so mainnet never links to the testnet explorer.
          if (h.explorerUrl) window.ARC_EXPLORER_URL = h.explorerUrl;
        }
      } catch (e) { /* non-fatal — flag stays false (legacy path) */ }
    })();
  }, []);

  const [history, setHistory] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [role, setRoleState] = useState(ME.role);
  const [txCount, setTxCount] = useState(ME.txCount);
  const [notifs, setNotifs] = useState(NOTIFS);

  // balances
  const [usdc, setUsdc] = useState(ME.usdc);
  const [forumBalance, setForumBalance] = useState(ME.forumBalance);
  const [earnings, setEarnings] = useState(0);
  // 'onchain' | 'custodial' | null (null = API hasn't told us yet → views fall
  // back to the ONCHAIN_FUNDS flag). See SellerCenter `mode` derivation.
  const [banks, setBanks] = useState(SALDO.banks);
  const [fiatTxs, setFiatTxs] = useState(FIAT_TX);

  // ---- API helper + wallet refresh (M1 backend wiring) ----
  const API = window.SLIME_API || '';
  async function api(path, opts = {}) {
    const res = await fetch(API + path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      try { localStorage.removeItem('slime_authed'); } catch (e) {}
      setAuthed(false);
      throw new Error('Session expired. Please login again.');
    }
    if (!res.ok) {
      // attach status/code so callers can act on structured
      // errors (e.g. 422 PIN_SETUP_REQUIRED → open the PIN gate).
      const err = new Error(data.error || ('HTTP ' + res.status));
      err.status = res.status;
      err.code = data.code || null;
      throw err;
    }
    return data;
  }
  // Staff-gated routes (deal release / refund / slash) require the X-Admin-Token
  // that the Admin Console mints after a PIN unlock. Two problems used to hide
  // here: (1) the token lived only in admin.jsx's own ref, so these buttons always
  // got 401; (2) nothing in the deal room could mint one — the console only asks
  // for a PIN on demand, so there was no path to unlock from here at all.
  // Now: send the token if present, otherwise prompt for the PIN and mint one.
  const staffApi = async (path, opts = {}) => {
    let token = (typeof window !== 'undefined' && window.__ADMIN_TOKEN) || null;
    if (!token) {
      const pin = window.prompt('Admin PIN required for this action:');
      if (!pin) throw new Error('Admin unlock cancelled.');
      const res = await fetch((window.SLIME_API || '') + '/api/admin/verify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, challengeId: 'dev-bypass' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Admin PIN verification failed');
      token = data.adminToken;
      try { window.__ADMIN_TOKEN = token; } catch (e) {}
    }
    return api(path, { ...opts, headers: { ...(opts.headers || {}), 'X-Admin-Token': token } });
  };
  const refreshWallet = async () => {
    try {
      const w = await api('/api/wallet');
      // FIX: the wallet address lives on the global ME object and was only ever
      // set during the boot /api/auth/me restore. After a wallet is created
      // mid-session (Circle hosted-UI challenge), ME.wallet stayed empty and the
      // Wallet page showed "Not available" until a full page reload. Pick the
      // address up here so it appears immediately.
      if (w && w.address) ME.wallet = w.address;
      // NOTE: divide as NUMBER, never `BigInt(x) / 1000000n`. BigInt division is
      // integer division, so it silently truncates the cents: 17999328 micro is
      // 17.999328 USDC but 17999328n / 1000000n is 17n — every balance looked
      // ~1 USDC low (and a sub-dollar balance rendered as 0.00). Micro values are
      // well inside Number.MAX_SAFE_INTEGER, so plain division is exact here.
      const dbBal = Number(w.usdcBalance) / 1e6;
      const chainBal = w.onChainBalance ? Number(w.onChainBalance) / 1e6 : 0;
      setUsdc(Math.max(dbBal, chainBal));
      // keep the ON-CHAIN balance separately. In non-custodial mode the
      // server's checkout gate reads the on-chain balance, so the UI must gate on
      // the same number; using the max() above would let a stale DB mirror make
      // the button look affordable and then fail server-side.
      ME.usdcOnChain = chainBal;
      const dbMapped = (w.recentTx || []).map(t => ({
        id: t.id, type: t.type, label: t.label, sub: t.sub || '',
        // Same trap as the balance above: BigInt division would floor this.
        amount: Number(t.amount) / 1e6,
        time: new Date(t.createdAt).toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }),
        status: t.status,
        txHash: t.onChainTxHash || t.txHash || null,
        _ts: new Date(t.createdAt).getTime(),
      }));
      setFiatTxs(dbMapped);

      // ── Enrich with chain-backed history (native USDC transfers from RPC) ──
      try {
        const ch = await api('/api/wallet/chain-history?sync=1');
        const chainItems = (ch?.history || [])
          .filter(h => h.source === 'chain')
          .map(h => ({
            id: `chain-${h.txHash}`,
            type: h.direction,
            label: h.label,
            sub: h.direction === 'in'
              ? `From ${h.from?.slice(0,6)}…${h.from?.slice(-4)}`
              : `To ${h.to?.slice(0,6)}…${h.to?.slice(-4)}`,
            amount: Number(h.amount) / 1e6,
            time: new Date(h.createdAt).toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }),
            status: h.status,
            txHash: h.txHash,
            _ts: new Date(h.createdAt).getTime(),
          }));
        // Merge: DB wins on txHash conflict (it has richer labels/status)
        const mergedMap = new Map();
        for (const t of chainItems) {
          if (t.txHash) mergedMap.set(t.txHash.toLowerCase(), t);
          else mergedMap.set(t.id, t);
        }
        for (const t of dbMapped) {
          if (t.txHash) mergedMap.set(t.txHash.toLowerCase(), t);
          else mergedMap.set(t.id, t);
        }
        const merged = Array.from(mergedMap.values())
          .sort((a, b) => b._ts - a._ts)
          .map(({ _ts, ...rest }) => rest);
        setFiatTxs(merged);
      } catch (enrichErr) {
        console.warn('[refreshWallet] chain-history enrich failed:', enrichErr.message);
      }
    } catch (e) { console.warn('[refreshWallet] failed:', e.message); }
  };
  const refreshOrders = async () => {
    try {
      const r = await api('/api/orders');
      if (r && Array.isArray(r.items)) setBuyerOrders(r.items);
    } catch (e) { console.warn('[refreshOrders] failed:', e.message); }
    finally { setOrdersLoading(false); }
  };
  // Re-read ONE order and fold it into both the list and the open detail view.
  // Order status changes happen server-side (seller marks SENT, the escrow
  // indexer sees the release, an auto-cancel fires) — the page used to keep the
  // stale snapshot it was opened with until the user reloaded the tab.
  const refreshOrder = async (id) => {
    if (!id) return null;
    try {
      const o = await api('/api/orders/' + id);
      if (!o || !o.id) return null;
      setSelOrder(cur => (cur && cur.id === id) ? { ...cur, ...o } : cur);
      setBuyerOrders(list => list.map(x => x.id === id ? { ...x, ...o } : x));
      return o;
    } catch (e) {
      console.warn('[refreshOrder] failed:', e.message);
      return null;
    }
  };
  const refreshSellerOrders = async () => {
    try {
      const r = await api('/api/my/orders');
      if (r && Array.isArray(r.items)) setSellerOrders(r.items);
    } catch (e) { console.warn('[refreshSellerOrders] failed:', e.message); }
  };
  const refreshEarnings = async () => {
    try {
      const r = await api('/api/my/earnings');
      const mode = (r && r.mode) || (window.ONCHAIN_FUNDS ? 'onchain' : 'custodial');
      // in on-chain mode the seller's money is already in their own
      // wallet, so the card must show the ON-CHAIN balance. `totalEarnings` is
      // the legacy DB ledger sum, which froze the moment the flag flipped and is
      // only useful as a historical reference.
      if (mode === 'onchain' && r && typeof r.walletBalance === 'number') {
        setEarnings(r.walletBalance);
      } else if (r && typeof r.totalEarnings === 'number') {
        setEarnings(r.totalEarnings);
      }
    } catch (e) {
      // Fallback: compute from seller orders with completed statuses
      try {
        const total = sellerOrders
          .filter(o => ['DONE', 'SENT', 'RELEASED', 'COMPLETED'].includes(o.status))
          .reduce((sum, o) => sum + (Number(o.amount) || 0), 0);
        if (total > 0) setEarnings(total);
      } catch (_) { /* keep 0 */ }
    }
  };
  const refreshMyProducts = async () => {
    try {
      const r = await api('/api/my/products');
      if (r && Array.isArray(r.items)) setMyProducts(r.items);
    } catch (e) { console.warn('[refreshMyProducts] failed:', e.message); }
  };
  // Expose globally so child views (e.g. Seller Center restock) can force a
  // fresh re-fetch of authoritative product data after mutations — fixes the
  // stale "Stock: 0" display that persisted after a successful restock.
  window.refreshMyProducts = refreshMyProducts;
  // .C1 — userdash.jsx (and the balance flows) call window.refreshWallet()
  // after money operations; expose it so those calls are no longer dead.
  window.refreshWallet = refreshWallet;
  const refreshChats = async () => {
    try {
      const r = await api('/api/chats');
      if (r && Array.isArray(r.items)) setDmThreads(r.items);
      else if (Array.isArray(r)) setDmThreads(r);
      // else keep existing (don't set to undefined/null)
    } catch (e) { console.warn('[refreshChats] failed:', e.message); }
  };
  const refreshWlListings = async () => {
    try {
      const r = await api('/api/wl/listings');
      if (r && Array.isArray(r.items)) setWlListings(r.items);
    } catch (e) { console.warn('[refreshWlListings] failed:', e.message); }
  };
  const refreshWlDeals = async () => {
    try {
      const r = await api('/api/wl/deals');
      if (r && Array.isArray(r.items)) setWlDeals(r.items);
    } catch (e) { console.warn('[refreshWlDeals] failed:', e.message); }
  };
  const refreshMyStore = async () => {
    // .C1 — no more My Store editor; the store is derived from the
    // profile. Kept as a no-op so any lingering callers don't break.
  };
  const refreshAllSellerData = async () => {
    await Promise.allSettled([
      refreshEarnings(),
      refreshSellerOrders(),
      refreshMyProducts(),
      refreshMyStore(),
    ]);
  };

  // collections
  const [buyerOrders, setBuyerOrders] = useState(BUYER_ORDERS);
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [rekberTxs, setRekberTxs] = useState(REKBER_TX);
  const [sellerOrders, setSellerOrders] = useState(SELLER_ORDERS);
  const [selSellerOrder, setSelSellerOrder] = useState(null);
  const [orderChats, setOrderChats] = useState({});
  const [dmThreads, setDmThreads] = useState(CHAT_THREADS);

  // seller dashboard
  const [myProducts, setMyProducts] = useState(MY_PRODUCTS);
  const [storeReviews, setStoreReviews] = useState({});

  // contextual selections
  const [selProduct, setSelProduct] = useState(null);
  const [selOrder, setSelOrder] = useState(null);
  const [storeQuery, setStoreQuery] = useState('');
  // Category the storefront should open on. Held here (not only inside
  // Storefront) so the landing-page category cards can drive it: previously
  // `goStorefront` dropped its `cat` argument entirely, so clicking a category
  // on the landing page just navigated and filtered nothing.
  const [storeCat, setStoreCat] = useState('All');

  // modals
  const [checkout, setCheckout] = useState(null);
  // id of the order whose "Confirm Received" request is in flight — drives the
  // spinner on the button so a slow on-chain release never looks like a no-op.
  const [confirmingId, setConfirmingId] = useState(null);
  // post-checkout hand-off: { order } → "View order / Continue shopping" modal.
  const [checkoutDone, setCheckoutDone] = useState(null);
  const [appealOrder, setAppealOrder] = useState(null);
  const [rekberTarget, setRekberTarget] = useState(null);
  const [chatCtx, setChatCtx] = useState(null);
  const [selChatThread, setSelChatThread] = useState(null);
  const [profileName, setProfileName] = useState(null);
  const [cancelOrder, setCancelOrder] = useState(null);
  const [declineOrder, setDeclineOrder] = useState(null);
  const [reviewOrder, setReviewOrder] = useState(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [walletAction, setWalletAction] = useState(null);
  const [profileAvatar, setProfileAvatar] = useState(ME.avatarImg);
  const [wlListings, setWlListings] = useState(WL_LISTINGS);
  const [wlDeals, setWlDeals] = useState([]);
  const [selDeal, setSelDeal] = useState(null);
  const [toast, setToast] = useState(null);

  const notify = (text, type = 'info') => { setToast({ text, type }); setTimeout(() => setToast(null), 2600); };
  ME.usdc = usdc;
  const canSell = role === 'Seller' || role === 'Admin';

  // ---- notifications (persisted server-side; loaded from /api/notifications) ----
  const pushNotif = (n) => setNotifs(list => [{ id: 'n' + Date.now() + Math.random().toString(16).slice(2, 5), time: 'now', read: false, ...n }, ...list]);
  const refreshNotifs = async (keepIfEmpty) => {
    try {
      const r = await api('/api/notifications');
      if (r && Array.isArray(r.items)) { if (r.items.length === 0 && keepIfEmpty) return; setNotifs(r.items); }
    } catch (e) { console.warn('[refreshNotifs] failed:', e.message); }
  };
  const readAllNotifs = () => { setNotifs(list => list.map(n => ({ ...n, read: true }))); api('/api/notifications', { method: 'PATCH' }).catch(() => {}); };
  const clearNotifs = () => { setNotifs([]); api('/api/notifications', { method: 'DELETE' }).catch(() => {}); };
  // Load persisted notifications on auth + poll periodically so server-created ones appear.
  useEffect(() => {
    if (!authed) return;
    refreshNotifs(true);
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refreshNotifs(true);
    }, 45000);
    return () => clearInterval(id);
  }, [authed]);

  // ---- auth / onboarding ----
  const handleAuthed = ({ kind, name, email, wallet, user }) => {
    if (user) {
      ME.name = user.name || name;
      ME.email = user.email || email;
      ME.uid = user.uid || '';
      // Same reason as the boot restore below: the deal room matches seats on the
      // UUID, not the 4-char uid.
      ME.id = user.id || '';
      ME.handle = '@' + (user.handle || (user.name || 'user').toLowerCase().replace(/[^a-z0-9]/g,''));
      ME.role = user.role; setRoleState(user.role);
      ME.txCount = user.txCount || 0; setTxCount(user.txCount || 0);
      ME.preferred_lang = user.preferred_lang || 'en';
      ME.joined = user.joined || '';
      if (wallet) ME.wallet = wallet;
      // NOTE: do NOT zero `usdc` for Members here. In non-custodial mode
      // (ONCHAIN_WALLET_FUNDS=1) the balance lives on-chain and a plain Member
      // holds real USDC — zeroing the state made the wallet page show 0.00 for
      // everyone who is not a Seller/Admin. refreshWallet() below replaces this
      // with max(dbLedger, onChainBalance) as soon as it resolves.
      if (kind === 'signup') {
        setNotifs([{ id: 'welcome', icon: 'sparkles', tone: 'violet', title: 'Welcome to SlimeMarket!', text: 'MPC Wallet active. Top up to start.', time: 'now', read: false, go: 'balance' }]);
      }
    } else if (kind === 'signup') {
      ME.role = 'Member'; setRoleState('Member');
      ME.txCount = 0; setTxCount(0);
      setUsdc(0);
      if (name) ME.name = name;
      if (email) ME.email = email;
      if (wallet) ME.wallet = wallet;
    }
    try { localStorage.setItem('slime_authed', '1'); } catch (e) {}
    setAuthed(true);
    refreshWallet();
    refreshOrders();
    // BUG FIX: was reading stale `role` state (closure from previous render,
    // still 'Member'), so seller data never loaded right after login. Use the
    // fresh role from the login response instead.
    const freshRole = (user && user.role) || ME.role;
    if (freshRole === 'Seller' || freshRole === 'Admin') refreshAllSellerData();
    refreshChats();
    refreshWlListings();
    refreshWlDeals();
    // Load live catalog (products + stores) from backend; views read globals.
    if (window.loadCatalog) { window.loadCatalog().then(ok => { if (ok) bumpCatalog(); }); }
    if (window.loadStores)  { window.loadStores().then(ok => { if (ok) bumpCatalog(); }); }
  };

  // ---- role progression ----
  // Roles + tx_count are authoritative on the server (confirm_order_atomic
  // promotes Member→Buyer at 3 completed transactions). Never promote locally —
  // re-fetch the profile so the UI reflects the server's decision.
  const refreshMe = async () => {
    try {
      const r = await api('/api/auth/me');
      if (!r) return;
      const prevRole = role;
      if (r.role) { ME.role = r.role; setRoleState(r.role); }
      if (typeof r.txCount === 'number') { ME.txCount = r.txCount; setTxCount(r.txCount); }
      if (r.role === 'Buyer' && prevRole === 'Member') {
        setTimeout(() => { notify('🎉 Congrats! You leveled up to Buyer — full forum access unlocked.', 'success'); pushNotif({ icon: 'badge-check', tone: 'emerald', title: 'Leveled up: Buyer!', text: '3 transactions completed · all forum channels unlocked.', go: 'discussion' }); }, 400);
      }
    } catch (e) { console.warn('[refreshMe] failed:', e.message); }
  };
  const setRole = () => {}; // no-op — real roles come from API

  const activeNav = ({ product: 'storefront', store: 'storefront', orderdetail: 'orders', dealroom: 'escrow', sellerorder: 'seller' })[view] || view;

  // ---- navigation ----
  const navTo = (v) => { setView(v); syncURL(v); window.scrollTo && window.scrollTo(0, 0); };
  const pushTo = (v, extra) => { setHistory(h => [...h, view]); setView(v); syncURL(v, extra); window.scrollTo && window.scrollTo(0, 0); };
  const back = () => { setHistory(h => { const n = [...h]; const prev = n.pop(); window.history.back(); return n; }); window.scrollTo && window.scrollTo(0, 0); };
  const openProduct = (p) => { setSelProduct(p); pushTo('product', { id: p.id, name: p.title || p.name }); };
  const openStore = (name) => {
    setSelStore(name);
    pushTo('store', { handle: name });
  };
  // C4 — fetch the REAL store profile + verified reviews whenever a store is
  // selected. Lives in an effect (not openStore) so DIRECT URL loads like
  // /store/TestStore also trigger it — previously only in-app navigation
  // called openStore, so direct visits showed fabricated defaults + 0 reviews.
  useEffect(() => {
    const name = selStore;
    if (!name) return;
    if (storeReviews[name] === undefined) {
      api('/api/stores/' + encodeURIComponent(name) + '/reviews')
        .then(r => {
          if (r && Array.isArray(r.items)) {
            setStoreReviews(prev => ({ ...prev, [name]: r.items }));
          }
        })
        .catch(e => console.warn('[store reviews] fetch failed:', e.message));
    }
    // GET /api/stores/:uid resolves uid/name/handle and returns
    // {name, handle, uid, avatar, banner, rating, ratingCount, online, joined,
    // message}. Merge into window.STORES (loadStores only fabricates defaults
    // from products); on failure the fabricated defaults stay in place.
    api('/api/stores/' + encodeURIComponent(name))
      .then(profile => {
        if (!profile || !profile.name) return;
        const st = window.STORES || {};
        const existing = st[name] || { name, online: true };
        window.STORES = {
          ...st,
          [name]: {
            ...existing,
            message: profile.message || existing.message || '',
            banner: profile.banner || existing.banner,
            avatar: profile.avatar || existing.avatar,
            rating: profile.rating ?? existing.rating,
            ratingCount: profile.ratingCount ?? existing.ratingCount ?? 0,
            handle: profile.handle || existing.handle,
            uid: profile.uid || existing.uid,
            joined: profile.joined || existing.joined,
          },
        };
        bumpCatalog();
      })
      .catch(() => { /* 404 / network — keep fabricated defaults */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selStore]);

  // My Orders — re-fetch every time the view opens. The list used to keep
  // whatever it held when the app booted, so an order created seconds earlier
  // (checkout → order detail → sidebar "My Orders") was missing until a reload.
  useEffect(() => {
    if (view === 'orders') refreshOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // My Orders — keep it fresh while it is open (seller accepts, ships, releases).
  useEffect(() => {
    if (view !== 'orders') return;
    const id = setInterval(() => refreshOrders(), 10000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Order Detail — poll the OPEN order. Status transitions (PROCESS → SENT,
  // SENT → DONE, auto-cancel) and the auto-release deadline are all written
  // server-side; without this the page showed a frozen snapshot of whatever it
  // was opened with, and the credential reveal / release countdown only
  // appeared after a manual reload.
  useEffect(() => {
    if (view !== 'orderdetail') return;
    const id = selOrder && selOrder.id;
    if (!id) return;
    refreshOrder(id);
    const s = selOrder && selOrder.status;
    const oc = selOrder && selOrder.onChainStatus;
    // Keep polling while the escrow settlement is still in flight: a DONE order
    // whose release is 'release_pending' / 'release_failed' (auto-retrying) is
    // not finished yet — the indexer will flip it to RELEASED a few blocks later.
    const chainPending = typeof oc === 'string' && /pending|failed/i.test(oc);
    const terminal = ['CANCELLED', 'DECLINED'].includes(s) || (s === 'DONE' && !chainPending);
    if (terminal) return;
    const t = setInterval(() => refreshOrder(id), 6000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selOrder && selOrder.id, selOrder && selOrder.status, selOrder && selOrder.onChainStatus]);

  const openOrder = (o) => { setSelOrder(o); pushTo('orderdetail', { id: o.id }); };
  const openOrderById = (id) => { const o = buyerOrders.find(x => x.id === id); if (o) openOrder(o); else notify('Order not found', 'error'); };
  const openProfile = (name) => setProfileName(name);
  const logout = () => {
    try {
      localStorage.removeItem('slime_authed');
      ME.name = ''; ME.email = ''; ME.role = 'Buyer'; ME.wallet = '';
      // Phase 6.4 — UCW credentials live in httpOnly cookies only (no
      // localStorage mirror). Logout endpoint clears them server-side.
    } catch (e) {}
    // Reset all loaded state so a stale previous session can't leak into the next one.
    setBuyerOrders([]); setSellerOrders([]); setMyProducts([]); setWlDeals([]);
    setDmThreads([]); setNotifs([]); setUsdc(0); setFiatTxs([]);
    // Best-effort: tell the server to clear its httpOnly cookies too.
    try { fetch((window.SLIME_API || '') + '/api/auth/logout', { method: 'POST' }); } catch (e) {}
    setAuthed(false);
    window.SlimeRouter.pushPath('auth', {});
    setView('auth');
  };
  const goStorefront = (cat, q) => {
    setStoreCat(cat || 'All');
    setStoreQuery(q || '');
    navTo('storefront');
  };

  // ---- buy / checkout ----
  // Phase 4.2 — non-custodial checkout (Opsi B: pre-approve + relayer pull).
  // Flow when ONCHAIN_WALLET_FUNDS=1 (window.ONCHAIN_FUNDS):
  //   1. POST /api/orders/checkout/prepare  → draft + approve call data
  //   2. POST /api/orders/checkout/challenge → Circle UCW CONTRACT_EXECUTION
  //      challengeId for `USDC.approve(escrow, itemAmount)`
  //   3. W3SSdk.execute(challengeId)         → user enters PIN → approve tx
  //   4. POST /api/orders/checkout/confirm   → relay createOrderFor via DCW
  // When the flag is OFF, falls back to legacy custodial POST /api/orders.

  // .D — split a 65-byte EIP-2612 signature (0x + 130 hex) into v/r/s.
  // Mirror of lib/order/permit-checkout.ts splitPermitSignature.
  const splitPermitSig = (sig) => {
    if (typeof sig !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(sig)) {
      throw new Error('invalid permit signature from wallet');
    }
    return { r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130), v: parseInt(sig.slice(130, 132), 16) };
  };

  // .D3 — ABI-calldata helper: left-pad an address/uint to a 32-byte word.
  const padWord = (v) => String(v).replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const SLIME_USDC = () => window.SLIME_USDC_ADDRESS || '0x3600000000000000000000000000000000000000';
  // this fallback used to be a HARDCODED address
  // (`0xda76142cd1d31e4d8516ba58c5b8bec0f72eb912`) that is NOT the deployed
  // escrow (`0xfe76c63289dd8b5693277df261e4938bd8779d28`). `window.SLIME_ESCROW_ADDRESS`
  // is populated from `/api/health`; if that had not landed yet (or the field
  // was absent), the WL external-wallet `approve()` targeted the WRONG spender —
  // the tx succeeded, but MarketEscrow could never pull the funds, so the deal
  // stalled with no visible error. Never guess a spender address: fail loudly.
  const SLIME_ESCROW = () => {
    const addr = window.SLIME_ESCROW_ADDRESS;
    if (!addr) throw new Error('escrow address not loaded yet — wait a moment and retry');
    return addr;
  };

  // .D — external-wallet payment: PRIMARY gasless permit, FALLBACK approve.
  // Returns the confirm response ({ orderId, onChainOrderId, ... }).
  const payExternalPermitOrApprove = async (prepared, payerAddress, total) => {
    // Circle-only model restored (Privy removed): the external signer
    // is the connected RainbowKit wallet. The extConnected guard is KEPT: it
    // fixes the old "signTypedData while disconnected → approve-fallback also
    // fails" double-error (approve tx is also WalletBridge-only).
    const extConnected = !!(window.WalletBridge?.isConnected?.());
    if (!extConnected) {
      throw new Error('no wallet available — connect an external wallet first');
    }
    // ── Stage 1: obtain the permit signature. Falling back to the approve tx is
    // only safe while NOTHING has been relayed yet, so this stage is isolated
    // from the confirm submission below.
    let permitSig = null;
    try {
      notify('Requesting gasless permit signature...', 'info');
      const pl = await api('/api/orders/checkout/permit-payload', {
        method: 'POST', body: JSON.stringify({ orderDraftId: prepared.orderDraftId, payerAddress }),
      });
      // Server payload has message.owner set to payerAddress already.
      const sig = await window.WalletBridge.signTypedData(pl.domain, pl.types, pl.message, pl.primaryType);
      const { v, r, s } = splitPermitSig(sig);
      permitSig = { v, r, s, deadline: pl.deadline };
    } catch (e) {
      const msg = String(e && (e.message || e));
      // User rejected / RPC down / bridge failed → fall back to the approve path.
      // Safe: no relay has been submitted at this point.
      notify('Gasless permit unavailable (' + msg + '). Falling back to approve tx...', 'info');
    }

    // ── Stage 2: submit the confirm. — this is deliberately OUTSIDE
    // the try/catch above.

    // The old code wrapped the permit call AND this POST in ONE try block, so a
    // confirm failure (e.g. a lost response after the server had already
    // relayed) fell through to the approve path and called confirm a SECOND
    // time. Because `on_chain_order_id` is usually still unresolved at that
    // moment, the server's idempotency check cannot catch it — a second
    // `createOrderFor` runs, the buyer is charged twice, and the first on-chain
    // order is orphaned.
    if (permitSig) {
      notify('Permit signed. Relaying order (gasless)...', 'info');
      return await api('/api/orders/checkout/confirm', {
        method: 'POST', body: JSON.stringify({
          orderDraftId: prepared.orderDraftId,
          permit: permitSig,
          payerAddress,
        }),
      });
    }

    // FALLBACK: direct USDC.approve tx from the EOA (buyer pays gas in USDC).
    // .F-fix — use the SERVER's exact micro amount (no client float math:
    // Math.round(total * 1e6) can be off by a micro-cent and desync the approve
    // from the amount the escrow relay pulls). approveCallData.parameters[1] is
    // the exact itemAmount+buyerFee; itemAmountMicro+buyerAdminFeeMicro is the
    // same value; only fall back to float math if the server fields are absent.
    const micro = prepared?.approveCallData?.parameters?.[1]
      ? BigInt(prepared.approveCallData.parameters[1])
      : (prepared?.itemAmountMicro && prepared?.buyerAdminFeeMicro)
        ? BigInt(prepared.itemAmountMicro) + BigInt(prepared.buyerAdminFeeMicro)
        : BigInt(Math.round(total * 1e6));
    const usdcAddr = prepared.usdcAddress || '0x3600000000000000000000000000000000000000';
    // same wrong-hardcoded-address problem as SLIME_ESCROW above.
    // Prefer the SERVER-supplied address (authoritative), then the health-derived
    // one; never a hardcoded guess.
    const escrowAddr = prepared.escrowAddress || window.SLIME_ESCROW_ADDRESS;
    if (!escrowAddr) throw new Error('escrow address not loaded yet — wait a moment and retry');
    const pad = (v) => v.replace('0x','').padStart(64,'0');
    notify('Approving USDC via external wallet...', 'info');
    const approveTxHash = await window.WalletBridge.sendTransaction({
      to: usdcAddr, data: '0x095ea7b3' + pad(escrowAddr) + micro.toString(16).padStart(64,'0'),
    });
    notify('Approval sent. Finalizing on-chain...', 'info');
    await new Promise(r => setTimeout(r, 3000));
    return await api('/api/orders/checkout/confirm', {
      method: 'POST', body: JSON.stringify({ orderDraftId: prepared.orderDraftId, approveTxHash, payerAddress }),
    });
  };

  const handlePay = async (product, variant, total, qty = 1, paymentMethod = 'external') => {
    if (!authed) { notify('Please login first to make purchases', 'error'); setView('beranda'); return; }

    // Card / Bank — coming soon
    if (paymentMethod === 'fiat') { notify('Card / Bank payment is coming soon!', 'info'); return; }

    setCheckout(null);

    // Cart cookie mirror: the in-flight purchase is the cart while checkout
    // runs; middleware's /checkout guard reads this cookie.
    syncCartCookie(cartItemsFromProduct(product, qty));

    // External wallet path (.D): PRIMARY = EIP-2612 permit (gasless —
    // buyer signs typed data, platform DCW relays createOrderFor); FALLBACK =
    // direct USDC.approve tx from the EOA (buyer pays gas — Arc gas is USDC).
    if (paymentMethod === 'external') {
      // .F-fix — read the connected EOA BEFORE prepare and send it as
      // payerAddress so prepare's balance gate targets the external wallet
      // (not the buyer's session UCW, which wrongly blocked EOA checkout).
      // Circle-only: external wallet only here; internal Slime Wallet
      // payments use the 'ucw' branch below (PIN challenge → approve → relay).
      const payerAddress = window.WalletBridge?.isConnected?.() ? window.WalletBridge.getAddress() : null;
      if (!payerAddress) { notify('Connect an external wallet first', 'error'); return; }
      try {
        notify('Preparing checkout...', 'info');
        const prepared = await api('/api/orders/checkout/prepare', {
          method: 'POST', body: JSON.stringify({ productId: product.id, variantLabel: variant.label, qty, payment: 'Onchain', payerAddress }),
        });
        const confirmed = await payExternalPermitOrApprove(prepared, payerAddress, total);
        await refreshWallet(); await refreshOrders();
        const order = await api('/api/orders/' + confirmed.orderId).catch(() => null);
        if (order) { setSelOrder(order); setCheckoutDone(order); }
        // never claim success we cannot prove. This branch used to
        // print "Payment successful!" unconditionally while the UCW branch
        // correctly checked `onChainOrderId`. A `pending` outcome (relay
        // accepted, contract id not yet resolved) was shown as success, so the
        // buyer stopped retrying on a payment that had not settled.
        if (confirmed.onChainOrderId) {
          notify('Payment successful! Seller is processing.', 'success');
        } else {
          notify(tr('co.paymentPending', 'Payment submitted — confirming on-chain. This can take a moment.'), 'info');
        }
      } catch (e) {
        // surface the typed server errors the same way the UCW branch
        // does, instead of a blanket "Checkout failed".
        const msg = e.message || 'Checkout failed';
        if (e.code === 'PAYMENT_NOT_MOVED') {
          notify(tr('co.paymentNotMoved', 'Payment was not submitted on-chain — no funds were moved. Please try again.'), 'error');
        } else if (e.code === 'INVALID_PERMIT') {
          notify('Permit signature rejected — please try again.', 'error');
        } else if (e.code === 'PERMIT_VERIFY_UNAVAILABLE') {
          notify('Could not verify the permit right now — please retry in a moment.', 'error');
        } else {
          notify('Checkout failed: ' + msg, 'error');
        }
      }
      clearCartCookie(); // checkout finished — cart empty again
      return;
    }

    const onchainEnabled = !!(window.ONCHAIN_FUNDS);
    if (!onchainEnabled) {
      // Legacy custodial path.
      try {
        const order = await api('/api/orders', { method: 'POST', body: JSON.stringify({ productId: product.id, variantLabel: variant.label, qty, payment: 'Balance' }) });
        await refreshWallet(); await refreshOrders();
        setSelOrder(order); setCheckoutDone(order);
        notify(product.delivery === 'instant' ? 'Payment successful! Access unlocked.' : 'Payment successful! Seller is processing.', 'success');
      } catch (e) { notify('Checkout failed: ' + e.message, 'error'); }
      clearCartCookie(); // checkout finished — cart empty again
      return;
    }

    // Non-custodial path.
    try {
      // Step 1: prepare draft + balance gate.
      notify('Preparing checkout...', 'info');
      const prepared = await api('/api/orders/checkout/prepare', {
        method: 'POST', body: JSON.stringify({ productId: product.id, variantLabel: variant.label, qty, payment: 'Onchain' }),
      });

      // Step 2: create UCW approve challenge.
      notify('Requesting wallet approval...', 'info');
      const challengeResp = await api('/api/orders/checkout/challenge', {
        method: 'POST', body: JSON.stringify({ orderDraftId: prepared.orderDraftId }),
      });
      const { challengeId, txId, devBypass } = challengeResp;

      // Step 3: buyer signs via W3SSdk (Phase 6.4 — credentials via /api/my/ucw-credentials).
      // Dev bypass: if devBypass=true, the backend already executed approve via DCW SDK.
      let approveTxHash = null;
      let approveTxId = null;
      if (devBypass) {
        notify('Dev bypass: approve executed via platform wallet...', 'info');
        approveTxId = txId; // Circle tx ID (not on-chain hash)
      } else {
        const execResult = await window.executeUcwChallenge(challengeId);
        if (execResult === null) {
          notify('Wallet session expired. Redirecting to refresh...', 'error');
          setTimeout(() => window.redirectToRefreshSession(), 1500);
          return;
        }
        notify('Approval confirmed. Finalizing on-chain...', 'info');
        approveTxHash = execResult.txHash;
      }

      // Step 4: confirm (relay createOrderFor). Pass on-chain txHash from W3S callback.
      const confirmBody = { orderDraftId: prepared.orderDraftId };
      if (approveTxHash) confirmBody.approveTxHash = approveTxHash;
      if (approveTxId) confirmBody.approveTxId = approveTxId;
      const confirmed = await api('/api/orders/checkout/confirm', {
        method: 'POST', body: JSON.stringify(confirmBody),
      });
      await refreshWallet(); await refreshOrders();
      const order = await api('/api/orders/' + confirmed.orderId).catch(() => null);
      if (order) { setSelOrder(order); setCheckoutDone(order); }
      // never claim success we cannot prove. `onChainOrderId` is the
      // contract's own order id; without it the relay reached Circle but the
      // order is not yet verifiable on-chain, so we say "processing" instead of
      // "successful". The server now also fails outright (PAYMENT_NOT_MOVED)
      // when nothing was submitted at all.
      if (confirmed.onChainOrderId) {
        notify('Payment successful! Seller is processing.', 'success');
      } else {
        notify(tr('co.paymentPending', 'Payment submitted — confirming on-chain. This can take a moment.'), 'info');
      }
    } catch (e) {
      const msg = e.message || 'Checkout failed';
      if (e.code === 'PIN_SETUP_REQUIRED') {
        // legacy account with no PIN: open the blocking gate.
        // /api/auth/me returns a fresh pin-only setup challenge. After the
        // user sets the PIN the checkout auto-retries once (pinRetryRef).
        notify(tr('pin.gateRequired', 'PIN setup is required — please complete it.'), 'warn');
        pinRetryRef.current = () => handlePay(product, variant, total, qty, paymentMethod);
        try {
          const r = await fetch((window.SLIME_API || '') + '/api/auth/me', { credentials: 'include' });
          const d = await r.json().catch(() => ({}));
          if (d.needsPinSetup && d.pinSetupChallengeId) setPinGate({ challengeId: d.pinSetupChallengeId, action: d.pinSetupAction || 'full-challenge' });
        } catch (ge) { console.warn('[checkout] pin gate open failed:', ge.message); }
      } else if (e.code === 'PIN_LOCKED') {
        notify(tr('pin.lockedMsg', 'Your wallet PIN is locked — try again later or restore it.'), 'error');
      } else if (e.code === 'PAYMENT_NOT_MOVED') {
        // the on-chain relay never started, so no USDC left the buyer.
        notify(tr('co.paymentNotMoved', 'Payment was not submitted on-chain — no funds were moved. Please try again.'), 'error');
      } else if (/insufficient on-chain balance/i.test(msg)) {
        notify('Insufficient USDC in your wallet. Top up first.', 'error');
      } else if (/user cancelled|Approval failed/i.test(msg)) {
        notify('Checkout cancelled.', 'info');
      } else {
        notify('Checkout failed: ' + msg, 'error');
      }
    }
    clearCartCookie(); // checkout finished — cart empty again
  };

  const updateOrder = (id, patch) => {
    setBuyerOrders(list => list.map(o => o.id === id ? { ...o, ...patch } : o));
    setSelOrder(o => o && o.id === id ? { ...o, ...patch } : o);
  };
  const handleConfirm = async (order) => {
    // Guard against a double submit: the UI used to look stale after the first
    // click, so the buyer clicked again and got "order status DONE cannot
    // release" — an error for work that had already succeeded.
    if (confirmingRef.current === order.id) return;
    confirmingRef.current = order.id;
    setConfirmingId(order.id);
    try {
      await api('/api/orders/' + order.id + '/confirm', { method: 'POST' });
      // Optimistic flip first so the page reacts instantly, then reconcile with
      // the server (which carries the on-chain release state).
      updateOrder(order.id, { status: 'DONE' });
      await refreshOrder(order.id);
      await refreshOrders(); await refreshWallet();
      await refreshMe(); // server bumps tx_count + promotes role at 3
      pushNotif({ icon: 'check-check', tone: 'emerald', title: 'Order Confirmed', text: order.id + ' · on-chain release in progress', go: 'orders' });
      notify('Order confirmed. On-chain release in progress.', 'success');
      setReviewOrder({ ...order, status: 'DONE' });
    } catch (e) {
      // Already settled by an earlier click — treat as success, not failure.
      if (/cannot release/i.test(e.message || '')) {
        updateOrder(order.id, { status: 'DONE' });
        await refreshOrder(order.id);
        setReviewOrder({ ...order, status: 'DONE' });
        notify('Order already confirmed.', 'success');
      } else {
        notify('Confirm failed: ' + e.message, 'error');
      }
    } finally {
      confirmingRef.current = null;
      setConfirmingId(null);
    }
  };
  const handleReviewSubmit = async (order, review) => {
    try {
      await api('/api/orders/' + order.id + '/review', {
        method: 'POST', body: JSON.stringify({ rating: review.rating, comment: review.comment || '' }),
      });
      updateOrder(order.id, { review });
      notify('Review submitted · thank you!', 'success');
    } catch (e) { notify('Review failed: ' + e.message, 'error'); }
    setReviewOrder(null);
  };
  const handleAppealSubmit = async (reason, chronology) => {
    if (!appealOrder) return;
    try {
      // The appeal endpoint accepts a single reason string; append the
      // chronology so the buyer's details aren't silently dropped.
      const detail = (chronology || '').trim();
      const fullReason = detail ? reason + ' — ' + detail : reason;
      await api('/api/orders/' + appealOrder.id + '/appeal', {
        method: 'POST', body: JSON.stringify({ reason: fullReason }),
      });
      updateOrder(appealOrder.id, { status: 'DISPUTED' });
      notify('Dispute sent to the Admin Tribunal', 'error');
    } catch (e) { notify('Appeal failed: ' + e.message, 'error'); }
    setAppealOrder(null);
  };
  const handleCancelOrder = async (reason) => {
    if (!cancelOrder) return;
    try {
      await api('/api/orders/' + cancelOrder.id + '/cancel', { method: 'POST', body: JSON.stringify({ reason }) });
      await refreshOrders(); await refreshWallet();
      notify('Order cancelled · funds returned', 'success');
    } catch (e) { notify('Cancel failed: ' + e.message, 'error'); }
    setCancelOrder(null);
  };
  // Phase 5 — Revoke dangling USDC allowance for a failed non-custodial order.
  const handleRevokeAllowance = async (order) => {
    if (!order) return;
    try {
      notify('Requesting revoke approval...', 'info');
      const { challengeId, txId } = await api('/api/orders/' + order.id + '/revoke-allowance', { method: 'POST' });
      const execResult = await window.executeUcwChallenge(challengeId);
      if (execResult === null) {
        notify('Wallet session expired. Redirecting to refresh...', 'error');
        setTimeout(() => window.redirectToRefreshSession(), 1500);
        return;
      }
      notify('Allowance revoked. Your USDC is safe.', 'success');
      void txId;
    } catch (e) {
      const msg = e.message || 'Revoke failed';
      if (/cancelled/i.test(msg)) notify('Revoke cancelled.', 'info');
      else notify(msg, 'error');
    }
  };
  const handleDecline = async (reason) => {
    if (!declineOrder) return;
    try {
      await api('/api/my/orders/' + declineOrder.id + '/decline', { method: 'POST', body: JSON.stringify({ reason }) });
      setSellerOrders(list => list.map(o => o.id === declineOrder.id ? { ...o, status: 'DECLINED', declineReason: reason } : o));
      notify('Order declined · buyer notified: ' + reason, 'info');
    } catch (e) { notify('Decline failed: ' + e.message, 'error'); }
    setDeclineOrder(null);
  };

  // ---- chat (shared Order Room thread between buyer & seller) ----
  // Start empty — real messages arrive from the backend. No seeded/fabricated
  // conversation.
  const ensureOrderChat = (orderId) => {
    setOrderChats(prev => prev[orderId] ? prev : ({ ...prev, [orderId]: [] }));
  };
  const sendOrderMsg = (orderId, from, text) => setOrderChats(prev => ({ ...prev, [orderId]: [...(prev[orderId] || []), { from, text, time: 'now' }] }));
  const sendDM = async (threadId, text) => {
    try {
      await api('/api/chats/' + threadId + '/messages', { method: 'POST', body: JSON.stringify({ text }) });
      setDmThreads(list => list.map(t => t.id === threadId ? { ...t, last: text, lastTime: 'now' } : t));
    } catch (e) {
      notify('Send failed: ' + e.message, 'error');
      throw e; // let ChatThread roll back its optimistic bubble
    }
  };
  const openOrderChat = async (order) => {
    if (!order || !order.id) return;
    try {
      const r = await api('/api/orders/' + order.id + '/chat');
      if (r && r.threadId) {
        setSelChatThread(r.threadId);
        await refreshChats();
        navTo('dm');
      } else {
        notify('No chat thread for this order', 'error');
      }
    } catch (e) { notify('Failed to open chat: ' + e.message, 'error'); }
  };
  const openSellerChat = (name) => {
    const store = STORES[name];
    // Check if a DM thread with this seller already exists
    const existing = dmThreads.find(t => t.title === name);
    if (existing) { navTo('dm'); return; }
    setChatCtx({ title: name, avatar: store ? store.avatar : 'from-arc-primary to-arc-accent', sub: store && store.online ? 'Online' : 'Usually replies fast', sellerName: name });
  };
  const sendSellerDM = async (sellerName, text) => {
    try {
      const r = await api('/api/chats', { method: 'POST', body: JSON.stringify({ participantName: sellerName, type: 'dm', initialMessage: text }) });
      if (r.id) {
        setDmThreads(list => [{ id: r.id, title: sellerName, avatar: 'from-arc-primary to-arc-accent', type: 'normal', last: text, lastTime: 'now', messages: [{ from: 'me', text, time: 'now' }] }, ...list]);
        setChatCtx(null);
        navTo('dm');
      }
    } catch (e) { notify('Failed to start chat: ' + e.message, 'error'); }
  };

  // ---- balance (wallet) ----
  const handleAddBank = async () => {
    // BUG FIX: was a local-only demo ("Bank account added (demo)") that never
    // hit the API and vanished on reload. Now prompts for real details and
    // persists via /api/wallet/bank-accounts (number is masked server-side).
    const bank = prompt('Bank name (e.g. BCA, Mandiri):');
    if (!bank || !bank.trim()) return;
    const number = prompt('Account number:');
    if (!number || !number.trim()) return;
    try {
      await api('/api/wallet/bank-accounts', {
        method: 'POST',
        body: JSON.stringify({ bank: bank.trim(), number: number.trim(), name: ME.name }),
      });
      await refreshBanks();
      notify('Bank account added', 'success');
    } catch (e) { notify('Add bank failed: ' + e.message, 'error'); }
  };
  const refreshBanks = async () => {
    try {
      const r = await api('/api/wallet/bank-accounts');
      if (r && Array.isArray(r.items)) setBanks(r.items);
    } catch (e) { console.warn('[banks] refresh failed:', e.message); }
  };
  const handleWithdrawFiat = () => { notify('Use the Crypto tab to withdraw on-chain', 'info'); };
  const handleWithdrawCrypto = async (destAddress, amountUsdc) => {
    try {
      await api('/api/wallet/withdraw', { method: 'POST', body: JSON.stringify({ destAddress, amountUsdc }) });
      await refreshWallet();
      notify('Withdraw ' + amountUsdc + ' USDC processed', 'success');
    } catch (e) { notify('Withdraw failed: ' + e.message, 'error'); }
  };

  // ---- WL escrow deals ----
  const handleWLDeal = async (payload) => {
    const onchainEnabled = !!(window.ONCHAIN_FUNDS);
    if (!onchainEnabled) {
      // Legacy custodial path.
      try {
        const r = await api('/api/wl/deals', {
          method: 'POST',
          body: JSON.stringify({ listingId: payload.wl.id, unit: payload.unit, qty: payload.qty || 1, isOffer: payload.isOffer || false }),
        });
        notify(payload.isOffer ? 'Offer sent to seller · funds not held yet' : 'Order sent to seller · funds not held yet', 'success');
        const locDeal = {
          id: r.id, listing: payload.wl, seller: payload.wl.seller, sellerAvatar: payload.wl.sellerAvatar,
          unit: payload.unit, qty: payload.qty || 1, price: payload.price, total: payload.total,
          isOffer: payload.isOffer, needsCollateral: payload.needsCollateral,
          sellerCollateral: 0, buyerHeld: false, status: 'WAITING', middlemanJoined: false,
          date: 'now', messages: [],
        };
        setWlDeals(list => [locDeal, ...list]);
        setSelDeal(locDeal.id); pushTo('dealroom', {id: locDeal.id});
        await refreshWallet();
      } catch (e) { notify('WL deal failed: ' + e.message, 'error'); }
      return;
    }

    // Non-custodial path (Phase 5 — F5 WL full).
    try {
      // .D3 — EOA external wallet connected? PRIMARY = gasless EIP-2612
      // permit (buyer signs typed data, platform relays createEscrowDealFor);
      // FALLBACK = direct USDC.approve tx from the EOA (buyer pays gas in USDC).
      const extPayer = window.WalletBridge?.isConnected?.() ? window.WalletBridge.getAddress() : null;

      // Step 1: prepare draft (payerAddress skips the buyer's UCW balance gate).
      notify('Preparing escrow deal...', 'info');
      const prepared = await api('/api/wl/deals/prepare', {
        method: 'POST', body: JSON.stringify({ listingId: payload.wl.id, unit: payload.unit, qty: payload.qty || 1, isOffer: payload.isOffer || false, ...(extPayer ? { payerAddress: extPayer } : {}) }),
      });

      if (extPayer) {
        // ---- EOA funding branch (.D3) ----
        let confirmed = null;
        if (window.WalletBridge.signTypedData) {
          try {
            const pl = await api('/api/wl/deals/' + prepared.dealDraftId + '/permit-payload', {
              method: 'POST', body: JSON.stringify({ payerAddress: extPayer }),
            });
            notify('Requesting gasless permit signature...', 'info');
            const sig = await window.WalletBridge.signTypedData(pl.domain, pl.types, pl.message, pl.primaryType);
            const { v, r, s } = splitPermitSig(sig);
            notify('Permit signed. Relaying deal (gasless)...', 'info');
            confirmed = await api('/api/wl/deals/confirm', {
              method: 'POST', body: JSON.stringify({
                dealDraftId: prepared.dealDraftId,
                permit: { v, r, s, deadline: pl.deadline },
                payerAddress: extPayer,
              }),
            });
          } catch (e) {
            notify('Gasless permit unavailable (' + (e.message || e) + '). Falling back to approve tx...', 'info');
          }
        }
        if (!confirmed) {
          // FALLBACK: direct USDC.approve from the EOA.
          // .F-fix — use the SERVER's exact micro amount from prepare
          // (totalApproveAmountMicro = price+baseFee; no client float math).
          const micro = prepared?.totalApproveAmountMicro
            ? BigInt(prepared.totalApproveAmountMicro)
            : BigInt(Math.round((payload.total || 0) * 1e6));
          notify('Approving USDC via external wallet...', 'info');
          const approveTxHash = await window.WalletBridge.sendTransaction({
            to: SLIME_USDC(), data: '0x095ea7b3' + padWord(SLIME_ESCROW()) + micro.toString(16).padStart(64, '0'),
          });
          notify('Approval sent. Finalizing on-chain...', 'info');
          await new Promise(r => setTimeout(r, 3000));
          confirmed = await api('/api/wl/deals/confirm', {
            method: 'POST', body: JSON.stringify({ dealDraftId: prepared.dealDraftId, approveTxHash, payerAddress: extPayer }),
          });
        }

        const locDeal = {
          id: confirmed.dealId, listing: payload.wl, seller: payload.wl.seller, sellerAvatar: payload.wl.sellerAvatar,
          unit: payload.unit, qty: payload.qty || 1, price: payload.price, total: payload.total,
          isOffer: payload.isOffer, needsCollateral: payload.needsCollateral,
          sellerCollateral: 0, buyerHeld: true, status: 'WAITING', middlemanJoined: false,
          date: 'now', messages: [],
          onChainDealId: confirmed.onChainDealId,
          buyerPayerWalletType: 'eoa', buyerPayerAddress: extPayer,
        };
        setWlDeals(list => [locDeal, ...list]);
        setSelDeal(locDeal.id); pushTo('dealroom', {id: locDeal.id});
        await refreshWallet();
        notify((payload.isOffer ? 'Offer sent' : 'Order sent') + ' + funds in escrow via external wallet', 'success');
        return;
      }

      // Step 2: create UCW approve challenge for buyer (approve price+baseFee).
      notify('Requesting wallet approval...', 'info');
      const chalResp = await api('/api/wl/deals/challenge', {
        method: 'POST', body: JSON.stringify({ dealDraftId: prepared.dealDraftId }),
      });
      const { challengeId, txId, devBypass } = chalResp;

      // Step 3: buyer signs via W3SSdk — or dev-bypass skips the UCW challenge.
      let approveTxHash = null;
      let approveTxId = null;
      if (devBypass) {
        notify('Dev bypass: approve executed via platform wallet...', 'info');
        approveTxId = txId; // Circle tx ID (not on-chain hash)
      } else {
        const execResult = await window.executeUcwChallenge(challengeId);
        if (execResult === null) {
          notify('Wallet session expired. Redirecting to refresh...', 'error');
          setTimeout(() => window.redirectToRefreshSession(), 1500);
          return;
        }
        notify('Approval confirmed. Finalizing on-chain...', 'info');
        approveTxHash = execResult.txHash;
      }

      // Step 4: confirm (relay createEscrowDealFor). Pass on-chain txHash or Circle txId.
      const confirmBody = { dealDraftId: prepared.dealDraftId };
      if (approveTxHash) confirmBody.approveTxHash = approveTxHash;
      if (approveTxId) confirmBody.approveTxId = approveTxId;
      const confirmed = await api('/api/wl/deals/confirm', {
        method: 'POST', body: JSON.stringify(confirmBody),
      });

      const locDeal = {
        id: confirmed.dealId, listing: payload.wl, seller: payload.wl.seller, sellerAvatar: payload.wl.sellerAvatar,
        unit: payload.unit, qty: payload.qty || 1, price: payload.price, total: payload.total,
        isOffer: payload.isOffer, needsCollateral: payload.needsCollateral,
        sellerCollateral: 0, buyerHeld: true, status: 'WAITING', middlemanJoined: false,
        date: 'now', messages: [],
        onChainDealId: confirmed.onChainDealId,
      };
      setWlDeals(list => [locDeal, ...list]);
      setSelDeal(locDeal.id); pushTo('dealroom', {id: locDeal.id});
      await refreshWallet();
      notify(payload.isOffer ? 'Offer sent + funds in escrow' : 'Order sent + funds in escrow', 'success');
    } catch (e) {
      const msg = e.message || 'WL deal failed';
      if (/insufficient on-chain balance/i.test(msg)) notify('Insufficient USDC. Top up first.', 'error');
      else if (/user cancelled|Approval failed/i.test(msg)) notify('Deal cancelled.', 'info');
      else notify('WL deal failed: ' + msg, 'error');
    }
  };
  const proceedDeal = async (id, collateral) => {
    const onchainEnabled = !!(window.ONCHAIN_FUNDS);
    if (!onchainEnabled) {
      // Legacy custodial path.
      try {
        await api('/api/wl/deals/' + id + '/proceed', { method: 'POST', body: JSON.stringify({ collateral: Number(collateral) || 0 }) });
        notify('Proceeded · funds in escrow · middleman joined', 'success');
        await refreshWallet();
        setWlDeals(list => list.map(d => d.id === id ? { ...d, status: 'ESCROW', buyerHeld: true, sellerCollateral: +(Number(collateral) || 0).toFixed(2), middlemanJoined: true } : d));
      } catch (e) { notify('Proceed failed: ' + e.message, 'error'); }
      return;
    }

    // Non-custodial path (Phase 5 — F5 seller collateral).
    try {
      // .D3 — seller EOA collateral path: WalletBridge connected →
      // approve(escrow, collateral) + depositEscrowCollateral(dealId, collateral)
      // from the seller's own wallet (msg.sender == d.seller satisfies the
      // contract; seller pays gas in USDC). Strictly verified server-side.
      const extSeller = window.WalletBridge?.isConnected?.() ? window.WalletBridge.getAddress() : null;
      if (extSeller && Number(collateral) > 0) {
        const dealRow = wlDeals.find(d => d.id === id);
        let onChainDealId = dealRow && dealRow.onChainDealId;
        if (onChainDealId == null) {
          const fresh = await api('/api/wl/deals/' + id).catch(() => null);
          onChainDealId = fresh && fresh.onChainDealId;
        }
        if (onChainDealId == null) { notify('Deal is not on-chain yet — cannot deposit collateral', 'error'); return; }

        // Link the connected wallet to the account (server-side identity).
        await fetch((window.SLIME_API || '') + '/api/wallet/connect', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ address: extSeller }),
        }).catch(() => {});

        const micro = BigInt(Math.round(Number(collateral) * 1e6));
        notify('Approving collateral via external wallet...', 'info');
        await window.WalletBridge.sendTransaction({
          to: SLIME_USDC(), data: '0x095ea7b3' + padWord(SLIME_ESCROW()) + micro.toString(16).padStart(64, '0'),
        });
        notify('Approval sent. Depositing collateral...', 'info');
        await new Promise(r => setTimeout(r, 3000));
        // depositEscrowCollateral(uint256 dealId, uint256 amount) = 0x25f043d8
        const depositTxHash = await window.WalletBridge.sendTransaction({
          to: SLIME_ESCROW(), data: '0x25f043d8' + BigInt(onChainDealId).toString(16).padStart(64, '0') + micro.toString(16).padStart(64, '0'),
        });
        notify('Deposit sent. Verifying on-chain...', 'info');
        await api('/api/wl/deals/' + id + '/collateral-eoa', {
          method: 'POST', body: JSON.stringify({ depositTxHash, collateralUsdc: String(collateral), sellerAddress: extSeller }),
        });
        notify('Collateral locked via external wallet · escrow active', 'success');
        await refreshWallet();
        setWlDeals(list => list.map(d => d.id === id ? { ...d, status: 'ESCROW', buyerHeld: true, sellerCollateral: +(Number(collateral) || 0).toFixed(2), middlemanJoined: true, sellerCollateralWalletType: 'eoa' } : d));
        return;
      }

      // Step 1: seller approve challenge.
      notify('Requesting collateral approval...', 'info');
      const chalResp = await api('/api/wl/deals/' + id + '/collateral-challenge', {
        method: 'POST', body: JSON.stringify({ collateralUsdc: String(collateral) }),
      });
      const { challengeId: approveChId, txId: approveTxIdResp, devBypass: approveBypass } = chalResp;

      // Step 1b: seller signs approve — or dev-bypass skips the UCW challenge.
      let approveTxHash = null;
      let approveTxId = null;
      if (approveBypass) {
        notify('Dev bypass: collateral approve executed...', 'info');
        approveTxId = approveTxIdResp;
      } else {
        const approveResult = await window.executeUcwChallenge(approveChId);
        if (approveResult === null) {
          notify('Wallet session expired. Redirecting to refresh...', 'error');
          setTimeout(() => window.redirectToRefreshSession(), 1500);
          return;
        }
        approveTxHash = approveResult.txHash;
      }

      // Step 2: proceed-non-custodial (verify approve + issue depositEscrowCollateral challenge).
      notify('Locking collateral...', 'info');
      const proceedBody = { collateralUsdc: String(collateral) };
      if (approveTxHash) proceedBody.approveTxHash = approveTxHash;
      if (approveTxId) proceedBody.approveTxId = approveTxId;
      const proceedResult = await api('/api/wl/deals/' + id + '/proceed-non-custodial', {
        method: 'POST', body: JSON.stringify(proceedBody),
      });

      // Step 3: seller signs depositEscrowCollateral — or dev-bypass.
      if (!proceedResult.devBypass) {
        const depositResult = await window.executeUcwChallenge(proceedResult.challengeId);
        if (depositResult === null) {
          notify('Wallet session expired. Redirecting to refresh...', 'error');
          setTimeout(() => window.redirectToRefreshSession(), 1500);
          return;
        }
        // The DB already claims seller_collateral from the proceed transition, but
        // that is only a claim — the deposit above is what actually moves the USDC
        // into MarketEscrow. Report the signed challenge so the server can verify
        // the deposit on-chain and record seller_collateral_tx_hash; without that
        // proof a later fraud slash reverts with "no collateral to slash".
        try {
          await api('/api/wl/deals/' + id + '/collateral-confirm', {
            method: 'POST',
            body: JSON.stringify({ depositChallengeId: proceedResult.challengeId }),
          });
        } catch (e) {
          // Non-fatal: the escrow is live and the seller is protected. Surface it
          // so a silently-missing collateral proof is not mistaken for success.
          notify('Collateral deposited, but proof could not be recorded: ' + e.message, 'warn');
        }
      }

      notify('Collateral locked · escrow active', 'success');
      await refreshWallet();
      setWlDeals(list => list.map(d => d.id === id ? { ...d, status: 'ESCROW', buyerHeld: true, sellerCollateral: +(Number(collateral) || 0).toFixed(2), middlemanJoined: true } : d));
    } catch (e) {
      const msg = e.message || 'Proceed failed';
      if (/user cancelled|cancelled/i.test(msg)) notify('Collateral deposit cancelled.', 'info');
      else notify('Proceed failed: ' + msg, 'error');
    }
  };
  const releaseDeal = async (id) => {
    try {
      await staffApi('/api/wl/deals/' + id + '/release', { method: 'POST' });
      notify('Deal released · 100% to seller (0% fee) + collateral returned', 'success');
      setWlDeals(list => list.map(d => d.id === id ? { ...d, status: 'COMPLETED' } : d));
      await refreshWallet();
    } catch (e) { notify('Release failed: ' + e.message, 'error'); }
  };
  const refundDeal = async (id) => {
    try {
      await staffApi('/api/wl/deals/' + id + '/refund', { method: 'POST' });
      notify('Deal refunded · buyer fully refunded', 'info');
      setWlDeals(list => list.map(d => d.id === id ? { ...d, status: 'CANCELLED' } : d));
      await refreshWallet();
    } catch (e) { notify('Refund failed: ' + e.message, 'error'); }
  };
  // cancel a WAITING deal (buyer/seller). No money has moved yet, so
  // this needs no staff token; the route enforces party-or-staff.
  const cancelDeal = async (id) => {
    if (!confirm('Cancel this escrow deal? No funds have moved yet.')) return;
    try {
      await api('/api/wl/deals/' + id + '/cancel', { method: 'POST' });
      notify('Deal cancelled', 'info');
      setWlDeals(list => list.map(d => d.id === id ? { ...d, status: 'CANCELLED' } : d));
    } catch (e) { notify('Cancel failed: ' + e.message, 'error'); }
  };
  // the 7-day permissionless escape hatch (contract ESCROW_TIMEOUT).
  // Any authenticated session may trigger it once the window has elapsed.
  const escapeHatchDeal = async (id, action) => {
    if (!confirm('Force ' + action + ' without the middleman? This settles the deal on-chain.')) return;
    try {
      const r = await api('/api/wl/deals/' + id + '/escape-hatch', {
        method: 'POST', body: JSON.stringify({ action }),
      });
      notify('Escape hatch submitted (' + (r && r.state ? r.state : 'accepted') + ')', 'success');
      await refreshWallet();
      await refreshWlDeals?.();
    } catch (e) { notify('Escape hatch failed: ' + e.message, 'error'); }
  };
  // 0071/0072 — escrow lifecycle actions a PARTY signs from their own wallet.
  // markDelivered / confirmEscrow / flagDispute all take a single uint256 (the
  // contract deal id), so one helper covers all three. The route re-reads the tx
  // from Arc and proves it before any DB change — the hash alone is never trusted.
  const WL_ACTION_SELECTOR = {
    markDelivered: '0xeb826a5f',
    confirmEscrow: '0x0b12c37f',
    flagDispute: '0xdaac3868',
  };
  // Two rails for the same three contract calls:
  //   • external EOA (WalletBridge) — the original path, kept for wallet users
  //   • UCW (email login)           — POST action-challenge, then W3SSdk.execute
  // Before this, only the WalletBridge rail existed, so a user who signed up with
  // email could fund an escrow and reach ESCROW but could never mark delivered,
  // confirm receipt, or open a dispute — the deal was stuck for them.
  const runDealAction = async (id, action, route, successMsg, extraBody) => {
    const connected = window.WalletBridge?.isConnected?.() ? window.WalletBridge.getAddress() : null;
    const dealRow = wlDeals.find(d => d.id === id);
    let onChainDealId = dealRow && dealRow.onChainDealId;
    if (onChainDealId == null) {
      const fresh = await api('/api/wl/deals/' + id).catch(() => null);
      onChainDealId = fresh && fresh.onChainDealId;
    }
    if (onChainDealId == null) { notify('Deal is not on-chain yet.', 'error'); return; }
    try {
      let txHash;
      if (connected) {
        // Link the connected wallet to the account so the server can recognise it
        // as a party to this deal (same call the collateral path makes).
        await fetch((window.SLIME_API || '') + '/api/wallet/connect', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ address: connected }),
        }).catch(() => {});
        txHash = await window.WalletBridge.sendTransaction({
          to: SLIME_ESCROW(),
          data: WL_ACTION_SELECTOR[action] + BigInt(onChainDealId).toString(16).padStart(64, '0'),
        });
      } else if (typeof window.executeUcwChallenge === 'function') {
        const ch = await api('/api/wl/deals/' + id + '/action-challenge', {
          method: 'POST', body: JSON.stringify({ action }),
        });
        if (!ch || !ch.challengeId) throw new Error('Could not start the wallet approval.');
        if (ch.devBypass) {
          txHash = ch.txId; // mock/dev session — server treats the DB as source of truth
        } else {
          const execResult = await window.executeUcwChallenge(ch.challengeId);
          if (execResult === null) {
            notify('Wallet session expired. Redirecting to refresh...', 'error');
            setTimeout(() => window.redirectToRefreshSession(), 1500);
            return;
          }
          // A CONTRACT_EXECUTION settles with `data: null`, so there is usually NO
          // txHash here. Send the challenge id instead — the server resolves it to
          // the real on-chain hash via Circle (the route accepts either).
          txHash = execResult.txHash || ch.challengeId;
        }
      } else {
        notify('Connect your wallet first (Wallet button).', 'error'); return;
      }
      notify('Transaction sent. Verifying on-chain…', 'info');
      await api('/api/wl/deals/' + id + '/' + route, {
        method: 'POST', body: JSON.stringify({ txHash, ...(extraBody || {}) }),
      });
      notify(successMsg, 'success');
      await refreshWallet();
      await refreshWlDeals?.();
    } catch (e) { notify('Failed: ' + e.message, 'error'); }
  };
  const markDeliveredDeal = (id) => runDealAction(id, 'markDelivered', 'mark-delivered', 'Marked delivered · buyer has 7 days to confirm');
  const confirmReceiptDeal = (id) => {
    if (!confirm('Confirm receipt? This releases the funds to the seller immediately and cannot be undone.')) return;
    runDealAction(id, 'confirmEscrow', 'confirm-receipt', 'Receipt confirmed · funds released to seller');
  };
  const disputeDeal = (id) => {
    if (!confirm('Raise a dispute? Settlement freezes until the middleman rules. If the platform never resolves it, the buyer is refunded after 30 days.')) return;
    // Ask for the reason BEFORE signing. The on-chain flag carries no
    // information on its own — without this the middleman has to reconstruct
    // the case by scrolling the chat, which is what the arbitrator brief exists
    // to avoid. Optional: an empty answer still raises the dispute.
    const reason = (window.prompt('Why are you disputing this deal? (optional — shown to the middleman)') || '').trim().slice(0, 2000);
    runDealAction(id, 'flagDispute', 'dispute', 'Dispute raised · middleman notified', reason ? { reason } : undefined);
  };
  // Seller tops up the fraud collateral. Negotiated in chat — the contract only
  // ever lets this grow, so the buyer's protection can never be reduced.
  const topUpCollateralDeal = async (id, amount) => {
    const connected = window.WalletBridge?.isConnected?.() ? window.WalletBridge.getAddress() : null;
    if (!connected) { notify('Connect your wallet first (Wallet button).', 'error'); return; }
    const dealRow = wlDeals.find(d => d.id === id);
    let onChainDealId = dealRow && dealRow.onChainDealId;
    if (onChainDealId == null) {
      const fresh = await api('/api/wl/deals/' + id).catch(() => null);
      onChainDealId = fresh && fresh.onChainDealId;
    }
    if (onChainDealId == null) { notify('Deal is not on-chain yet.', 'error'); return; }
    try {
      const micro = BigInt(Math.round(Number(amount) * 1e6));
      // approve(escrow, extra) then depositEscrowCollateral(dealId, extra) —
      // the same two-step the first deposit uses.
      await window.WalletBridge.sendTransaction({
        to: SLIME_USDC(), data: '0x095ea7b3' + padWord(SLIME_ESCROW()) + micro.toString(16).padStart(64, '0'),
      });
      notify('Approval sent. Adding collateral…', 'info');
      await new Promise(r => setTimeout(r, 3000));
      const txHash = await window.WalletBridge.sendTransaction({
        to: SLIME_ESCROW(),
        data: '0x25f043d8' + BigInt(onChainDealId).toString(16).padStart(64, '0') + micro.toString(16).padStart(64, '0'),
      });
      notify('Collateral tx sent (' + String(txHash).slice(0, 12) + '…) · collateral added', 'success');
      await refreshWallet();
      await refreshWlDeals?.();
    } catch (e) { notify('Top-up failed: ' + e.message, 'error'); }
  };
  // Admin/MM only — rules fraud and forfeits the seller's collateral to the
  // buyer. Relayed by the platform DCW, so no wallet connection is needed.
  const slashDealFn = async (id) => {
    if (!confirm('Rule FRAUD and forfeit the seller\'s collateral to the buyer? Only do this when the seller is proven to have defrauded the buyer.')) return;
    try {
      await staffApi('/api/wl/deals/' + id + '/slash', { method: 'POST' });
      notify('Collateral forfeited · buyer compensated', 'success');
      await refreshWallet();
      await refreshWlDeals?.();
    } catch (e) { notify('Slash failed: ' + e.message, 'error'); }
  };
  // D3 — the fiat leg. The money moves buyer→seller outside the platform, so the
  // only possible record is each side declaring it. Two one-way stamps.
  const markPaidDeal = async (id) => {
    if (!confirm('Confirm you have sent the payment to the seller? Only do this once the money has actually left your account.')) return;
    try {
      await api('/api/wl/deals/' + id + '/mark-paid', { method: 'POST' });
      notify('Marked as paid · waiting for the seller to confirm', 'success');
      await refreshWlDeals?.();
    } catch (e) { notify('Failed: ' + e.message, 'error'); }
  };
  const confirmPaymentDeal = async (id) => {
    if (!confirm('Confirm you have RECEIVED the payment? This unlocks delivery — only confirm once the money is in your account.')) return;
    try {
      await api('/api/wl/deals/' + id + '/confirm-payment', { method: 'POST' });
      notify('Payment confirmed · you can now mark the deal delivered', 'success');
      await refreshWlDeals?.();
    } catch (e) { notify('Failed: ' + e.message, 'error'); }
  };
  const handleWLList = async (listing) => {
    try {
      await api('/api/wl/listings', {
        method: 'POST',
        // BUG FIX: was dropping wlType, mintPrice, projectLink, offer, and img —
        // so created listings lost those fields on reload (looked like mocks).
        body: JSON.stringify({
          project: listing.project, type: listing.type, unitPrice: listing.unitPrice,
          qty: listing.qty, desc: listing.desc, collateral: listing.collateral,
          glyph: listing.glyph, gradient: listing.gradient,
          wlType: listing.wlType, mintPrice: listing.mintPrice,
          projectLink: listing.projectLink, offer: listing.offer, img: listing.img,
          // A1 — WTS (sell) or WTB (buy request). Server defaults to WTS.
          side: listing.side || 'WTS',
        }),
      });
      setWlListings(list => [listing, ...list]);
      notify(listing.side === 'WTB'
        ? 'Buy request published · sellers can now reach you'
        : 'WL "' + listing.project + '" published · escrow required', 'success');
    } catch (e) { notify('List WL failed: ' + e.message, 'error'); }
  };
  const openDeal = (id) => { setSelDeal(id); pushTo('dealroom', {id}); };
  const handleWalletAction = (act) => setWalletAction(act);
  const handleWalletConfirm = (msg) => { setWalletAction(null); notify(msg, 'success'); };

  // ---- PIN change wrapper flow ----
  // Trusts Circle's hosted UI (executeUcwChallenge) for the actual PIN change.
  // Never builds a custom PIN form — the raw PIN must never touch JS.
  // Flow: info toast → POST /api/my/pin-change → executeUcwChallenge → success/error/cancel toast
  const [pinChangeBusy, setPinChangeBusy] = useState(false);
  const handleChangePin = async () => {
    if (pinChangeBusy) return;
    if (typeof window.executeUcwChallenge !== 'function') {
      notify(tr('pinchange.noSdk', 'Wallet SDK not loaded — reload and try again'), 'error');
      return;
    }
    setPinChangeBusy(true);
    // 1. Info toast — "Opening Circle secure PIN change..."
    notify(tr('pinchange.opening', 'Opening Circle secure PIN change...'), 'info');
    try {
      // 2. Call POST /api/my/pin-change to get a Circle challenge ID
      const r = await fetch((window.SLIME_API || '') + '/api/my/pin-change', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      // 6. Handle session expiry (redirect to refresh-session)
      if (r.status === 401) {
        notify(tr('pinchange.sessionExpired', 'Session expired — refreshing...'), 'error');
        setTimeout(() => window.redirectToRefreshSession && window.redirectToRefreshSession(), 1500);
        return;
      }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Failed to start PIN change');
      if (!d.challengeId) throw new Error('No challenge returned by server');
      // 3. Open Circle hosted UI (old PIN → new PIN)
      try {
        await window.executeUcwChallenge(d.challengeId);
        // 4. Success toast — "Your PIN has been updated successfully"
        notify(tr('pinchange.success', 'Your PIN has been updated successfully'), 'success');
        // Refresh wallet so any PIN-derived state stays fresh
        refreshWallet();
      } catch (chErr) {
        const msg = (chErr && chErr.message) || String(chErr);
        // 5. If cancelled by user → info toast; else → error toast
        const cancelled = /cancel|abort|closed|dismiss/i.test(msg);
        if (cancelled) {
          notify(tr('pinchange.cancelled', 'PIN change cancelled'), 'info');
        } else {
          notify(tr('pinchange.failed', 'Failed to change PIN') + ': ' + msg, 'error');
        }
      }
    } catch (e) {
      // 3b. Error toast — "Failed to change PIN: [message]"
      notify(tr('pinchange.failed', 'Failed to change PIN') + ': ' + (e.message || e), 'error');
    } finally {
      setPinChangeBusy(false);
    }
  };
  // Expose globally so PinManagement (and any "Change PIN" button) can call it
  window.handleChangePin = handleChangePin;

  // ---- rekber ----
  // HONESTY FIX: these two handlers used to fabricate a local-only "escrow"
  // (`RKB-XXXXX` with Math.random), debit the displayed balance, and toast
  // success — with no API, no DB row and no on-chain escrow behind it (data
  // vanished on refresh). Real P2P escrow runs through the WL flow
  // (listing → deal → middleman release/refund), so point users there
  // instead of pretending.
  const handleCreateRekber = () => {
    notify(tr('rk.viaWl', 'P2P escrow now runs through WL: create a listing, then deal with a middleman who holds the funds.'), 'info');
    navTo('escrow');
  };
  const handleRekberFromChat = (target) => {
    setRekberTarget(null);
    navTo('escrow');
    notify(tr('rk.viaWlChat', 'To escrow with') + ' ' + target.user + ': ' + tr('rk.viaWlChatEnd', 'create a WL listing, then ask them to open the deal.'), 'info');
  };

  // ---- seller center ----
  const handleAdvance = async (id, status) => {
    try {
      const r = await api('/api/my/orders/' + id + '/process', { method: 'POST' });
      const newStatus = (r && r.status) || 'PROCESS';
      setSellerOrders(list => list.map(o => o.id === id ? { ...o, status: newStatus } : o));
      // For instant delivery the backend auto-sends credentials from stock —
      // no manual delivery step, so surface that to the seller.
      if (newStatus === 'SENT') {
        notify('Instant order ' + id.slice(0, 8) + ' auto-delivered from stock → SENT', 'success');
      } else {
        notify('Order ' + id.slice(0, 8) + ' → PROCESS', 'info');
      }
    } catch (e) { notify('Process failed: ' + e.message, 'error'); }
  };
  const openSellerOrder = (o) => { ensureOrderChat(o.id); setSelSellerOrder(o.id); pushTo('sellerorder', {id: o.id}); };
  const sellerSend = async (id, items, note) => {
    const creds = {};
    (items || []).forEach((line, i) => {
      const m = line.match(/^([^:]{1,28}):\s*(.+)$/);
      if (m) creds[m[1].trim()] = m[2].trim();
      else creds['Item ' + (i + 1)] = line;
    });
    try {
      await api('/api/my/orders/' + id + '/send', { method: 'POST', body: JSON.stringify({ credentials: creds, notes: note || '' }) });
      await refreshOrders(); await refreshSellerOrders();
      setSelOrder(o => (o && o.id === id) ? { ...o, status: 'SENT', credentials: creds, terms: note ? [note, ...(o.terms || [])] : (o.terms || []) } : o);
      setOrderChats(prev => prev[id] ? ({ ...prev, [id]: [...prev[id], { from: 'system', text: 'Seller shipped · check Order Info panel', time: 'now' }] }) : prev);
      pushNotif({ icon: 'package-check', tone: 'cyan', title: 'Order Shipped', text: id + ' · items sent to buyer', go: 'seller' });
      notify('Items shipped to buyer · ' + id + ' → SENT', 'success');
    } catch (e) { notify('Send failed: ' + e.message, 'error'); }
  };
  // .C1 — store editing removed: the profile IS the storefront.
  const handleApplySeller = async ({ category }) => { setApplyOpen(false); try { await api('/api/me/apply-seller', { method: 'POST', body: JSON.stringify({ category }) }); notify('Application submitted - pending admin review', 'success'); } catch (e) { notify('Apply failed: ' + e.message, 'error'); } };

  const goAuth = () => { setView('auth'); syncURL('auth'); };

  // /auth route: show login (or redirect home if already authed)
  if (view === 'auth') {
    if (authed) { navTo('beranda'); return null; }
    return <AuthScreen onAuthed={(d) => { handleAuthed(d); navTo('beranda'); }} />;
  }

  // /refresh-session route: Phase 4.3 — let existing users re-mirror UCW
  // credentials to localStorage without going through full signup. Reachable
  // when the checkout flow detects missing localStorage credentials.
  if (view === 'refresh-session') {
    if (typeof window.RefreshSession === 'function') return <RefreshSession />;
    return <div className="min-h-screen flex items-center justify-center text-arc-muted">Loading…</div>;
  }

  // Not authed: show AuthScreen for non-browseable views
  const BROWSEABLE = ['beranda', 'storefront', 'product', 'store'];
  if (!authed && !BROWSEABLE.includes(view)) {
    return <AuthScreen onAuthed={(d) => { handleAuthed(d); navTo('beranda'); }} />;
  }

  // Guest mode: browse marketplace without login
  if (!authed) {
    return (
      <div className="min-h-screen flex bg-arc-bg arc-mesh">
        <Sidebar active={activeNav} setView={navTo} open={sidebarOpen} setOpen={setSidebarOpen} role={'Guest'} guest />
        <div className="flex-1 min-w-0 flex flex-col">
          <GuestTopbar onMenu={() => setSidebarOpen(true)} onSearch={(q) => goStorefront('Semua', q)} onSignIn={goAuth} />
          <main className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto">
            {view === 'beranda' && <Beranda onProduct={openProduct} onBuy={goAuth} onCat={goStorefront} goStore={openStore} />}
            {view === 'storefront' && <Storefront onBuy={goAuth} onProduct={openProduct} query={storeQuery} cat={storeCat} onCatChange={setStoreCat} />}
            {view === 'product' && <ProductDetail product={selProduct} onBuy={goAuth} onStore={openStore} onBack={back} onChat={goAuth} />}
            {view === 'store' && <StorePage storeName={selStore} reviews={storeReviews[selStore]} onProduct={openProduct} onBuy={goAuth} onChat={goAuth} onBack={back} />}
          </main>
        </div>
        <Toast toast={toast} />
      </div>
    );
  }

  // 'wallet-only-challenge' = PIN already exists (Circle sets it automatically
  // for email-OTP accounts); the challenge only creates the ARC wallet. The gate
  // copy must say so instead of asking for a PIN that already exists.
  const pinGateWalletOnly = !!(pinGate && pinGate.action === 'wallet-only-challenge');

  return (
    <div className="min-h-screen flex bg-arc-bg arc-mesh">
      {/* BLOCKING PIN-setup gate. Renders ABOVE the entire app
          (fixed inset-0 z-[999]) until the user completes Circle's hosted
          PIN setup (Create PIN → Verify ×2 → security questions). */}
      {pinGate && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-arc-bg/95 backdrop-blur-sm p-6">
          <div className="w-full max-w-md anim-modal bg-arc-surface/60 ring-1 ring-arc-border rounded-2xl p-8 text-center">
            <div className="flex justify-center mb-5"><Icon name="shield-check" size={44} className="text-emerald-400" /></div>
            <h2 className="text-xl font-bold text-white">
              {pinGateWalletOnly
                ? tr('pin.walletGateTitle', 'Finish setting up your wallet')
                : tr('pin.gateTitle', 'Secure your wallet')}
            </h2>
            <p className="text-sm text-arc-muted mt-2 leading-relaxed">
              {pinGateWalletOnly
                ? tr('pin.walletGateDesc', 'Your wallet still needs to be created on-chain. Tap below to finish — your Circle PIN is already active, so nothing else is required from you.')
                : tr('pin.gateDesc', 'Before you continue, set up your 6-digit wallet PIN. You will create it, confirm it twice, and answer security questions — this protects every payment, send and withdrawal.')}
            </p>
            <div className="mt-6 space-y-3">
              <button onClick={runPinSetupGate} disabled={pinGateBusy}
                className="w-full h-12 rounded-xl bg-emerald-500 hover:brightness-110 text-white font-semibold text-sm transition disabled:opacity-50 disabled:cursor-not-allowed">
                {pinGateBusy
                  ? tr('pin.gateBusy', 'Opening secure setup…')
                  : pinGateWalletOnly
                    ? tr('pin.walletGateCta', 'Finish wallet setup')
                    : tr('pin.gateCta', 'Set up my PIN')}
              </button>
              {/* .C — skip option (Circle arc-ecommerce pattern): browsing +
                  external-wallet checkout work without a Slime Wallet PIN. */}
              <button onClick={skipPinGate}
                className="w-full h-12 rounded-xl ring-1 ring-arc-border text-arc-muted hover:text-arc-text hover:ring-arc-borderlt text-sm font-medium transition">
                {tr('pin.skipLater', 'Later — pay with your own wallet')}
              </button>
            </div>
            <p className="text-[11px] text-arc-faint mt-4">
              {pinGateWalletOnly
                ? tr('pin.walletGateNote', 'One step, done once. You can still buy by connecting your own wallet in the meantime.')
                : tr('pin.gateNote', 'Set up the PIN once to unlock Slime Wallet sending. You can still buy now by connecting your own wallet — no PIN needed.')}
            </p>
          </div>
        </div>
      )}
      <Sidebar active={activeNav} setView={navTo} open={sidebarOpen} setOpen={setSidebarOpen} role={role} />
      <div className="flex-1 min-w-0 flex flex-col">
        <Topbar usdc={usdc} onMenu={() => setSidebarOpen(true)} setView={navTo} onSearch={(q) => goStorefront('Semua', q)} onLogout={logout} role={role} onApply={() => setApplyOpen(true)} txCount={txCount} notifs={notifs} onReadNotifs={readAllNotifs} onClearNotifs={clearNotifs} />
        <main className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto">
          {view === 'beranda' && <Beranda onProduct={openProduct} onBuy={setCheckout} onCat={goStorefront} goStore={openStore} />}
          {view === 'storefront' && <Storefront onBuy={setCheckout} onProduct={openProduct} query={storeQuery} cat={storeCat} onCatChange={setStoreCat} />}
          {view === 'product' && <ProductDetail product={selProduct} onBuy={setCheckout} onStore={openStore} onBack={back} onChat={openSellerChat} />}
          {view === 'store' && <StorePage storeName={selStore} reviews={storeReviews[selStore]} onProduct={openProduct} onBuy={setCheckout} onChat={openSellerChat} onBack={back} />}
          {view === 'orders' && <PesananSaya orders={buyerOrders} loading={ordersLoading} onOpen={openOrder} onProduct={openProduct} />}
          {view === 'orderdetail' && <DetailPesanan order={selOrder} confirming={confirmingId === (selOrder && selOrder.id)} onBack={back} onConfirm={handleConfirm} onAppeal={setAppealOrder} onChat={openOrderChat} onStore={openStore} onCancel={setCancelOrder} onReview={setReviewOrder} onRevokeAllowance={handleRevokeAllowance} />}
          {view === 'escrow' && <FeatureComingSoon onBack={() => navTo('beranda')} />}
          {view === 'dealroom' && <FeatureComingSoon onBack={() => navTo('beranda')} />}
          {view === 'balance' && <Balance usdc={usdc} banks={banks} onWithdraw={handleWithdrawFiat} onAddBank={handleAddBank} onWithdrawCrypto={handleWithdrawCrypto} txs={fiatTxs} notify={notify} />}
          {view === 'dm' && <ChatDM threads={dmThreads} onSend={sendDM} onViewProfile={openProfile} onOpenOrder={openOrderById} notify={notify} selectedThreadId={selChatThread} onClearSelected={() => setSelChatThread(null)} />}
          {view === 'discussion' && <GlobalDiscussion role={role} notify={notify} onRekber={handleRekberFromChat} onViewProfile={openProfile} onUpsell={() => navTo('storefront')} />}
          {view === 'seller' && (canSell
            ? <SellerCenter orders={sellerOrders} onAdvance={handleAdvance} onDecline={setDeclineOrder} onOpenOrder={openSellerOrder} earnings={earnings} forumBalance={forumBalance} products={myProducts} setProducts={setMyProducts} notify={notify} onChat={openOrderChat} />
            : <SellerLocked onApply={() => setApplyOpen(true)} />)}
          {view === 'sellerorder' && (canSell
            ? <SellerOrderPage order={sellerOrders.find(o => o.id === selSellerOrder)} onBack={back} onAdvance={handleAdvance} onDecline={setDeclineOrder} onSend={sellerSend} onChat={openOrderChat} notify={notify} />
            : <SellerLocked onApply={() => setApplyOpen(true)} />)}
          {view === 'admin' && (role === 'Admin'
            ? <AdminConsole notify={notify} onChat={openOrderChat} />
            : <SellerLocked onApply={() => setApplyOpen(true)} />)}
          {view === 'mm' && ((role === 'Admin' || role === 'MM')
            ? <MiddlemanConsole wlDeals={wlDeals} onOpenDeal={openDeal} notify={notify} />
            : <SellerLocked onApply={() => setApplyOpen(true)} />)}
          {view === 'profile' && <UserDashboard usdc={usdc} txs={fiatTxs} notify={notify} onWalletAction={handleWalletAction} avatarImg={profileAvatar} onAvatarChange={(img) => { ME.avatarImg = img; setProfileAvatar(img); notify('Profile photo updated', 'success'); }} onChangePin={handleChangePin} pinChangeBusy={pinChangeBusy} />}
          {view === 'notfound' && (
            <div className="min-h-[60vh] flex flex-col items-center justify-center gap-4">
              <div className="text-6xl font-bold text-arc-faint">404</div>
              <div className="text-lg text-arc-muted">Page not found</div>
              <button onClick={() => navTo('beranda')} className="px-5 py-2.5 rounded-xl bg-arc-primary text-white text-sm font-medium hover:brightness-110 transition">Back to Home</button>
            </div>
          )}
        </main>
      </div>

      <CheckoutModal open={!!checkout} product={checkout} onClose={() => setCheckout(null)} onPay={handlePay} />
      <AppealModal open={!!appealOrder} onClose={() => setAppealOrder(null)} onSubmit={handleAppealSubmit} />
      {/* P2P escrow (rekber) parked for the mainnet push — never opens. */}
      {!COMING_SOON.has('rekber') && (
        <RekberModal open={!!rekberTarget} target={rekberTarget} onClose={() => setRekberTarget(null)} onCreate={handleRekberFromChat} />
      )}
      <ChatModal ctx={chatCtx} messages={chatCtx && chatCtx.seed ? chatCtx.seed : null} onSend={chatCtx && chatCtx.sellerName ? (text) => sendSellerDM(chatCtx.sellerName, text) : null} onClose={() => setChatCtx(null)} />
      <UserProfileModal name={profileName} onClose={() => setProfileName(null)} onChat={openSellerChat} onStore={openStore} />
      <ReasonModal open={!!cancelOrder} kind="cancel" reasons={CANCEL_REASONS} onClose={() => setCancelOrder(null)} onConfirm={handleCancelOrder} />
      <ReasonModal open={!!declineOrder} kind="decline" reasons={DECLINE_REASONS} onClose={() => setDeclineOrder(null)} onConfirm={handleDecline} />
      <ReviewModal open={!!reviewOrder} order={reviewOrder} onClose={() => setReviewOrder(null)} onSubmit={handleReviewSubmit} />
      {/* Post-checkout hand-off — the buyer is never left guessing whether the
          order went through, and can jump straight to the detail page. */}
      <Modal open={!!checkoutDone} onClose={() => setCheckoutDone(null)} width="max-w-md">
        <Card className="overflow-hidden">
          <div className="p-6 text-center border-b border-arc-border">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 ring-1 ring-emerald-500/30 flex items-center justify-center mx-auto mb-3"><Icon name="check-check" size={22} className="text-emerald-300" /></div>
            <div className="font-semibold text-arc-text text-lg">{tr('co.orderPlaced','Order placed!')}</div>
            <div className="text-sm text-arc-muted mt-1">{tr('co.orderPlacedSub','Your payment is in escrow. The seller has been notified.')}</div>
          </div>
          <div className="p-5 space-y-2.5">
            <Btn variant="primary" full icon="receipt" onClick={() => { const o = checkoutDone; setCheckoutDone(null); if (o) { setSelOrder(o); pushTo('orderdetail', { id: o.id }); } }}>{tr('co.viewOrder','View Order Detail')}</Btn>
            <Btn variant="ghost" full onClick={() => setCheckoutDone(null)}>{tr('co.continueShopping','Continue Shopping')}</Btn>
          </div>
        </Card>
      </Modal>
      <ApplySellerModal open={applyOpen} onClose={() => setApplyOpen(false)} onSubmit={handleApplySeller} />
      <WalletActionModal action={walletAction} usdc={usdc} onClose={() => setWalletAction(null)} onConfirm={handleWalletConfirm} notify={notify} />
      <Toast toast={toast} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
