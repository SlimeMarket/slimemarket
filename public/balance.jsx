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
const BRIDGE_SOURCE_CHAINS = [
  { id: 'Base_Sepolia', label: 'Base Sepolia' },
  { id: 'Avalanche_Fuji', label: 'Avalanche Fuji', standardOnly: true },
  { id: 'Ethereum_Sepolia', label: 'Ethereum Sepolia' },
  { id: 'Arbitrum_Sepolia', label: 'Arbitrum Sepolia' },
  { id: 'Optimism_Sepolia', label: 'OP Sepolia' },
  { id: 'Polygon_Amoy_Testnet', label: 'Polygon Amoy', standardOnly: true },
];
const ADD_FUNDS_TABS = [
  { id: 'card', label: tr('af.tabCard', 'Buy with card/bank'), icon: 'credit-card' },
  { id: 'bridge', label: tr('af.tabBridge', 'Bridge'), icon: 'arrow-left-right' },
  { id: 'swap', label: tr('af.tabSwap', 'Swap'), icon: 'repeat' },
];

function AddFundsPanel({ notify, onFunded }) {
  const [tab, setTab] = useState('card');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [widgetMounted, setWidgetMounted] = useState(false);

  // bridge
  const [fromChain, setFromChain] = useState('Base_Sepolia');
  const [amount, setAmount] = useState('');
  // swap
  const [swapTokenIn, setSwapTokenIn] = useState('USDC');
  const [swapTokenOut, setSwapTokenOut] = useState('EURC');
  const [swapAmount, setSwapAmount] = useState('');

  const env = (window.AppKitHelper && window.AppKitHelper.environment()) || 'production';
  const isSandbox = env === 'sandbox';
  const destAddress = ME.wallet || null;
  // App Kit's bridge is EIP-1193 only. Without a provider the only way a user
  // can move USDC from another chain is the PIN-signed CCTP path below.
  const hasExternalWallet = typeof window !== 'undefined' && !!window.ethereum;

  const openWidget = async () => {
    setErr('');
    if (!window.AppKitHelper) { setErr('App Kit helper not loaded — reload the page.'); return; }
    setBusy(true);
    try {
      // Render the container first; AppKitHelper waits for it to exist and have
      // a non-zero height before mounting (the iframe fills its container).
      setWidgetMounted(true);
      const res = await window.AppKitHelper.mountOnramp({
        containerId: 'onramp-root',
        onReady: () => setBusy(false),
        onSettled: () => {
          notify && notify(tr('af.settled', 'USDC received — it arrives in your wallet on Arc.'), 'success');
          onFunded && onFunded();
        },
        onNotCompleted: (code) => {
          notify && notify(tr('af.notCompleted', 'Purchase not completed') + (code ? ' (' + code + ')' : ''), 'info');
        },
      });
      if (res && res.ok === false) { setErr(res.message || 'Could not start the onramp'); setWidgetMounted(false); }
    } catch (e) {
      setErr(e.message || 'Could not start the onramp');
      setWidgetMounted(false);
    }
    setBusy(false);
  };

  const closeWidget = () => {
    window.AppKitHelper?.closeOnramp?.();
    setWidgetMounted(false);
  };

  const doBridge = async () => {
    setErr('');
    if (!destAddress) { setErr('Your wallet address is not available yet.'); return; }
    const amt = parseFloat(amount);
    if (!(amt > 0)) { setErr(tr('af.enterAmount', 'Enter an amount')); return; }
    if (!window.AppKitHelper) { setErr('App Kit helper not loaded — reload the page.'); return; }
    setBusy(true);
    try {
      const res = await window.AppKitHelper.bridge({
        fromChain,
        toChain: 'Arc_Testnet',
        recipientAddress: destAddress,
        amount: amount,
        // Undefined everywhere else, so the SDK keeps its FAST default.
        transferSpeed: (BRIDGE_SOURCE_CHAINS.find(c => c.id === fromChain) || {}).standardOnly ? 'SLOW' : undefined,
      });
      if (res && res.ok) {
        notify && notify(tr('af.bridgeStarted', 'Bridge submitted — USDC will arrive on Arc shortly.'), 'success');
        onFunded && onFunded();
      } else {
        setErr((res && res.message) || 'Bridge failed');
      }
    } catch (e) { setErr(e.message || 'Bridge failed'); }
    setBusy(false);
  };

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
  const tabCls = (id) => `flex-1 flex items-center justify-center gap-1.5 text-xs font-medium rounded-lg py-2 transition-all duration-200 ${tab === id ? 'bg-emerald-600 text-white shadow-glow' : 'text-arc-muted hover:text-arc-text'}`;

  return (
    <Card className="p-5 mb-5 ring-1 ring-emerald-500/25 bg-gradient-to-br from-emerald-500/10 to-arc-surface2/30">
      <div className="flex items-center justify-between mb-4">
        <div className="text-xs uppercase tracking-wide text-arc-faint flex items-center gap-1.5">
          <Icon name="plus-circle" size={13} className="text-emerald-400" /> {tr('af.title', 'Add funds')}
        </div>
        {isSandbox && <PixBadge color="amber">{tr('balance.sandbox','SANDBOX')}</PixBadge>}
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
        <div className="space-y-3">
          <div className="text-xs text-arc-muted leading-relaxed">
            {tr('af.cardDesc', 'Buy USDC with a debit card, Apple/Google Pay or bank transfer. Circle handles KYC and payment, and delivers the USDC straight to your wallet on Arc — no bridging.')}
          </div>
          <div className="text-[11px] text-arc-faint">
            {tr('af.cardDest', 'Receiving to')}: <span className="font-mono">{destAddress ? destAddress.slice(0, 10) + '…' + destAddress.slice(-6) : '—'}</span>
          </div>
          {!widgetMounted ? (
            <Btn variant="emerald" size="lg" full icon="credit-card" disabled={busy || !destAddress} onClick={openWidget}>
              {busy ? tr('af.starting', 'Starting…') : tr('af.start', 'Start purchase')}
            </Btn>
          ) : (
            <>
              <div id="onramp-root" style={{ width: '100%', height: '720px' }} className="rounded-xl overflow-hidden ring-1 ring-arc-border bg-arc-surface/40"></div>
              <button onClick={closeWidget} className="text-[11px] text-arc-faint hover:text-arc-text transition">
                {tr('af.closeWidget', 'Close')}
              </button>
            </>
          )}
        </div>
      )}

      {tab === 'bridge' && (
        // Two genuinely different rails live behind this tab:
        //   • external wallet (MetaMask) → App Kit signs through EIP-1193
        //   • Slime Wallet (email login) → no EIP-1193 provider exists, so the
        //     burn is signed with the user's PIN via a Circle challenge instead
        // Showing the MetaMask form to an email-login user is a dead end, which
        // is exactly what it used to do.
        hasExternalWallet
          ? (
            <div className="space-y-3">
              <div className="text-xs text-arc-muted leading-relaxed">
                {tr('af.bridgeDesc', 'Move USDC you already hold on another chain to Arc. You sign from your connected external wallet; the USDC lands in your Slime Wallet here.')}
              </div>
              <div>
                <label className="text-xs text-arc-muted">{tr('af.fromChain', 'From chain')}</label>
                <select value={fromChain} onChange={e => setFromChain(e.target.value)} className={inputCls}>
                  {BRIDGE_SOURCE_CHAINS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-arc-muted">{tr('af.amountUsdc', 'Amount (USDC)')}</label>
                <input value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="10.00" className={inputCls} />
              </div>
              <Btn variant="emerald" size="lg" full icon="arrow-left-right" disabled={busy || !destAddress} onClick={doBridge}>
                {busy ? tr('af.working', 'Working…') : tr('af.bridgeCta', 'Bridge to Arc')}
              </Btn>
              <div className="text-[10px] text-arc-faint">
                {tr('af.bridgeNote', 'Requires USDC on the source chain and a connected external wallet (MetaMask).')}
              </div>
            </div>
          )
          : <UcwBridgePanel notify={notify} onFunded={onFunded} inputCls={inputCls} />
      )}

      {tab === 'swap' && (
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
      )}
    </Card>
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
function UcwBridgePanel({ notify, onFunded, inputCls }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [chainKey, setChainKey] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState('');
  // Bridge id currently being retried, so only that row's button spins.
  const [retrying, setRetrying] = useState('');

  const API = window.SLIME_API || '';

  const load = async () => {
    try {
      const r = await fetch(API + '/api/wallet/cross-chain', { credentials: 'same-origin' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(d.error || tr('af.ccLoadFail', 'Could not load cross-chain status')); setLoading(false); return; }
      setData(d);
      setErr('');
      if (d.chains && d.chains.length) {
        // Default to a chain the user already has a wallet on — but only when
        // nothing is selected yet. Using the functional form keeps the user's
        // choice across the reload that follows every bridge.
        const ready = d.chains.find(c => c.address && c.live) || d.chains[0];
        setChainKey(prev => prev || ready.key);
      }
    } catch (e) {
      setErr(e.message || tr('af.ccLoadFail', 'Could not load cross-chain status'));
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const copy = async (text, tag) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(''), 1500);
    } catch { /* clipboard blocked — the address is still selectable */ }
  };

  const provision = async () => {
    setErr(''); setBusy(true);
    try {
      const res = await window.executeUcwChallenge(data.provisionChallenge.challengeId);
      if (!res) { setErr(tr('af.ccSession', 'Your session expired — sign in again.')); setBusy(false); return; }
      notify && notify(tr('af.ccWalletsCreated', 'Wallets created.'), 'success');
      await load();
    } catch (e) { setErr(e.message || tr('af.ccWalletFail', 'Could not create the wallet')); }
    setBusy(false);
  };

  const post = async (body) => {
    const r = await fetch(API + '/api/wallet/cross-chain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || tr('af.ccFail', 'Bridge failed'));
    return d;
  };

  const doBridge = async () => {
    setErr(''); setStatus('');
    const amt = parseFloat(amount);
    if (!(amt > 0)) { setErr(tr('af.enterAmount', 'Enter an amount')); return; }
    if (!window.executeUcwChallenge) { setErr(tr('af.ccSdkMissing', 'Wallet SDK not loaded — reload the page.')); return; }
    setBusy(true);
    try {
      setStatus(tr('af.ccPreparing', 'Preparing…'));
      const prep = await post({ action: 'prepare', sourceChain: chainKey, amountUsdc: amount });

      // At most two signature steps (approve, then burn). The loop is bounded so
      // a server bug cannot turn this into an endless PIN prompt.
      let step = prep.step, challengeId = prep.challengeId, guard = 0;
      while (step && challengeId && guard < 3) {
        guard++;
        setStatus(step === 'approve'
          ? tr('af.ccApprove', 'Approve USDC in your wallet…')
          : tr('af.ccBurn', 'Confirm the bridge in your wallet…'));
        const signed = await window.executeUcwChallenge(challengeId);
        if (!signed || !signed.txHash) throw new Error(tr('af.ccNoSig', 'Signature was not completed'));
        const conf = await post({ action: 'confirm', bridgeId: prep.bridgeId, step, txHash: signed.txHash });
        step = conf.step; challengeId = conf.challengeId;
      }

      setStatus(tr('af.ccWaiting', 'Burned. Circle is attesting the transfer — this usually takes about 15 minutes, and the USDC is minted to your Arc wallet automatically.'));
      notify && notify(tr('af.ccStarted', 'Bridge submitted — USDC will arrive on Arc shortly.'), 'success');
      setAmount('');
      await load();
      onFunded && onFunded();
    } catch (e) {
      setErr(e.message || tr('af.ccFail', 'Bridge failed'));
      setStatus('');
    }
    setBusy(false);
  };

  // Re-attempt the Arc mint for a bridge that already burned. Safe to expose:
  // the amount and recipient are fixed inside Circle's signed attestation, so
  // this can only ever deliver the user's own funds to their own address.
  const retry = async (bridgeId) => {
    setErr(''); setStatus(''); setRetrying(bridgeId);
    try {
      const r = await fetch(API + '/api/wallet/cross-chain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'retry', bridgeId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || tr('af.ccFail', 'Bridge failed'));
      setStatus(d.message || '');
      if (d.outcome === 'MINTED') notify && notify(d.message, 'success');
      await load();
    } catch (e) {
      setErr(e.message || tr('af.ccFail', 'Bridge failed'));
    }
    setRetrying('');
  };

  if (loading) {
    return <div className="text-xs text-arc-muted">{tr('af.ccLoading', 'Loading…')}</div>;
  }

  if (data && data.enabled === false) {
    return (
      <div className="text-xs text-arc-muted leading-relaxed">
        {tr('af.ccDisabled', 'Bridging from your Slime Wallet is not enabled on this deployment. Send USDC to your Arc address instead — you can receive it from any exchange that supports Arc.')}
      </div>
    );
  }

  const chain = (data && data.chains || []).find(c => c.key === chainKey) || null;
  const needsProvision = !!(data && data.provisionChallenge);

  return (
    <div className="space-y-3">
      <div className="text-xs text-arc-muted leading-relaxed">
        {tr('af.ccDesc', 'Move USDC you hold on another chain to Arc. You confirm each step with your wallet PIN — the USDC is minted straight to your Slime Wallet on Arc.')}
      </div>

      {err && (
        <div className="text-xs text-rose-300 bg-rose-500/10 ring-1 ring-rose-500/30 rounded-lg px-3 py-2">{err}</div>
      )}

      {needsProvision ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 text-xs text-amber-300/90 bg-amber-500/10 ring-1 ring-amber-500/25 rounded-lg px-3 py-2">
            <Icon name="alert-triangle" size={13} className="mt-0.5 shrink-0" />
            <span>
              {tr('af.ccNeedWallets', 'You need a wallet on the source chains first. One confirmation creates:')}{' '}
              <span className="font-mono">{data.provisionChallenge.chains.join(', ')}</span>
            </span>
          </div>
          <Btn variant="emerald" size="lg" full icon="wallet" disabled={busy} onClick={provision}>
            {busy ? tr('af.working', 'Working…') : tr('af.ccCreateWallets', 'Create my wallets')}
          </Btn>
        </div>
      ) : (
        <>
          <div>
            <label className="text-xs text-arc-muted">{tr('af.fromChain', 'From chain')}</label>
            <select value={chainKey} onChange={e => { setChainKey(e.target.value); setErr(''); }} className={inputCls}>
              {(data && data.chains || []).map(c => (
                <option key={c.key} value={c.key}>
                  {c.label}{c.address && c.live ? '' : ' — ' + tr('af.ccNoWalletYet', 'no wallet yet')}
                </option>
              ))}
            </select>
          </div>

          {chain && chain.address && (
            <div className="rounded-lg bg-arc-surface/60 ring-1 ring-arc-border px-3 py-2">
              <div className="text-[10px] uppercase tracking-wide text-arc-faint">
                {/* tr() has no interpolation (see i18n.jsx) — the chain name is
                    appended rather than templated so translations stay clean. */}
                {tr('af.ccSendTo', 'Send USDC on this chain to your address')} · {chain.label}
              </div>
              <button
                type="button"
                onClick={() => copy(chain.address, 'addr')}
                className="mt-1 w-full text-left font-mono text-[11px] text-arc-text break-all hover:text-emerald-300 transition"
                title={tr('af.ccCopy', 'Tap to copy')}
              >
                {chain.address}
              </button>
              <div className="mt-1 text-[10px] text-arc-faint">
                {copied === 'addr' ? tr('af.ccCopied', 'Copied') : tr('af.ccCopyHint', 'This is your own wallet — the USDC stays yours.')}
              </div>
            </div>
          )}

          {chain && chain.address && (
            <div className="flex items-start gap-2 text-[11px] text-amber-300/90 bg-amber-500/10 ring-1 ring-amber-500/25 rounded-lg px-3 py-2">
              <Icon name="fuel" size={13} className="mt-0.5 shrink-0" />
              <span>
                {tr('af.ccGasNote', 'This wallet also needs a little of the chain\u2019s native token for network fees. Send a small amount to the same address, or the bridge cannot be signed.')}
                {' '}<span className="font-mono">{chain.nativeSymbol}</span>
              </span>
            </div>
          )}

          <div>
            <label className="text-xs text-arc-muted">{tr('af.amountUsdc', 'Amount (USDC)')}</label>
            <input value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="10.00" className={inputCls} />
          </div>

          <Btn variant="emerald" size="lg" full icon="arrow-left-right"
            disabled={busy || !chain || !chain.address || !chain.live} onClick={doBridge}>
            {busy ? tr('af.working', 'Working…') : tr('af.bridgeCta', 'Bridge to Arc')}
          </Btn>

          {status && (
            <div className="text-[11px] text-emerald-300/90 bg-emerald-500/10 ring-1 ring-emerald-500/25 rounded-lg px-3 py-2">
              {status}
            </div>
          )}

          <div className="text-[10px] text-arc-faint leading-relaxed">
            {tr('af.ccNote', 'Two confirmations: approve, then bridge. Standard transfers take about 15 minutes to attest before the USDC appears on Arc.')}
          </div>
        </>
      )}

      {data && data.bridges && data.bridges.length > 0 && (
        <div className="pt-2 border-t border-arc-border/60 space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-arc-faint">{tr('af.ccRecent', 'Recent bridges')}</div>
          {data.bridges.slice(0, 5).map(b => (
            <div key={b.id} className="flex items-center justify-between gap-2 text-[11px]">
              <span className="text-arc-muted truncate">
                {b.sourceChainLabel} · {(Number(b.amountMicro) / 1e6).toFixed(2)} USDC
              </span>
              <span className="flex items-center gap-2 shrink-0">
                <span className={b.status === 'MINTED' ? 'text-emerald-300' : b.status === 'FAILED' ? 'text-rose-300' : 'text-amber-300'}>
                  {tr('af.ccStatus.' + b.status, b.status)}
                </span>
                {/* Anything that burned but has not landed yet needs a way out:
                    the cron runs every 5 minutes, but the user is sitting here
                    watching USDC that has already left their source wallet. */}
                {b.status !== 'MINTED' && b.burnTxHash && (
                  <button
                    type="button"
                    onClick={() => retry(b.id)}
                    disabled={!!retrying}
                    className="text-arc-accent underline underline-offset-2 hover:brightness-125 disabled:opacity-50"
                  >
                    {retrying === b.id ? tr('af.ccChecking', 'Checking…') : tr('af.ccRetry', 'Check')}
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


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

  return (
    <div className="anim-view">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-2">
        <h1 className="text-xl font-bold text-white">{tr('balance.pageTitle','Balance & Transactions')}</h1>
        {!custodialHidden && (
        <button className="text-sm text-arc-accent hover:brightness-125 inline-flex items-center gap-1.5 transition"><Icon name="credit-card" size={15} /> {tr('balance.manageAccounts','Manage Accounts')}</button>
        )}
      </div>

      {/* total balance — premium larger card with gradient + glow */}
      <div className="relative overflow-hidden rounded-3xl ring-1 ring-arc-primary/30 bg-gradient-to-br from-arc-primary/10 to-arc-surface arc-mesh p-8 mb-6 shadow-glow-emerald transition-all duration-300 hover:ring-arc-primary/50 hover:-translate-y-0.5 hover:shadow-glow">
        <div className="absolute -right-6 -bottom-6 opacity-20"><SlimeLogo size={180} /></div>
        <div className="relative flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-arc-muted flex items-center gap-1.5"><Icon name="wallet" size={13} /> {tr('balance.totalBalance','Total Balance')}</div>
            <div className="mt-2"><Usdc value={usdc} className="text-5xl font-extrabold text-white" size="text-lg" /></div>
            {custodialHidden && (
              <div className="mt-3">
                <div className="text-xs text-arc-muted">{tr('balance.ownWalletNote','your own wallet — funds arrive on-chain automatically')}</div>
                {ME.wallet ? (
                  <div className="mt-2 flex items-center gap-2.5 flex-wrap">
                    <CopyChip value={ME.wallet} displayValue={ME.wallet.slice(0, 10) + '…' + ME.wallet.slice(-6)} />
                    <span className="text-[11px] text-arc-faint inline-flex items-center gap-1"><Icon name="arrow-down-left" size={12} className="text-arc-accent" /> {tr('balance.receiveShare','Receive: share this address')}</span>
                  </div>
                ) : null}
              </div>
            )}
          </div>
          <div className="w-20 h-20 rounded-3xl bg-arc-surface2 ring-1 ring-arc-border flex items-center justify-center transition-transform duration-300 hover:scale-110 hover:shadow-glow">
            <Icon name="wallet" size={32} className="text-arc-accent animate-bounce" />
          </div>
        </div>
      </div>

      {/* Add funds — fiat onramp / bridge / swap via Circle Arc App Kit.
          Replaces the hand-rolled Gateway deposit+withdraw card: App Kit owns
          those flows now (Gateway is an implementation detail under it), so
          keeping a second half-built path here would just be two ways to get it
          wrong. The Gateway unified balance stays visible when non-zero. */}
      <div id="add-funds" className="scroll-mt-4">
        <AddFundsPanel notify={notify} onFunded={() => window.refreshWallet?.()} />
      </div>

      {gwBalance != null && parseFloat(gwBalance) > 0 && (
        <Card className="p-4 mb-5 ring-1 ring-violet-500/30 bg-gradient-to-br from-violet-500/10 to-arc-surface2/30">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs uppercase tracking-wide text-arc-faint flex items-center gap-1.5">
                <Icon name="layers" size={13} className="text-violet-400" /> {tr('af.gwBalance', 'Gateway unified balance')}
              </div>
              <div className="mt-1.5 text-xl font-bold text-violet-300 font-mono" id="gateway-balance-display">{gwBalance} USDC</div>
              <div className="text-[11px] text-arc-faint mt-1">{tr('af.gwNote', 'Held in Circle Gateway across chains — withdraw from the Circle console or bridge it to Arc.')}</div>
            </div>
          </div>
        </Card>
      )}

      {/* MPC Wallet — .C2 (moved from /profile). always shown —
          this IS the non-custodial internal wallet: address = where on-chain
          releases arrive; Send = UCW TRANSFER challenge (user's own PIN,
          ). Only the fiat "Top Up" shortcut is hidden while its
          target section (custodial fiat flow) is hidden. */}
      <div className="relative overflow-hidden rounded-2xl ring-1 ring-arc-primary/25 bg-gradient-to-br from-arc-primary/20 via-arc-surface to-arc-surface2/50 p-5 mb-5 transition-all duration-300 hover:shadow-glow hover:-translate-y-0.5">
        <div className="relative">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wide text-arc-accent flex items-center gap-1.5"><Icon name="shield" size={13} /> {tr('ud.mpcWallet','Circle MPC Wallet')}</span>
            <PixBadge color="blue">{tr('balance.nonCustodial','NON-CUSTODIAL')}</PixBadge>
          </div>
          <div className="mt-4">
            <div className="text-[11px] text-arc-faint mb-1.5">{tr('ud.walletAddress','Wallet Address')}</div>
            <CopyChip value={ME.wallet || 'Not available'} displayValue={ME.wallet ? ME.wallet.slice(0, 10) + '…' + ME.wallet.slice(-6) : 'Not available'} />
          </div>
          <div className="h-px bg-arc-border my-4"></div>
          <div className="text-[11px] text-arc-faint">{tr('ud.usdcBalance','USDC Balance')}</div>
          <div className="mt-1"><Usdc value={usdc} className="text-3xl font-bold text-emerald-300" /></div>
          <div className="flex gap-2 mt-4">
            {!custodialHidden && (
              <Btn variant="emerald" size="sm" full icon="plus" className="transition-all duration-200 hover:scale-[1.02] hover:shadow-glow" onClick={() => document.getElementById('add-funds')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{tr('ud.topup','Top Up')}</Btn>
            )}
            <Btn variant="outline" size="sm" full icon="arrow-up-from-line" className="transition-all duration-200 hover:-translate-y-0.5 hover:shadow-glow" onClick={() => setWalletAction('send')}>{tr('c.send','Send')}</Btn>
          </div>
        </div>
      </div>

      {/* Legacy platform-custodial flows (fiat top-up + bank/legacy crypto
          withdraw): hidden while ONCHAIN_FUNDS. */}
      {!custodialHidden && (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Withdraw (crypto + legacy bank tabs) */}
        <Card className="overflow-hidden bg-gradient-to-br from-arc-surface to-arc-surface2/50 transition-all duration-300 hover:shadow-glow hover:-translate-y-0.5">
          <div className="flex items-center gap-2 px-5 py-3.5 border-b border-arc-border bg-amber-500/5">
            <Icon name="minus" size={16} className="text-amber-400" />
            <span className="text-sm font-semibold text-amber-300">{tr('balance.withdrawTitle','Withdraw Balance')}</span>
          </div>
          <div className="p-5">
            <div className="flex bg-arc-surface/60 ring-1 ring-arc-border rounded-xl p-1 mb-4">
              {WITHDRAW_TABS.map(t => (
                <button key={t.id} onClick={() => setWithdrawTab(t.id)} className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-medium rounded-lg py-2 transition-all duration-200 ${withdrawTab === t.id ? 'bg-amber-600 text-white shadow-glow hover:brightness-110' : 'text-arc-muted hover:text-arc-text hover:-translate-y-0.5'}`}>
                  <Icon name={t.icon} size={13} /> {t.label}
                </button>
              ))}
            </div>

            {withdrawTab === 'crypto' ? (
              <div className="space-y-4">
                <div className="rounded-xl ring-1 ring-arc-primary/20 bg-arc-primary/5 p-3 text-[11px] text-arc-muted leading-relaxed">
                  <Icon name="info" size={12} className="text-arc-accent inline mr-1" />
                  {tr('balance.cryptoNote','Withdraw on-chain to an Arc address (native USDC). 1 confirmation = final. Destination is checked against the blocklist.')}
                </div>
                <div>
                  <label className="text-sm text-arc-muted">{tr('balance.arcAddress','Arc Address (0x…)')}</label>
                  <input value={cryptoAddr} onChange={e => setCryptoAddr(e.target.value)} placeholder="0x7A3f9C4e2B81dA56e0F1b9C7Ae44D2c8b6E91f0a" className="mt-2 w-full bg-arc-surface/60 ring-1 ring-arc-border focus:ring-amber-500/50 hover:ring-arc-borderlt rounded-xl px-3.5 h-12 text-sm text-arc-text placeholder-arc-faint outline-none font-mono transition" />
                </div>
                <div>
                  <label className="text-sm text-arc-muted">{tr('balance.amountUSDC','USDC Amount')}</label>
                  <input value={cryptoAmt} onChange={e => setCryptoAmt(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="10.00" className="mt-2 w-full bg-arc-surface/60 ring-1 ring-arc-border focus:ring-amber-500/50 hover:ring-arc-borderlt rounded-xl px-3.5 h-12 text-base text-arc-text placeholder-arc-faint outline-none font-mono transition" />
                </div>
                {/* No fee breakdown: withdrawing your own USDC costs no platform
                    fee. (this used to show a fabricated 2% fee and a
                    1.02× "Total Debit" that no backend code ever charged.) */}
                <Btn variant="outline" size="lg" full icon="arrow-up-from-line" disabled={!cryptoValid} className="transition-all duration-200 hover:scale-[1.02] hover:shadow-glow" onClick={() => onWithdrawCrypto(cryptoAddr, cryptoAmt)}>
                  {tr('balance.withdrawToArc','Withdraw to Arc Address')}
                </Btn>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="text-[11px] text-arc-faint">{tr('balance.bankLegacyNote','Bank withdrawal (legacy) — use the Crypto tab for faster on-chain withdrawals.')}</div>
                {banks.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 py-6 text-center saldo-fade-in">
                    <div className="w-16 h-16 rounded-2xl bg-arc-surface2/60 ring-1 ring-arc-border flex items-center justify-center transition-transform duration-300 hover:scale-110"><Icon name="credit-card" size={28} className="text-arc-faint" /></div>
                    <div className="text-sm text-arc-muted">{tr('balance.noBank','No bank account yet')}</div>
                    <Btn variant="primary" icon="plus" onClick={onAddBank}>{tr('balance.addAccount','Add Account')}</Btn>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {banks.map((b, i) => (
                      <div key={i} className="flex items-center gap-3 bg-arc-surface/60 ring-1 ring-arc-border rounded-xl px-3.5 py-3 transition-all duration-200 hover:-translate-y-0.5 hover:ring-arc-borderlt">
                        <Icon name="building-2" size={18} className="text-arc-accent" />
                        <div className="flex-1">
                          <div className="text-sm text-arc-text font-medium">{b.bank}</div>
                          <div className="text-[11px] text-arc-faint font-mono">{b.number} · {b.name}</div>
                        </div>
                        <Icon name="check-circle" size={16} className="text-emerald-400" />
                      </div>
                    ))}
                    <Btn variant="outline" size="lg" full icon="arrow-up-from-line" onClick={onWithdraw}>{tr('balance.withdrawToBank','Withdraw to Bank')}</Btn>
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>
      )}

      {/* history — table matching seller center pattern with skeleton rows */}
      <Card className="mt-5 overflow-hidden bg-gradient-to-br from-arc-surface to-arc-surface2/50 transition-all duration-300 hover:shadow-glow">
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-arc-border">
          <Icon name="history" size={16} className="text-arc-accent" />
          <span className="text-sm font-semibold text-arc-text">{tr('balance.history','Transaction History')}</span>
          <span className="ml-auto text-xs text-arc-faint">{histList.length} {histList.length === 1 ? 'transaction' : 'transactions'}</span>
        </div>
        <div className="divide-y divide-arc-border/60">
          {histList.length === 0 ? (
            <div className="py-16 flex flex-col items-center gap-4 text-center saldo-fade-in">
              <div className="w-20 h-20 rounded-2xl bg-arc-surface2/60 ring-1 ring-arc-border flex items-center justify-center transition-transform duration-300 hover:scale-110">
                <Icon name="inbox" size={32} className="text-arc-faint" />
              </div>
              <div>
                <div className="text-base font-semibold text-arc-text">{tr('wallet.noTxs','No transactions yet.')}</div>
                <div className="text-xs text-arc-faint mt-1">{tr('balance.txEmpty','Recent Transactions will appear here')}</div>
              </div>
            </div>
          ) : histList.map(t => {
            const isIn = t.type === 'in';
            const statusUpper = (t.status || '').toString().toUpperCase();
            const badgeColor = statusUpper === 'DONE' ? 'emerald'
              : statusUpper === 'PENDING' ? 'amber'
              : statusUpper === 'FAILED' ? 'rose'
              : statusUpper === 'ESCROWED' ? 'cyan'
              : null;
            return (
              <div key={t.id} className="flex items-center gap-3 px-5 py-3.5 hover:bg-arc-surface2/40 transition-all duration-200 hover-lift-row">
                <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${isIn ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400'} transition-transform duration-200 hover:-translate-y-0.5`}>
                  <Icon name={isIn ? 'arrow-down-left' : 'arrow-up-right'} size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-arc-text font-medium leading-tight">{t.label}</div>
                  <div className="text-[11px] text-arc-faint flex items-center gap-1.5 flex-wrap">
                    {t.sub} · <span>{t.time}</span>
                    {t.source === 'circle' && <PixBadge color="blue" className="!text-[7px]">{tr('balance.circle','CIRCLE')}</PixBadge>}
                    {t.txHash && (
                      <a href={String(window.ARC_EXPLORER_URL || 'https://arc.etherscan.io').replace(/\/+$/, '') + '/tx/' + t.txHash} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-[10px] font-mono text-arc-accent hover:brightness-125 transition-all duration-200 hover:-translate-y-0.5">
                        <Icon name="external-link" size={10} /> {t.txHash.slice(0, 6)}…{t.txHash.slice(-4)}
                      </a>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className={`font-mono text-sm tabular-nums ${isIn ? 'text-emerald-400' : 'text-rose-400'} transition-colors duration-200 hover:-translate-y-0.5`}>{isIn ? '+' : '−'}{t.amount.toFixed(2)}</div>
                  <div className="mt-0.5">{badgeColor ? <PixBadge color={badgeColor}>{statusUpper}</PixBadge> : <span className="text-[10px] text-arc-faint">{t.status}</span>}</div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* External Wallet Section */}
      <Card className="mt-5 overflow-hidden bg-gradient-to-br from-arc-surface to-arc-surface2/50 transition-all duration-300 hover:shadow-glow hover:-translate-y-0.5">
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-arc-border bg-violet-500/5">
          <Icon name="link" size={16} className="text-violet-400" />
          <span className="text-sm font-semibold text-violet-300">{tr('balance.extWallets','External Wallets')}</span>
        </div>
        <div className="p-5">
          <div className="text-xs text-arc-faint mb-3">Connect MetaMask, Coinbase Wallet, or other browser wallets to deposit cross-chain USDC</div>
          <div id="connected-wallets-list" className="space-y-2 mb-3">
            {extWallet ? (
              <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/10 rounded-lg ring-1 ring-emerald-500/30 transition-all duration-200 hover:-translate-y-0.5">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs font-mono text-emerald-300">{extWallet.slice(0, 6)}...{extWallet.slice(-4)}</span>
                <button onClick={() => { window.WalletBridge?.disconnect?.(); setExtWallet(null); notify('Wallet disconnected', 'info'); }} className="ml-auto text-[10px] text-red-400 hover:text-red-300 transition-all duration-200 hover:-translate-y-0.5">{tr('balance.disconnect','Disconnect')}</button>
              </div>
            ) : (
              <div className="text-xs text-arc-faint italic">{tr('balance.noWallets','No wallets connected')}</div>
            )}
          </div>
          <Btn variant="primary" icon="link" onClick={extWallet ? undefined : handleConnectWallet} className={`transition-all duration-200 ${extWallet ? 'opacity-50 pointer-events-none' : 'hover:scale-[1.02] hover:shadow-glow'}`}>
            {extWallet ? 'Wallet Connected' : 'Connect Wallet'}
          </Btn>
        </div>
      </Card>

      {/* Opsi A (2026-09-27) — "PIN & Security" card REMOVED.
          Circle auto-provisions the PIN + security questions for authMode EMAIL
          accounts, and email OTP is our only sign-in, so every account is EMAIL
          and no user ever chose a PIN. "Change PIN" / "Forgot PIN? Recover" could
          therefore never succeed. fetchPinStatus/runPinAction/setupPin are kept
          below for a future PIN-based auth mode. */}

      {/* EOA recovery wallets (email-independence safety net) */}
      <RecoveryWalletCard notify={notify} />

      {/* .C2: wallet action modal (moved from userdash.jsx) */}
      <WalletActionModal action={walletAction} usdc={usdc} onClose={() => setWalletAction(null)} onConfirm={(msg) => { setWalletAction(null); notify(msg, 'success'); }} notify={notify} />
    </div>
  );
}

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
    <Card>
      <div className="p-5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-wide text-arc-accent flex items-center gap-1.5"><Icon name="key-round" size={13} /> {tr('balance.recoveryTitle','Recovery Wallets')}</span>
          <Btn size="sm" variant="outline" icon="plus" disabled={busy} onClick={addWallet}>{tr('balance.recoveryAdd','Add current wallet')}</Btn>
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
    </Card>
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
