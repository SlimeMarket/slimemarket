// ============ View: Balance — Top-up & Withdraw (fiat ramp) ============

// Fade-in animation for loaded content
(function () {
  if (document.getElementById('saldo-anim')) return;
  const s = document.createElement('style');
  s.id = 'saldo-anim';
  s.textContent =
    '@keyframes saldoFadeIn { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }' +
    '.saldo-fade-in { animation: saldoFadeIn .32s cubic-bezier(.2,.8,.2,1) both; }';
  document.head.appendChild(s);
})();

// ── the hand-rolled Gateway contract constants + encodeCall helper that
// used to live here were removed together with the Deposit/Withdraw buttons they
// served. Circle's Arc App Kit owns bridging now (it runs on Gateway/CCTP
// underneath), so the app no longer hand-encodes Gateway calldata.

const WITHDRAW_TABS = [
  { id: 'crypto', label: 'Crypto (ARC)', icon: 'bitcoin' },
  { id: 'bank', label: 'Bank (legacy)', icon: 'building-2' },
];

// ── inbound rails via Circle Arc App Kit ─────────────────────
// One panel, three honest ways to get USDC onto Arc:
//   • Buy   — fiat onramp widget (KYC + card/bank handled by Circle)
//   • Bridge— USDC from another chain via CCTP (App Kit)
//   • Swap  — token → USDC (MAINNET ONLY except Arc testnet)
// The bundle is ~2.2 MB, so it is lazy-loaded only when a rail is opened.
// CCTP transfer speed per source chain.

// `transferSpeed` defaults to FAST, but some chains only support CCTP Standard
// Transfer — Avalanche, Polygon PoS, Sei, XDC and their testnets. Asking for FAST
// on those fails with `PRE_FINALITY_UNAVAILABLE` (HTTP 422), so they are flagged
// here and the bridge call downgrades to SLOW instead of erroring.
const ADD_FUNDS_TABS = [
  { id: 'card', label: tr('af.tabCard', 'Buy with card/bank'), icon: 'credit-card' },
  { id: 'bridge', label: tr('af.tabBridge', 'Bridge'), icon: 'arrow-left-right' },
  { id: 'swap', label: tr('af.tabSwap', 'Swap'), icon: 'repeat' },
];

function AddFundsPanel({ notify, onFunded }) {
  const [tab, setTab] = useState('card');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [swapTokenIn, setSwapTokenIn] = useState('USDC');
  const [swapTokenOut, setSwapTokenOut] = useState('EURC');
  const [swapAmount, setSwapAmount] = useState('');

  const env = (window.AppKitHelper && window.AppKitHelper.environment()) || 'production';
  const isSandbox = env === 'sandbox';
  const destAddress = ME.wallet || null;
  // App Kit's bridge is EIP-1193 only. Without a provider the only way a user
  // can move USDC from another chain is the PIN-signed CCTP path below.
  // Bridge is external-wallet first: nothing moves until a wallet is connected.
  const [extAddr, setExtAddr] = useState(window.WalletBridge?.getAddress?.() || null);
  const isMainnet = String(window.SLIME_CONFIG?.chain?.id ?? '') === '5042';
  const connectExternal = async () => {
    setErr(''); setBusy(true);
    try {
      const addr = await window.WalletBridge.connect();
      if (!addr) { setBusy(false); return; }
      setExtAddr(addr);
      notify && notify('Wallet connected: ' + addr.slice(0, 6) + '...' + addr.slice(-4), 'success');
      fetch('/api/wallet/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ address: addr }) }).catch(() => {});
    } catch (e) { setErr(e.message || tr('af.connectFail', 'Connect failed')); }
    setBusy(false);
  };
  const disconnectExternal = () => { window.WalletBridge?.disconnect?.(); setExtAddr(null); notify && notify('Wallet disconnected', 'info'); };

  const doSwap = async () => {
    setErr('');
    const amt = parseFloat(swapAmount);
    if (!(amt > 0)) { setErr(tr('af.enterAmount', 'Enter an amount')); return; }
    if (!window.AppKitHelper) { setErr('App Kit helper not loaded — reload the page.'); return; }
    setBusy(true);
    try {
      const res = await window.AppKitHelper.swap({
        chain: 'Arc_Testnet',
        tokenIn: swapTokenIn,
        tokenOut: swapTokenOut,
        amountIn: swapAmount,
      });
      if (res && res.ok) {
        notify && notify(tr('af.swapDone', 'Swap submitted.'), 'success');
        onFunded && onFunded();
      } else {
        setErr((res && res.message) || 'Swap failed');
      }
    } catch (e) { setErr(e.message || 'Swap failed'); }
    setBusy(false);
  };

  const inputCls = 'mt-2 w-full bg-arc-surface/60 ring-1 ring-arc-border focus:ring-emerald-500/50 rounded-xl px-3.5 h-11 text-sm text-arc-text placeholder-arc-faint outline-none font-mono transition';
  const tabCls = (id) => `flex-1 flex items-center justify-center gap-1.5 text-xs font-medium rounded-lg py-2 transition-all duration-200 ${tab === id ? 'bg-arc-surface2 text-arc-text' : 'text-arc-muted hover:text-arc-text'}`;

  return (
    <div className="p-5 mb-5 rounded-2xl bg-arc-surface/60 ring-1 ring-arc-border">
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="text-xs uppercase tracking-[0.18em] text-arc-faint flex items-center gap-1.5">
          <Icon name="plus-circle" size={13} className="text-arc-accent" /> {tr('af.title', 'Add funds')}
        </div>
        <div className="flex items-center gap-2">
          {extAddr && (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 ring-1 ring-emerald-500/25 px-2 py-1 text-[10px] font-mono text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />{extAddr.slice(0, 4)}…{extAddr.slice(-4)}
            </span>
          )}
          {isMainnet
            ? <PixBadge color="emerald">{tr('balance.mainnet','Mainnet')}</PixBadge>
            : <PixBadge color="amber">{tr('balance.testnet','Testnet')}</PixBadge>}
          {isSandbox && <PixBadge color="amber">{tr('balance.sandbox','SANDBOX')}</PixBadge>}
        </div>
      </div>

      <div className="flex bg-arc-surface/60 ring-1 ring-arc-border rounded-xl p-1 mb-4">
        {ADD_FUNDS_TABS.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setErr(''); }} className={tabCls(t.id)}>
            <Icon name={t.icon} size={13} /> {t.label}
          </button>
        ))}
      </div>

      {err && (
        <div className="mb-3 text-xs text-rose-300 bg-rose-500/10 ring-1 ring-rose-500/30 rounded-lg px-3 py-2">{err}</div>
      )}

      {tab === 'card' && (
        <div className="py-2">
          <div className="w-10 h-10 rounded-xl bg-arc-surface2 ring-1 ring-arc-border flex items-center justify-center">
            <Icon name="clock" size={16} className="text-arc-faint" />
          </div>
          <div className="mt-3 text-[13px] font-medium text-arc-text">{tr('af.cardSoon','Buy with card or bank — coming soon')}</div>
          <p className="mt-1.5 text-xs text-arc-muted leading-relaxed max-w-prose">
            {tr('af.cardSoonHint','Card and bank purchases are being re-enabled. Until then, send USDC to your own Arc address from an exchange — it arrives in seconds and needs no bridge.')}
          </p>
          <Btn variant="outline" size="sm" icon="arrow-up-right" className="mt-3" onClick={() => setTab('bridge')}>
            {tr('af.depositInstead','Deposit instead')}
          </Btn>
        </div>
      )}

      {tab === 'bridge' && (
        // External wallet first. The old App Kit bridge only offered TESTNET
        // source chains (Base Sepolia, Fuji, …) while the app now runs on Arc
        // MAINNET, so "Bridge USDC" was a dead end for every real user. Deposit
        // to the user's own Arc address is the path that actually works.
        <div className="space-y-4">
          <p className="text-xs text-arc-muted leading-relaxed max-w-prose">
            {tr('af.bridgeMainnetDesc','Connect an external wallet (MetaMask, Rabby, Coinbase Wallet) to fund this account, then send USDC on Arc to your own address — it lands in your Slime Wallet instantly.')}
          </p>

          {extAddr ? (
            <>
              <div className="flex items-center justify-between gap-2 rounded-xl bg-emerald-500/10 ring-1 ring-emerald-500/25 px-3.5 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                    {tr('af.connected','External wallet connected')}
                  </div>
                  <div className="mt-1 font-mono text-[13px] text-emerald-300 truncate">{extAddr}</div>
                </div>
                <button onClick={disconnectExternal} className="text-[11px] text-arc-faint hover:text-rose-300 transition-colors shrink-0">
                  {tr('balance.disconnect','Disconnect')}
                </button>
              </div>

              <div>
                <label className="text-[11px] text-arc-faint">{tr('af.depositAddr','Your Arc deposit address')}</label>
                <div className="mt-1.5">
                  {destAddress
                    ? <CopyChip value={destAddress} displayValue={destAddress.slice(0, 12) + '…' + destAddress.slice(-8)} />
                    : <span className="text-xs text-arc-faint">—</span>}
                </div>
              </div>

              <p className="text-[11px] text-arc-faint leading-relaxed">
                {tr('af.depositNote','Send USDC on Arc to that address from your exchange or external wallet. Gas is paid in USDC, so the first send should leave a small buffer.')}
              </p>
            </>
          ) : (
            <Btn variant="emerald" size="lg" full icon="link" loading={busy} onClick={connectExternal}>
              {busy ? tr('af.starting', 'Starting…') : tr('af.connectWallet','Connect wallet')}
            </Btn>
          )}
        </div>
      )}

      {tab === 'swap' && (
        isMainnet
          ? (
            // doSwap() bridges through App Kit with a hardcoded `Arc_Testnet`
            // target — on mainnet that call cannot succeed, so the form is not
            // offered there instead of failing after the user signs.
            <div className="py-2">
              <div className="w-10 h-10 rounded-xl bg-arc-surface2 ring-1 ring-arc-border flex items-center justify-center">
                <Icon name="clock" size={16} className="text-arc-faint" />
              </div>
              <div className="mt-3 text-[13px] font-medium text-arc-text">{tr('af.swapSoon','Swap — coming soon')}</div>
              <p className="mt-1.5 text-xs text-arc-muted leading-relaxed max-w-prose">
                {tr('af.swapSoonHint','Swapping is only available on Arc testnet for now. On mainnet, send USDC to your Arc address instead — no swap needed.')}
              </p>
            </div>
          )
          : (
            <div className="space-y-3">
              <div className="flex items-start gap-2 text-xs text-amber-300/90 bg-amber-500/10 ring-1 ring-amber-500/25 rounded-lg px-3 py-2">
                <Icon name="alert-triangle" size={13} className="mt-0.5 shrink-0" />
                <span>{tr('af.swapMainnet', 'Swapping non-USDC assets (e.g. ETH, BNB) into USDC is a mainnet feature. On testnet only USDC ↔ EURC is available.')}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-arc-muted">{tr('af.from', 'From')}</label>
                  <select value={swapTokenIn} onChange={e => setSwapTokenIn(e.target.value)} className={inputCls}>
                    <option value="USDC">USDC</option>
                    <option value="EURC">EURC</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-arc-muted">{tr('af.to', 'To')}</label>
                  <select value={swapTokenOut} onChange={e => setSwapTokenOut(e.target.value)} className={inputCls}>
                    <option value="EURC">EURC</option>
                    <option value="USDC">USDC</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs text-arc-muted">{tr('af.amount', 'Amount')}</label>
                <input value={swapAmount} onChange={e => setSwapAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="10.00" className={inputCls} />
              </div>
              <Btn variant="emerald" size="lg" full icon="repeat" disabled={busy} onClick={doSwap}>
                {busy ? tr('af.working', 'Working…') : tr('af.swapCta', 'Swap')}
              </Btn>
            </div>
          )
      )}
    </div>
  );
}


// ── CCTP bridge for Slime Wallet users (no external wallet) ──────────
// The user's own wallet signs an approve + a depositForBurn with their PIN; the
// USDC is minted to their Arc address. Three things this UI must be honest
// about, because all three block the flow and none are obvious:
//   1. the source wallet needs a little native gas (ETH/AVAX) — nothing else in
//      the app ever puts any there
//   2. the approval is a separate transaction from the burn
//   3. the mint waits ~15 min for Circle's attestation, and the USDC is already
//      out of the source wallet during that window
function Balance({ usdc, banks, onWithdraw, onAddBank, onWithdrawCrypto, txs, notify }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('qris');
  const [withdrawTab, setWithdrawTab] = useState('crypto');
  const [cryptoAddr, setCryptoAddr] = useState('');
  const [cryptoAmt, setCryptoAmt] = useState('');
  const [gwBalance, setGwBalance] = useState(null);
  const [extWallet, setExtWallet] = useState(window.WalletBridge?.getAddress?.() || null);
  const fiat = (parseFloat(amount) || 0);
  const valid = fiat >= 1 && fiat <= SALDO.maxTopupUSDC;
  const isID = getLang() === 'id';
  // with ONCHAIN_FUNDS, users' funds live in their own on-chain wallet
  // and the DB "saldo" is legacy. Hide the platform-custodial UI (fiat top-up,
  // bank management, withdraw-to-bank, legacy platform crypto withdraw, and
  // the Circle MPC/UCW section that debits the same legacy balance).
  const custodialHidden = !!window.ONCHAIN_FUNDS;

  // Fetch Gateway balance + listen for external wallet changes
  useEffect(() => {
    const fetchGw = async () => {
      try {
        const r = await fetch('/api/wallet/gateway/balance', { credentials: 'include' });
        if (r.ok) { const d = await r.json(); setGwBalance(d.totalBalanceUsdc || '0.000000'); }
      } catch { /* ignore */ }
    };
    fetchGw();
    const unsub = window.WalletBridge?.onAccountsChanged?.((addr) => { setExtWallet(addr); fetchGw(); });
    return () => { unsub?.(); };
  }, []);

  // ── .C2: WalletActionModal (moved from userdash.jsx) ─────────
  const [walletAction, setWalletAction] = useState(null);

  // ── .C2: PIN & Security status ────────────────────────────────
  const [pinStatus, setPinStatus] = useState(null);
  const [pinBusy, setPinBusy] = useState(false);
  const fetchPinStatus = async () => {
    try {
      const r = await fetch('/api/my/pin-status', { credentials: 'include' });
      if (!r.ok) { setPinStatus({ error: true }); return; }
      setPinStatus(await r.json());
    } catch { setPinStatus({ error: true }); }
  };
  // Opsi A (2026-09-27): the PIN & Security card was removed, so we no longer
  // poll /api/my/pin-status on mount. fetchPinStatus is kept for a future
  // PIN-based auth mode.

  const runPinAction = async (endpoint, doneMsg) => {
    if (!window.executeUcwChallenge) { notify(tr('wallet.pinNoUcw','Wallet SDK not loaded — log in with a Circle account first.'),'error'); return; }
    setPinBusy(true);
    try {
      const r = await fetch(endpoint, { method: 'POST', credentials: 'include' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        notify(r.status === 401 ? 'Session expired — refresh at /refresh-session' : (d.error || 'PIN action failed'), 'error');
        return;
      }
      await window.executeUcwChallenge(d.challengeId, { isPinSetup: false });
      notify(doneMsg, 'success');
      await fetchPinStatus();
    } catch (e) { notify(e?.message || 'PIN action failed', 'error'); }
    setPinBusy(false);
  };

  // ── .C: real PIN-setup flow ─────────────────────────────────
  const setupPin = async () => {
    if (!window.executeUcwChallenge) { notify(tr('wallet.pinNoUcw','Wallet SDK not loaded — log in with a Circle account first.'),'error'); return; }
    setPinBusy(true);
    try {
      const r = await fetch('/api/my/pin-setup', { method: 'POST', credentials: 'include' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        notify(r.status === 401 ? 'Session expired — refresh at /refresh-session' : (d.error || 'PIN setup failed'), 'error');
        return;
      }
      // FIX `executeUcwChallenge` resolves with `null` (does not throw)
      // when /api/my/ucw-credentials has no valid session, and the
      // provisioning-complete response used to be ignored. Both were reported
      // to the user as "PIN set up — wallet ready" even when nothing happened.
      const result = await window.executeUcwChallenge(d.challengeId, { isPinSetup: true });
      if (!result) {
        notify('Wallet session expired — reload the page and try again.', 'error');
        setPinBusy(false);
        return;
      }
      let provisioned = false;
      try {
        const pc = await fetch('/api/wallet/ucw-provisioning-complete', { method: 'POST', credentials: 'include' });
        provisioned = pc.ok;
        if (!pc.ok) console.warn('[pin] provisioning-complete failed:', pc.status);
      } catch { /* best-effort — gate/CTA retries next time */ }
      if (!provisioned) {
        notify('Wallet setup incomplete — please retry.', 'warn');
        setPinBusy(false);
        return;
      }
      notify(tr('wallet.pinSetupDone','PIN set up — wallet ready.'), 'success');
      await fetchPinStatus();
    } catch (e) { notify(e?.message || 'PIN setup failed', 'error'); }
    setPinBusy(false);
  };

  // ── supplement tx history from Circle when DB list empty ──────────
  const [circleTxs, setCircleTxs] = useState([]);
  useEffect(() => {
    if (txs && txs.length > 0) return;
    fetch('/api/wallet/circle-txs', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && Array.isArray(d.txs) && d.txs.length > 0) setCircleTxs(d.txs); })
      .catch(() => {});
  }, []);
  const histList = (txs && txs.length > 0) ? txs : circleTxs;

  // ── Connect External Wallet ────────────────────────────────────────
  const handleConnectWallet = async () => {
    try {
      const addr = await window.WalletBridge.connect();
      if (addr) {
        setExtWallet(addr);
        notify('Wallet connected: ' + addr.slice(0, 6) + '...' + addr.slice(-4), 'success');
        fetch('/api/wallet/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ address: addr }) }).catch(() => {});
      } else { notify('Connection cancelled', 'info'); }
    } catch (e) { notify('Connect failed: ' + (e.message || e), 'error'); }
  };
  const visibleMethods = isID ? TOPUP_METHODS : TOPUP_METHODS.filter(m => m.id !== 'qris');
  const cryptoValid = cryptoAddr.startsWith('0x') && cryptoAddr.length === 42 && parseFloat(cryptoAmt) > 0 && parseFloat(cryptoAmt) <= usdc;
  useEffect(() => { if (!isID && method === 'qris') setMethod('card'); }, [isID, method]);

  // ── derived display values (bento) ──────────────────────────────
  const chainCfg = (window.SLIME_CONFIG && window.SLIME_CONFIG.chain) || null;
  const chainLabel = (chainCfg && chainCfg.name) || 'Arc';
  const chainId = chainCfg && chainCfg.id ? String(chainCfg.id) : '';
  const inTotal = histList.filter(t => t.type === 'in').reduce((a, t) => a + (Number(t.amount) || 0), 0);
  const outTotal = histList.filter(t => t.type !== 'in').reduce((a, t) => a + (Number(t.amount) || 0), 0);
  const pendingCount = histList.filter(t => String(t.status || '').toUpperCase() === 'PENDING').length;
  return (
    <div className="anim-view max-w-3xl mx-auto">
      {/* ── header ───────────────────────────────────────────────────── */}
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-[10px] font-pixel uppercase tracking-[0.22em] text-arc-faint">{tr('balance.kicker','WALLET')}</div>
          <h1 className="mt-1.5 text-lg font-semibold tracking-tight text-white">{tr('balance.pageTitle','Balance & Transactions')}</h1>
        </div>
        <span className="text-[11px] text-arc-faint">{chainLabel}{chainId ? ' · ' + chainId : ''}</span>
      </div>

      {/* ── balance ──────────────────────────────────────────────────── */}
      <div className="mt-10">
        <div className="text-[10px] uppercase tracking-[0.2em] text-arc-faint">{tr('balance.totalBalance','Total Balance')}</div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="font-mono text-[3rem] leading-none font-medium tracking-tight text-white tabular-nums">
            {Number(usdc || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}
          </span>
          <span className="text-xs text-arc-faint">USDC</span>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {ME.wallet
            ? <CopyChip value={ME.wallet} displayValue={ME.wallet.slice(0, 10) + '…' + ME.wallet.slice(-6)} />
            : <span className="text-xs text-arc-faint">—</span>}
          <span className="text-[11px] text-arc-faint">{tr('balance.receiveShare','Receive: share this address')}</span>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <Btn variant="emerald" size="sm" icon="arrow-up-from-line" onClick={() => setWalletAction('send')}>{tr('c.send','Send')}</Btn>
          <Btn variant="ghost" size="sm" icon="plus" onClick={() => document.getElementById('add-funds')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{tr('balance.addFundsShort','Add funds')}</Btn>
          {!custodialHidden && (
            <Btn variant="ghost" size="sm" icon="credit-card" onClick={() => document.getElementById('add-funds')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{tr('ud.topup','Top Up')}</Btn>
          )}
        </div>
      </div>

      {/* ── inline stats (no boxes) ──────────────────────────────────── */}
      <dl className="mt-8 flex flex-wrap items-baseline gap-x-7 gap-y-2 border-t border-arc-border/60 pt-4 text-[11px]">
        <div className="flex items-baseline gap-1.5">
          <dt className="text-arc-faint flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />{tr('balance.inLower','in')}</dt>
          <dd className="font-mono tabular-nums text-arc-muted">{inTotal.toFixed(2)}</dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-arc-faint flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-rose-400" aria-hidden="true" />{tr('balance.outLower','out')}</dt>
          <dd className="font-mono tabular-nums text-arc-muted">{outTotal.toFixed(2)}</dd>
        </div>
        <div className="flex items-baseline gap-1.5">
          <dt className="text-arc-faint flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-arc-accent" aria-hidden="true" />{tr('balance.txsLower','transactions')}</dt>
          <dd className="font-mono tabular-nums text-arc-muted">{histList.length}</dd>
        </div>
        {pendingCount > 0 && (
          <div className="flex items-baseline gap-1.5">
            <dt className="text-arc-faint">{tr('balance.pendingLower','pending')}</dt>
            <dd className="font-mono tabular-nums text-amber-300/90">{pendingCount}</dd>
          </div>
        )}
      </dl>

      {/* ── add funds ────────────────────────────────────────────────── */}
      <section id="add-funds" className="scroll-mt-4 mt-10">
        <AddFundsPanel notify={notify} onFunded={() => window.refreshWallet?.()} />
      </section>

      {/* Legacy platform-custodial withdraw (hidden while ONCHAIN_FUNDS). */}
      {!custodialHidden && (
        <section className="mt-10">
          <h2 className="text-[10px] uppercase tracking-[0.2em] text-arc-faint">{tr('balance.withdrawTitle','Withdraw Balance')}</h2>
          <div className="mt-3 flex bg-arc-bg/50 ring-1 ring-arc-border rounded-lg p-1">
            {WITHDRAW_TABS.map(t => (
              <button key={t.id} type="button" onClick={() => setWithdrawTab(t.id)}
                className={`flex-1 flex items-center justify-center gap-1.5 text-xs rounded-md py-1.5 transition-colors ${withdrawTab === t.id ? 'bg-arc-surface2 text-arc-text' : 'text-arc-muted hover:text-arc-text'}`}>
                <Icon name={t.icon} size={12} /> {t.label}
              </button>
            ))}
          </div>

          {withdrawTab === 'crypto' ? (
            <div className="mt-4 space-y-3">
              <div>
                <label className="text-[11px] text-arc-faint">{tr('balance.arcAddress','Arc Address (0x…)')}</label>
                <input value={cryptoAddr} onChange={e => setCryptoAddr(e.target.value)} placeholder="0x7A3f9C4e2B81dA56e0F1b9C7Ae44D2c8b6E91f0a" className="mt-1.5 w-full bg-arc-bg/50 ring-1 ring-arc-border focus:ring-arc-primary/40 rounded-lg px-3 h-11 text-sm text-arc-text placeholder-arc-faint outline-none font-mono transition-colors" />
              </div>
              <div>
                <label className="text-[11px] text-arc-faint">{tr('balance.amountUSDC','USDC Amount')}</label>
                <input value={cryptoAmt} onChange={e => setCryptoAmt(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="10.00" className="mt-1.5 w-full bg-arc-bg/50 ring-1 ring-arc-border focus:ring-arc-primary/40 rounded-lg px-3 h-11 text-sm text-arc-text placeholder-arc-faint outline-none font-mono transition-colors" />
              </div>
              <p className="text-[11px] text-arc-faint leading-relaxed">{tr('balance.cryptoNote','Withdraw on-chain to an Arc address (native USDC). 1 confirmation = final. Destination is checked against the blocklist.')}</p>
              <Btn variant="outline" size="sm" icon="arrow-up-from-line" disabled={!cryptoValid} onClick={() => onWithdrawCrypto(cryptoAddr, cryptoAmt)}>
                {tr('balance.withdrawToArc','Withdraw to Arc Address')}
              </Btn>
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <p className="text-[11px] text-arc-faint">{tr('balance.bankLegacyNote','Bank withdrawal (legacy) — use the Crypto tab for faster on-chain withdrawals.')}</p>
              {banks.length === 0 ? (
                <div className="flex items-center gap-3 py-2">
                  <span className="text-[11px] text-arc-faint">{tr('balance.noBank','No bank account yet')}</span>
                  <Btn variant="ghost" size="sm" icon="plus" onClick={onAddBank}>{tr('balance.addAccount','Add Account')}</Btn>
                </div>
              ) : (
                <div className="divide-y divide-arc-border/50 border-t border-arc-border/60">
                  {banks.map((b, i) => (
                    <div key={i} className="flex items-center gap-3 py-3">
                      <div className="flex-1">
                        <div className="text-[13px] text-arc-text">{b.bank}</div>
                        <div className="text-[11px] text-arc-faint font-mono">{b.number} · {b.name}</div>
                      </div>
                      <Icon name="check-circle" size={14} className="text-emerald-400" />
                    </div>
                  ))}
                  <div className="pt-3"><Btn variant="outline" size="sm" icon="arrow-up-from-line" onClick={onWithdraw}>{tr('balance.withdrawToBank','Withdraw to Bank')}</Btn></div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── history ──────────────────────────────────────────────────── */}
      <section className="mt-10">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[10px] uppercase tracking-[0.2em] text-arc-faint">{tr('balance.history','Transaction History')}</h2>
          <span className="text-[10px] text-arc-faint tabular-nums">{histList.length}</span>
        </div>

        {histList.length === 0 ? (
          <div className="mt-3 border-t border-arc-border/60 py-10 text-center">
            <div className="text-[13px] text-arc-muted">{tr('wallet.noTxs','No transactions yet.')}</div>
            <div className="mt-1 text-[11px] text-arc-faint">{tr('balance.txEmpty','Recent Transactions will appear here')}</div>
          </div>
        ) : (
          <div className="mt-1 divide-y divide-arc-border/50 border-t border-arc-border/60">
            {histList.map(t => {
              const isIn = t.type === 'in';
              const statusUpper = (t.status || '').toString().toUpperCase();
              const statusTone = statusUpper === 'DONE' ? 'text-emerald-400/80'
                : statusUpper === 'PENDING' ? 'text-amber-300/90'
                : statusUpper === 'FAILED' ? 'text-rose-400/90'
                : statusUpper === 'ESCROWED' ? 'text-cyan-300/80'
                : 'text-arc-faint';
              return (
                <div key={t.id} className="flex items-center gap-3 py-3">
                  <Icon name={isIn ? 'arrow-down-left' : 'arrow-up-right'} size={13}
                    className={`shrink-0 ${isIn ? 'text-emerald-400/80' : 'text-rose-400/80'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-arc-text leading-tight truncate">{t.label}</div>
                    <div className="mt-0.5 text-[11px] text-arc-faint flex items-center gap-1.5 min-w-0">
                      <span className="truncate">{t.sub}</span>
                      <span className="text-arc-faint/40">·</span>
                      <span className="whitespace-nowrap">{t.time}</span>
                      {t.txHash && (
                        <a href={String(window.ARC_EXPLORER_URL || 'https://arc.etherscan.io').replace(/\/+$/, '') + '/tx/' + t.txHash} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-0.5 font-mono text-[10px] text-arc-accent/80 hover:text-arc-accent transition-colors whitespace-nowrap">
                          <Icon name="external-link" size={9} /> {t.txHash.slice(0, 6)}
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`font-mono text-[13px] tabular-nums ${isIn ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {isIn ? '+' : '−'}{Number(t.amount || 0).toFixed(2)}
                    </div>
                    <div className={`mt-0.5 text-[9px] uppercase tracking-[0.12em] ${statusTone}`}>{statusUpper || '—'}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── connections ──────────────────────────────────────────────── */}
      <section className="mt-10">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-arc-faint">{tr('balance.connections','CONNECTIONS')}</h2>
        <div className="mt-1 divide-y divide-arc-border/50 border-t border-arc-border/60">
          <div className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <div className="text-[13px] text-arc-text">{tr('balance.extWallets','External wallets')}</div>
              <div className="mt-0.5 text-[11px] text-arc-faint font-mono truncate">
                {extWallet ? extWallet.slice(0, 6) + '…' + extWallet.slice(-4) : tr('balance.extHintShort','MetaMask, Rabby, Coinbase')}
              </div>
            </div>
            {extWallet ? (
              <button type="button" onClick={() => { window.WalletBridge?.disconnect?.(); setExtWallet(null); notify('Wallet disconnected', 'info'); }}
                className="text-[11px] text-arc-faint hover:text-rose-300 transition-colors shrink-0">{tr('balance.disconnect','Disconnect')}</button>
            ) : (
              <Btn variant="ghost" size="sm" icon="link" onClick={handleConnectWallet}>{tr('balance.connect','Connect')}</Btn>
            )}
          </div>

          {gwBalance != null && parseFloat(gwBalance) > 0 && (
            <div className="flex items-baseline justify-between gap-3 py-3">
              <div>
                <div className="text-[13px] text-arc-text">{tr('af.gwBalance', 'Gateway unified balance')}</div>
                <div className="mt-0.5 text-[11px] text-arc-faint">{tr('af.gwNoteShort','across chains — bridge it to Arc')}</div>
              </div>
              <div className="font-mono text-[13px] text-arc-text tabular-nums" id="gateway-balance-display">{gwBalance} <span className="text-[10px] text-arc-faint">USDC</span></div>
            </div>
          )}

          <RecoveryWalletCard notify={notify} />
        </div>
      </section>

      {/* .C2: wallet action modal (moved from userdash.jsx) */}
      <WalletActionModal action={walletAction} usdc={usdc} onClose={() => setWalletAction(null)} onConfirm={(msg) => { setWalletAction(null); notify(msg, 'success'); }} notify={notify} />
    </div>
  );}

/**
 * manage the external EOAs that can recover this account without the
 * email. Add: server issues a link_wallet nonce → the CURRENTLY CONNECTED EOA
 * signs it (proof of control) → stored. Remove: instant.
 */
function RecoveryWalletCard({ notify }) {
  const [rows, setRows] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const load = () => {
    fetch((window.SLIME_API || '') + '/api/me/recovery-wallet', { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('load failed')))
      .then(d => setRows(d.wallets || []))
      .catch(() => {});
  };
  React.useEffect(load, []);

  const addWallet = async () => {
    if (!window.WalletBridge) { notify('Wallet bridge unavailable', 'error'); return; }
    setBusy(true);
    try {
      const addr = window.WalletBridge.isConnected()
        ? window.WalletBridge.getAddress()
        : await window.WalletBridge.connect();
      if (!addr) throw new Error('no wallet connected');
      const ch = await fetch((window.SLIME_API || '') + '/api/auth/recovery/challenge', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr, purpose: 'link_wallet' }),
      }).then(r => r.json());
      if (!ch || !ch.nonce || !ch.message) throw new Error((ch && ch.error) || 'challenge failed');
      const signature = await window.WalletBridge.signMessage(ch.message);
      const r = await fetch((window.SLIME_API || '') + '/api/me/recovery-wallet', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr, nonce: ch.nonce, signature }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'link failed');
      notify(tr('balance.recoveryLinked', 'Recovery wallet linked'), 'success');
      load();
    } catch (e) {
      notify(tr('balance.recoveryFailed', 'Recovery wallet failed') + ': ' + (e.message || e), 'error');
    } finally { setBusy(false); }
  };

  const removeWallet = async (address) => {
    setBusy(true);
    try {
      const r = await fetch((window.SLIME_API || '') + '/api/me/recovery-wallet', {
        method: 'DELETE', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'remove failed'); }
      notify(tr('balance.recoveryRemoved', 'Recovery wallet removed'), 'success');
      load();
    } catch (e) { notify(e.message || 'remove failed', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="py-3">
      <div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-arc-text flex items-center gap-1.5">{tr('balance.recoveryTitle','Recovery wallets')}</span>
          <Btn size="sm" variant="ghost" icon="plus" disabled={busy} onClick={addWallet}>{tr('balance.recoveryAdd','Add current wallet')}</Btn>
        </div>
        <p className="text-[11px] text-arc-faint mt-2 leading-relaxed">
          {tr('balance.recoveryHint','EOA wallets that can sign you back in if you lose email access. Data access only — Slime Wallet payments still need the email code.')}
        </p>
        {rows.length === 0 ? (
          <div className="text-xs text-arc-faint mt-4">{tr('balance.recoveryNone','No recovery wallets linked yet.')}</div>
        ) : (
          <div className="mt-4 space-y-2">
            {rows.map(w => (
              <div key={w.id} className="flex items-center justify-between rounded-xl ring-1 ring-arc-border bg-arc-surface/40 px-3.5 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm font-mono text-arc-text truncate">{w.address.slice(0, 10)}…{w.address.slice(-6)}</div>
                  {w.lastUsedAt && <div className="text-[10px] text-arc-faint">{tr('balance.recoveryLastUsed','last used')} {new Date(w.lastUsedAt).toLocaleDateString()}</div>}
                </div>
                <button type="button" disabled={busy} onClick={() => removeWallet(w.address)}
                  className="text-xs text-rose-400 hover:text-rose-300 transition disabled:opacity-40 shrink-0 ml-3">{tr('c.delete','Delete')}</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

Object.assign(window, { Balance, WalletActionModal });

// ---- Wallet Backup / Restore / Bridge modal ----
function WalletActionModal({ action, usdc, onClose, onConfirm, notify }) {
  const [amount, setAmount] = useState('');
  const [sendAddress, setSendAddress] = useState('');
  const [chain, setChain] = useState('Ethereum');
  const [loading, setLoading] = useState(false);
  // Live gas estimate from the chain. USDC is the native gas token on Arc, so
  // the fee is a slice of the user's own balance — show the real number, not a
  // hardcoded guess that was ~16x off.
  const [gasFee, setGasFee] = useState(null);
  // Amount that must stay in the wallet to pay the fee. The displayed estimate
  // is NOT enough: Circle wraps the transfer and bumps the max fee, and sending
  // "balance - estimate" failed on-chain with INSUFFICIENT_NATIVE_TOKEN after
  // the user had already approved it with their PIN.
  const [gasReserve, setGasReserve] = useState(null);
  useEffect(() => { setAmount(''); setSendAddress(''); setChain('Ethereum'); setLoading(false); }, [action]);
  useEffect(() => {
    if (action !== 'send') return;
    let alive = true;
    fetch((window.SLIME_API || '') + '/api/wallet/gas-estimate', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        if (!alive) return;
        setGasFee(d.estimatedFeeUsdc || null);
        setGasReserve(d.reserveUsdc || d.estimatedFeeUsdc || null);
      })
      .catch(() => { if (alive) { setGasFee('0.0006'); setGasReserve('0.003'); } });
    return () => { alive = false; };
  }, [action]);
  if (!action) return null;

  const cfg = {
    send: { icon: 'arrow-up-from-line', chip: 'bg-arc-primary/15 text-arc-accent', title: tr('ud.sendTitle','Send USDC'), sub: tr('ud.sendSub','Transfer USDC to another address') },
    backup: { icon: 'download', chip: 'bg-arc-primary/15 text-arc-accent', title: tr('ud.backupTitle','Backup Wallet'), sub: tr('ud.backupSub','MPC backup (Circle SDK)') },
    restore: { icon: 'upload', chip: 'bg-emerald-500/15 text-emerald-300', title: tr('ud.restoreTitle','Restore Wallet'), sub: tr('ud.restoreSub','MPC recovery (Circle SDK)') },
  }[action];

  const isDev = window.IS_LOCAL || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  const handleSend = async () => {
    if (!(parseFloat(amount) > 0)) { notify && notify(tr('ud.enterAmount','Enter a valid amount'), 'error'); return; }
    if (!sendAddress || sendAddress.length < 42) { notify && notify(tr('ud.invalidAddress','Enter a valid wallet address'), 'error'); return; }
    setLoading(true);
    try {
      const API = window.SLIME_API || '';
      const res = await fetch(API + '/api/wallet/withdraw', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destAddress: sendAddress, amountUsdc: String(amount) }) });
      const d = await res.json();
      if (res.ok) {
        if (d.mode === 'ucw-challenge' && d.challengeId) {
          if (typeof window.executeUcwChallenge !== 'function') {
            await fetch(API + '/api/wallet/withdraw/ucw-settle', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ walletTxId: d.walletTxId, cancelled: true }) }).catch(() => {});
            throw new Error('Wallet SDK not loaded — reload and try again');
          }
          setLoading(true);
          let exec;
          try { exec = await window.executeUcwChallenge(d.challengeId); }
          catch (chErr) {
            await fetch(API + '/api/wallet/withdraw/ucw-settle', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ walletTxId: d.walletTxId, cancelled: true }) }).catch(() => {});
            throw chErr;
          }
          if (!exec) {
            await fetch(API + '/api/wallet/withdraw/ucw-settle', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ walletTxId: d.walletTxId, cancelled: true }) }).catch(() => {});
            throw new Error('Wallet session expired — refresh and try again');
          }
          const st = await fetch(API + '/api/wallet/withdraw/ucw-settle', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ walletTxId: d.walletTxId, txHash: exec?.txHash ?? undefined }) });
          const sd = await st.json().catch(() => ({}));
          if (!st.ok) throw new Error(sd.error || 'Settlement failed');
          // The server now asks Circle for the real outcome. Never print "Sent"
          // for a transfer that is merely submitted — that is how a failed send
          // used to look successful while the row sat PENDING forever.
          if (sd.status === 'failed') throw new Error(sd.error || 'Transfer failed');
          const hash = (sd.arcTxHash || exec.txHash || '').slice(0, 18);
          if (sd.status === 'pending') {
            notify && notify(tr('ud.sendPending','Submitted — waiting for on-chain confirmation. This updates automatically.'), 'info');
          } else {
            notify && notify(tr('ud.sent','Sent') + ' ' + amount + ' USDC' + (hash ? ' · Tx: ' + hash + '…' : ''), 'success');
          }
          onConfirm(tr('ud.sent','Sent') + ' ' + amount + ' USDC to ' + sendAddress.slice(0, 6) + '...' + sendAddress.slice(-4));
          if (window.refreshWallet) await window.refreshWallet();
          setLoading(false);
          return;
        }
        const hash = d.arcTxHash ? d.arcTxHash.slice(0, 18) + '...' : '';
        notify && notify(tr('ud.sent','Sent') + ' ' + amount + ' USDC' + (hash ? ' · Tx: ' + hash : ''), 'success');
        onConfirm(tr('ud.sent','Sent') + ' ' + amount + ' USDC to ' + sendAddress.slice(0, 6) + '...' + sendAddress.slice(-4));
        if (window.refreshWallet) { await window.refreshWallet(); }
      } else if (d.code === 'PIN_SETUP_REQUIRED') {
        // 2026-09-27 — the copy used to say "set up your wallet PIN", but the
        // user has no PIN to set (Circle provisions it for email accounts). This
        // code means the wallet session/credentials need re-establishing.
        notify && notify(tr('ud.needPin','Wallet not ready yet — reload the page and try again.'), 'error');
      } else if (d.code === 'PIN_LOCKED') {
        notify && notify(tr('ud.pinLocked','Wallet action temporarily locked — try again later.'), 'error');
      } else { throw new Error(d.error || 'Transfer failed'); }
    } catch (e) {
      const errorMsg = e.message || 'Network error';
      notify && notify(`Send failed: ${errorMsg}`, 'error');
      if (errorMsg.includes('expired')) { setTimeout(() => window.redirectToRefreshSession?.(), 2000); }
    }
    setLoading(false);
  };

  const handleBackup = async () => {
    setLoading(true);
    try {
      if (isDev) { notify && notify(tr('ud.mpcDevBackup','MPC Wallet: In production, Circle SDK provides encrypted backup via device key. No seed phrase needed.'), 'info'); onConfirm(tr('ud.backupDone','Backup info shown')); }
      // HONESTY: there is no backup implementation yet. The old code
      // called onConfirm('Wallet backup completed') with nothing behind it,
      // which gave users false confidence about key recovery.
      else { notify && notify(tr('ud.backupUnavailable','Wallet backup is not available yet. Your MPC wallet needs no seed phrase — recovery is via your email code or a linked recovery wallet.'), 'info'); }
    } catch (e) { notify && notify('Backup failed', 'error'); }
    setLoading(false);
  };

  const handleRestore = async () => {
    setLoading(true);
    try {
      if (isDev) { notify && notify(tr('ud.mpcDevRestore','MPC Wallet: Restore via Circle SDK device authentication. No seed phrase needed.'), 'info'); onConfirm(tr('ud.restoreDone','Restore info shown')); }
      // HONESTY: same as backup — no implementation, so no success claim.
      else { notify && notify(tr('ud.restoreUnavailable','Wallet restore is not available yet. If you lost access to your email, use "Recover with a wallet" on the sign-in screen.'), 'info'); }
    } catch (e) { notify && notify('Restore failed', 'error'); }
    setLoading(false);
  };

  return (
    <Modal open={!!action} onClose={onClose} width="max-w-md">
      <Card className="overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-arc-border">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${cfg.chip}`}><Icon name={cfg.icon} size={18} /></div>
          <div>
            <div className="font-semibold text-arc-text">{cfg.title}</div>
            <div className="text-xs text-arc-muted">{cfg.sub}</div>
          </div>
          <button onClick={onClose} className="ml-auto w-8 h-8 rounded-lg hover:bg-arc-surface2 text-arc-muted flex items-center justify-center transition"><Icon name="x" size={16} /></button>
        </div>

        <div className="p-5 space-y-4">
          {action === 'send' && (
            <>
              <div className="flex items-start gap-2 rounded-xl ring-1 ring-arc-primary/25 bg-gradient-to-br from-arc-primary/5 to-arc-surface2/30 px-3.5 py-3 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glow">
                <Icon name="info" size={15} className="text-arc-accent mt-0.5 shrink-0" />
                <div className="text-xs text-arc-text"><strong>{tr('balance.sendUsdc','Send USDC')}</strong><br/>Transfer USDC to any wallet address on ARC Network. Transaction is processed by Circle MPC.</div>
              </div>
              <div>
                <label className="text-sm text-arc-text">{tr('ud.recipientAddress','Recipient Address')}</label>
                <input value={sendAddress} onChange={e => setSendAddress(e.target.value)} placeholder="0x..." className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 hover:ring-arc-borderlt rounded-xl px-3.5 h-12 text-sm text-arc-text placeholder-arc-faint outline-none font-mono transition-all duration-200" />
              </div>
              <div>
                <div className="flex items-baseline justify-between mb-1.5">
                  <label className="text-sm text-arc-text">{tr('ud.usdcAmount','USDC Amount')}</label>
                  <button
                    type="button"
                    onClick={() => {
                      // USDC IS the gas token on Arc, so sending the full balance
                      // leaves nothing to pay the fee and the transfer reverts.
                      // Reserve the PESSIMISTIC buffer from the server (not the
                      // display estimate) — see lib/wallet/gas.ts.
                      const reserve = Number(gasReserve ?? gasFee) || 0;
                      const max = Math.max(0, usdc - reserve);
                      setAmount(max > 0 ? max.toFixed(6) : '');
                    }}
                    className="text-[11px] font-semibold text-arc-accent hover:text-arc-text px-2 py-0.5 rounded ring-1 ring-arc-border hover:ring-arc-borderlt transition disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={!(usdc > 0)}
                    title="Send the maximum — your balance minus the estimated network fee"
                  >MAX</button>
                </div>
                <input value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0.00" className="mt-2 w-full bg-arc-bg/60 ring-1 ring-arc-border focus:ring-arc-primary/50 hover:ring-arc-borderlt rounded-xl px-3.5 h-12 text-base text-arc-text placeholder-arc-faint outline-none font-mono transition-all duration-200" />
              </div>
              <div className="rounded-xl bg-gradient-to-br from-arc-bg/50 to-arc-surface2/30 ring-1 ring-arc-border px-3.5 py-3 space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-arc-muted">{tr('ud.currentBalance','Current Balance')}</span><span className="font-mono tabular-nums text-arc-text">{usdc.toFixed(5)} <span className="text-emerald-400/70 ml-1 text-[0.7em]">USDC</span></span></div>
                <div className="flex justify-between"><span className="text-arc-muted">{tr('ud.networkFee','Network Fee')}</span><span className="font-mono tabular-nums text-arc-text">~${gasFee !== null ? gasFee : '…'}</span></div>
                {parseFloat(amount) > 0 && gasReserve !== null && (usdc - parseFloat(amount)) < Number(gasReserve) && (
                  <div className="text-[11px] text-amber-300 leading-snug">
                    {tr('ud.leaveForGas','Leave at least')} {gasReserve} USDC {tr('ud.forNetworkFee','in the wallet for the network fee, or the transfer will fail.')}
                  </div>
                )}
              </div>
              <Btn variant="primary" full icon="arrow-up-from-line" disabled={!(parseFloat(amount) > 0) || !sendAddress || (gasReserve !== null && usdc - parseFloat(amount) < Number(gasReserve))} onClick={handleSend} loading={loading} className="transition-all duration-200 hover:scale-[1.02] hover:shadow-glow">{tr('ud.sendUsdc','Send USDC')}</Btn>
            </>
          )}

          {action === 'backup' && (
            <>
              <div className="flex items-start gap-2 rounded-xl ring-1 ring-cyan-500/25 bg-cyan-500/5 px-3.5 py-3">
                <Icon name="info" size={15} className="text-cyan-400 mt-0.5 shrink-0" />
                <div className="text-xs text-arc-text"><strong>{tr('balance.mpcBackup','MPC Wallet Backup')}</strong><br/>Your wallet is secured by Circle's MPC (Multi-Party Computation) technology. Unlike traditional wallets, there is no seed phrase to back up. Your wallet is recovered via your device authentication and Circle's encrypted backup.</div>
              </div>
              <div className="rounded-xl ring-1 ring-arc-border bg-arc-surface/50 p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-arc-primary/15 flex items-center justify-center"><Icon name="shield-check" size={20} className="text-arc-accent" /></div>
                  <div><div className="text-sm font-medium text-arc-text">{tr('balance.mpcProtection','Circle MPC Protection')}</div><div className="text-xs text-arc-faint">{tr('balance.noSeed','No seed phrase required')}</div></div>
                </div>
                <div className="text-xs text-arc-muted space-y-1">
                  <p>• Your wallet key is split between your device and Circle's servers</p>
                  <p>• Backup is automatic when you verify your email</p>
                  <p>• Restore from any device using your email + OTP</p>
                </div>
              </div>
              <Btn variant="emerald" full icon="shield-check" onClick={handleBackup} loading={loading} className="transition-all duration-200 hover:scale-[1.02] hover:shadow-glow">{tr('ud.understand','I Understand')}</Btn>
            </>
          )}

          {action === 'restore' && (
            <>
              <div className="flex items-start gap-2 rounded-xl ring-1 ring-cyan-500/25 bg-cyan-500/5 px-3.5 py-3">
                <Icon name="info" size={15} className="text-cyan-400 mt-0.5 shrink-0" />
                <div className="text-xs text-arc-text"><strong>{tr('balance.mpcRestore','MPC Wallet Restore')}</strong><br/>Your wallet is restored automatically when you log in with the same email and complete device verification. No seed phrase needed.</div>
              </div>
              <div className="rounded-xl ring-1 ring-arc-border bg-arc-surface/50 p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center"><Icon name="refresh-cw" size={20} className="text-emerald-400" /></div>
                  <div><div className="text-sm font-medium text-arc-text">{tr('balance.autoRecovery','Auto Recovery')}</div><div className="text-xs text-arc-faint">Via email + device verification</div></div>
                </div>
                <div className="text-xs text-arc-muted space-y-1">
                  <p>• Log out and log back in with your registered email</p>
                  <p>• Complete email OTP verification</p>
                  <p>• Your wallet will be automatically restored</p>
                </div>
              </div>
              <Btn variant="emerald" full icon="log-in" onClick={handleRestore} loading={loading} className="transition-all duration-200 hover:scale-[1.02] hover:shadow-glow">{tr('ud.gotIt','Got It')}</Btn>
            </>
          )}

        </div>
      </Card>
    </Modal>
  );
}
