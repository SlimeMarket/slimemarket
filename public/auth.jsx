// ============ SlimeMarket — Auth: Email OTP + Circle UCW (Arc navy) ============

const NOTIFS = [];
const NOTIF_TONE = {
  cyan: 'bg-cyan-500/15 text-cyan-300', emerald: 'bg-emerald-500/15 text-emerald-300',
  rose: 'bg-rose-500/15 text-rose-300', violet: 'bg-arc-primary/15 text-arc-accent',
  blue: 'bg-arc-primary/15 text-arc-accent',
  amber: 'bg-amber-500/15 text-amber-300', slate: 'bg-arc-surface2 text-arc-muted',
};

function NotifBell({ notifs, onReadAll, onClear, onGo }) {
  const [open, setOpen] = useState(false);
  const unread = notifs.filter(n => !n.read).length;
  return (
    <div className="relative">
      <button onClick={() => { setOpen(o => !o); }} className="relative w-10 h-10 rounded-xl bg-arc-surface/60 ring-1 ring-arc-border hover:ring-arc-borderlt flex items-center justify-center text-arc-text transition">
        <Icon name="bell" size={17} />
        {unread > 0 && <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-arc-bg">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)}></div>
          <div className="absolute right-0 mt-2 z-40 w-80 bg-arc-surface2 ring-1 ring-arc-borderlt rounded-2xl shadow-2xl overflow-hidden anim-modal">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-arc-border">
              <Icon name="bell" size={15} className="text-arc-accent" />
              <span className="text-sm font-semibold text-arc-text">{tr('notif.title','Notifications')}</span>
              {unread > 0 && <span className="text-[10px] font-pixel text-rose-300 bg-rose-500/15 rounded px-1.5 py-1">{unread} {tr('notif.new','NEW')}</span>}
              <button onClick={onReadAll} className="ml-auto text-[11px] text-arc-accent hover:brightness-125 transition">{tr('notif.markread','Mark read')}</button>
            </div>
            <div className="max-h-[360px] overflow-y-auto">
              {notifs.length === 0 && <div className="py-12 text-center text-sm text-arc-faint">{tr('notif.empty','No notifications yet.')}</div>}
              {notifs.map(n => (
                <button key={n.id} onClick={() => { setOpen(false); if (n.go && onGo) onGo(n.go); }}
                  className={`w-full text-left flex gap-3 px-4 py-3 border-b border-arc-border/60 hover:bg-arc-surface transition ${n.read ? '' : 'bg-arc-primary/5'}`}>
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${NOTIF_TONE[n.tone] || NOTIF_TONE.slate}`}><Icon name={n.icon} size={16} /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><span className="text-sm font-medium text-arc-text truncate">{n.title}</span>{!n.read && <span className="w-1.5 h-1.5 rounded-full bg-arc-accent shrink-0"></span>}</div>
                    <div className="text-[12px] text-arc-muted leading-snug" style={{ textWrap: 'pretty' }}>{n.text}</div>
                    <div className="text-[10px] text-arc-faint mt-0.5">{n.time} {tr('notif.ago','ago')}</div>
                  </div>
                </button>
              ))}
            </div>
            {notifs.length > 0 && <button onClick={onClear} className="w-full py-2.5 text-[11px] text-arc-faint hover:text-arc-text hover:bg-arc-surface transition border-t border-arc-border">{tr('notif.clear','Clear all')}</button>}
          </div>
        </>
      )}
    </div>
  );
}

// ---- UCW Wallet provisioning steps ----
const PROVISION_STEPS = [
  { icon: 'mail', key: 'prov.s1' },
  { icon: 'key-round', key: 'prov.s2' },
  { icon: 'shield-check', key: 'prov.s3' },
];

function AuthScreen({ onAuthed }) {
  useLang();
  const [step, setStep] = useState('email');   // email | username | provisioning
  const [email, setEmail] = useState('');

  const [username, setUsername] = useState('');
  const [usernameAvailable, setUsernameAvailable] = useState(false);
  const [checkingUsername, setCheckingUsername] = useState(false);
  const [otpCreds, setOtpCreds] = useState({ userToken: '', encryptionKey: '' });

  const [otpToken, setOtpToken] = useState('');
  const [deviceToken, setDeviceToken] = useState('');
  const [deviceEncryptionKey, setDeviceEncryptionKey] = useState('');
  const [deviceId, setDeviceId] = useState('');

  const [otpError, setOtpError] = useState('');
  const [otpLoading, setOtpLoading] = useState(false);

  // wave15 — recovery via a linked external EOA (no email needed).
  const [recoverMode, setRecoverMode] = useState(false);
  const [recoverAddr, setRecoverAddr] = useState('');
  const [recoverBusy, setRecoverBusy] = useState(false);

  const [challengeId, setChallengeId] = useState('');
  const [provStep, setProvStep] = useState(-1);
  const [walletAddr, setWalletAddr] = useState('');

  const [turnstileToken, setTurnstileToken] = useState('');

  const API = window.SLIME_API || '';
  const TURNSTILE_SITE_KEY = window.TURNSTILE_SITE_KEY || '';

  useEffect(() => {
    if (TURNSTILE_SITE_KEY && typeof turnstile !== 'undefined' && turnstile.ready) {
      try {
        turnstile.ready(() => {
          const el = document.getElementById('turnstile-widget');
          if (el) {
            turnstile.render(el, {
              sitekey: TURNSTILE_SITE_KEY,
              callback: (token) => setTurnstileToken(token),
              'expired-callback': () => setTurnstileToken(''),
              theme: 'dark', size: 'normal',
            });
          }
        });
      } catch (e) { console.warn('Turnstile init skipped:', e.message); }
    }
  }, []);

  // wave15-polish — auto-connect wallet when entering wallet sign-in mode
  useEffect(() => {
    if (!recoverMode) return;
    setOtpError('');
    if (!window.WalletBridge) return;
    (async () => {
      try {
        const addr = window.WalletBridge.isConnected()
          ? window.WalletBridge.getAddress()
          : await window.WalletBridge.connect();
        if (addr) setRecoverAddr(addr);
      } catch (e) {
        // silent — user can connect manually
      }
    })();
  }, [recoverMode]);

  // Debounced username availability check
  useEffect(() => {
    if (username.length < 3) { setUsernameAvailable(false); return; }
    setCheckingUsername(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch((window.SLIME_API || '') + '/api/auth/check-username?username=' + encodeURIComponent(username));
        const d = await r.json();
        setUsernameAvailable(d.available === true);
      } catch { setUsernameAvailable(false); }
      setCheckingUsername(false);
    }, 400);
    return () => clearTimeout(t);
  }, [username]);

  const requestOtp = async () => {
    if (!email.trim() || !email.includes('@')) { setOtpError('Please enter a valid email'); return; }
    setOtpLoading(true); setOtpError('');
    try {
      // LOCAL DEV: skip Circle SDK entirely
      if (window.IS_LOCAL) {
        const dt = 'dev-' + Math.random().toString(36).slice(2, 14);
        setDeviceId(dt);
        const r = await fetch(API + '/api/auth/email-otp', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'request', email: email.trim(), turnstileToken, deviceId: dt }),
        });
        const d = await r.json();
        if (!r.ok) { setOtpError(d.error || 'Failed to send code'); setOtpLoading(false); return; }
        const ut = 'dev-token-' + Math.random().toString(36).slice(2, 10);
        setOtpLoading(false);
        setOtpCreds({ userToken: ut, encryptionKey: 'dev-key' });
        setStep('username');
        return;
      }

      // Fallback: if W3SSdk not available (browser blocked iframe/shim), use dev bypass
      if (typeof W3SSdk === 'undefined') {
        console.warn('W3SSdk not available — falling back to dev login bypass');
        const r = await fetch(API + '/api/auth/email-otp', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'login', email: email.trim() }),
        });
        const d = await r.json();
        if (!r.ok) { setOtpError(d.error || 'Login failed'); setOtpLoading(false); return; }
        setOtpLoading(false);
        setOtpCreds({ userToken: d.userToken, encryptionKey: d.encryptionKey });
        setStep('username');
        return;
      }

      // 1. Get device ID from Circle (hidden iframe)
      const sdk = new W3SSdk({ appSettings: { appId: window.CIRCLE_APP_ID || '' } });
      let did;
      try { did = await sdk.getDeviceId(); }
      catch (e2) { setOtpError('Failed to connect to Circle. Try again.'); setOtpLoading(false); return; }
      setDeviceId(did);

      // 2. Call API to send OTP email
      const r = await fetch(API + '/api/auth/email-otp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request', email: email.trim(), turnstileToken, deviceId: did }),
      });
      const d = await r.json();
      if (!r.ok) { setOtpError(d.error || 'Failed to send code'); setOtpLoading(false); return; }
      setOtpToken(d.otpToken); setDeviceToken(d.deviceToken); setDeviceEncryptionKey(d.deviceEncryptionKey);

      // 3. Open Circle iframe — user enters OTP code here (single entry, no double input)
      new W3SSdk({
        appSettings: { appId: window.CIRCLE_APP_ID || '' },
        loginConfigs: { deviceToken: d.deviceToken, deviceEncryptionKey: d.deviceEncryptionKey, otpToken: d.otpToken },
      }, (err, result) => {
        if (err || !result) {
          setOtpError(typeof err === 'object' ? (err.message || 'Verification failed') : 'Verification failed');
          setOtpLoading(false);
          return;
        }
        
        // Skip the complex check - use unified endpoint directly
        const userToken = result.userToken || '';
        const encryptionKey = result.encryptionKey || '';
        
        
        
        fetch(API + '/api/auth/unified', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            userToken,
            email: email.trim(),
            encryptionKey,
            username: username,  // Will use this after input
          }),
        })
        .then(async r => {
          const d = await r.json();
          if (r.ok && d.user) {
            setOtpLoading(false);
            
            // wave9.B2 — first-time users get ONE hosted-UI challenge to set
            // their 6-digit PIN + security questions (wallet is created in
            // the same step). Never blocks login: on error / missing SDK we
            // continue into the app and retry on next load (wave9.B3).
            await maybeRunPinSetup(d);
            onAuthed({ 
              kind: 'login', 
              name: d.user.name, 
              email: email.trim(), 
              wallet: d.wallet?.address, 
              user: d.user 
            });
          } else {
            
            setStep('username');
          }
        })
        .catch(err => {
          console.error('Session error:', err);
          setOtpLoading(false);
          setStep('username'); // Force show username form
        });
      }).verifyOtp();
    } catch (e) { setOtpError('Network error. Try again.'); setOtpLoading(false); }
  };

  const proceedWithUsername = () => {
    runProvisioning(otpCreds.userToken, otpCreds.encryptionKey, username);
  };

  // wave15 — recover access with a LINKED external wallet (EOA). No email
  // involved: the server issues a single-use nonce, the wallet signs it, and
  // the session is restored. Circle-UCW money actions still need the normal
  // email-code login (documented in the UI copy).
  const recoverWithWallet = async () => {
    const addr = recoverAddr.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { setOtpError('Enter the wallet address you linked (0x…)'); return; }
    if (!window.WalletBridge) { setOtpError('Wallet bridge unavailable — reload the page'); return; }
    setRecoverBusy(true); setOtpError('');
    try {
      const ch = await fetch(API + '/api/auth/recovery/challenge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr }),
      }).then(r => r.json());
      if (!ch || !ch.nonce || !ch.message) throw new Error((ch && ch.error) || 'challenge failed');

      const connected = window.WalletBridge.isConnected() ? window.WalletBridge.getAddress() : await window.WalletBridge.connect();
      if (!connected) throw new Error('wallet connection cancelled');
      if (connected.toLowerCase() !== addr.toLowerCase()) {
        throw new Error('connected wallet ' + connected.slice(0, 10) + '… does not match ' + addr.slice(0, 10) + '…');
      }
      const signature = await window.WalletBridge.signMessage(ch.message);
      const r = await fetch(API + '/api/auth/recovery/verify', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr, nonce: ch.nonce, signature }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.user) throw new Error((d && d.error) || 'invalid recovery attempt');
      onAuthed({
        kind: 'login',
        name: d.user.name,
        email: d.user.email,
        wallet: d.user && d.wallet ? d.wallet.address : null,
        user: d.user,
      });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      // wave15-polish — friendlier copy for common failure modes
      if (msg.includes('invalid recovery attempt')) {
        setOtpError('This wallet is not linked to any SlimeMarket account. Please sign in with email first and link your wallet in Settings.');
      } else if (msg.includes('wallet connection cancelled')) {
        setOtpError('Wallet connection was cancelled. Please try again.');
      } else {
        setOtpError('Sign-in failed: ' + msg);
      }
    } finally {
      setRecoverBusy(false);
    }
  };

  // FIX (mainnet wallet creation): this used to be an intentional no-op, which
  // meant the OTP-verify path NEVER created a Circle wallet. /api/auth/unified
  // only *lists* wallets — creation requires executing the initialize
  // challenge (`POST /v1/w3s/user/initialize` → challengeId → W3SSdk.execute).
  // With this a no-op, new users logged in, saw "Wallet Address Not available"
  // and Circle Console showed zero wallets.
  //
  // Now: if the session reports needsPinSetup, run the Circle hosted-UI
  // challenge IMMEDIATELY after OTP verification (seamless — no extra button
  // press, no blocking gate). The user sets their PIN once; the wallet is
  // created in the same step. On every later login the user already has a
  // wallet, so needsPinSetup is false and nothing is shown.
  const maybeRunPinSetup = async (d) => {
    if (!d) { window.__SLIME_WALLET_ERR = 'unified returned no body'; return; }
    if (!d.needsPinSetup) {
      window.__SLIME_WALLET_ERR = 'unified had no needsPinSetup (keys: ' + Object.keys(d).join(',') + ')';
      return;
    }
    if (!d.pinSetupChallengeId) { window.__SLIME_WALLET_ERR = 'unified: needsPinSetup but no challengeId'; return; }
    if (typeof window.executeUcwChallenge !== 'function') {
      window.__SLIME_WALLET_ERR = 'executeUcwChallenge not loaded yet';
      return;
    }

    try {
      setOtpError(tr('pin.walletCreating', 'Creating your wallet on Arc…'));
      const result = await window.executeUcwChallenge(d.pinSetupChallengeId, { isPinSetup: true });
      if (!result) {
        // null = no valid UCW session; leave it to the in-app retry path.
        console.warn('[auth] wallet challenge returned null — will retry in app');
        window.__SLIME_WALLET_ERR = 'wallet challenge returned null (no UCW session)';
        return;
      }
      // Tell the server to read the new wallet back from Circle and persist it.
      try {
        const pc = await fetch(API + '/api/wallet/ucw-provisioning-complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          credentials: 'include',
        });
        if (!pc.ok) {
          const body = await pc.json().catch(() => ({}));
          console.warn('[auth] provisioning-complete failed:', pc.status, body);
          window.__SLIME_WALLET_ERR = 'provisioning-complete HTTP ' + pc.status + ': ' + (body.error || '');
        }
      } catch (e2) {
        console.warn('[auth] provisioning-complete failed (wallet still created):', e2.message);
        window.__SLIME_WALLET_ERR = 'provisioning-complete threw: ' + e2.message;
      }
    } catch (e) {
      // Never block login on a failed wallet challenge — the user can finish
      // setup from Profile / at first checkout. Surface the reason visibly so
      // it can be reported without opening DevTools.
      const msg = (e && e.message) ? e.message : String(e);
      console.warn('[auth] wallet setup deferred:', msg);
      window.__SLIME_WALLET_ERR = msg;
    }
  };

  const runProvisioning = async (uToken, eKey, uname) => {
    setStep('provisioning');
    setProvStep(0);

    // Phase 6.4 — UCW credentials are stored ONLY in httpOnly cookies (set
    // by /api/auth/unified). The FE fetches them on-demand via
    // /api/my/ucw-credentials when needed for W3SSdk.setAuthentication.
    // localStorage mirror was REMOVED per Circle skill Security Rule:
    // "ALWAYS store userToken and encryptionKey in httpOnly cookies (not
    // localStorage) in production to mitigate XSS token theft".

    let timer = 0;
    const tick = () => { timer++; if (timer <= PROVISION_STEPS.length) { setProvStep(timer); setTimeout(tick, 700); } };
    tick();

    try {
      // LOCAL DEV: skip Circle SDK/API entirely, go straight to unified session
      if (window.IS_LOCAL) {
        const devUserToken = uToken || ('dev-token-' + Math.random().toString(36).slice(2, 10));
        setProvStep(PROVISION_STEPS.length + 1);
        const r2 = await fetch(API + '/api/auth/unified', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userToken: devUserToken, email: email.trim(), encryptionKey: eKey || 'dev-key', name: email.split('@')[0], username: uname }),
        });
        const d2 = await r2.json();
        await maybeRunPinSetup(d2); // dev-token responses never include a challenge; no-op
        setTimeout(() => {
          if (r2.ok && d2.user) onAuthed({ kind: 'signup', name: d2.user.name || email.split('@')[0], email: email.trim(), wallet: d2.wallet?.address, user: d2.user });
          else { setStep('email'); setOtpError('Sign-in failed: ' + ((d2 && d2.error) || ('HTTP ' + r2.status))); }
        }, 1200);
        return;
      }

      const r = await fetch(API + '/api/auth/email-otp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'initialize', userToken: uToken }),
      });
      const d = await r.json();

      if (!d.alreadyInitialized && d.challengeId) {
        setChallengeId(d.challengeId);
        if (typeof W3SSdk !== 'undefined') {
          const sdk = new W3SSdk({ appSettings: { appId: window.CIRCLE_APP_ID || '' } }, (err) => {
            if (err) { setStep('email'); setOtpError('Login error: ' + (err.message || 'unknown')); }
          });
          sdk.setAuthentication({ userToken: uToken, encryptionKey: eKey });
          sdk.execute(d.challengeId, async (err, result) => {
            if (err) { console.error('Challenge failed:', err); setStep('email'); setOtpError('Challenge failed: ' + (err.message || 'unknown')); return; }
            // Challenge completed — fetch wallet list + create session
            setTimeout(async () => {
              const resp = await fetch(API + '/api/auth/email-otp', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'walletList', userToken: uToken }),
              });
              if (resp.ok) { const wd = await resp.json(); if (wd.wallets?.length > 0) setWalletAddr(wd.wallets[0].address); }
              // wave9.B2 — PIN-setup challenge (signup path): the initialize
              // challenge may not have set the PIN yet, so run the hosted-UI
              // PIN challenge before finalizing the session.
              try {
                const ri = await fetch(API + '/api/auth/email-otp', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'initialize', userToken: uToken }),
                });
                const di = await ri.json().catch(() => ({}));
                if (!di.alreadyInitialized && di.challengeId && typeof window.executeUcwChallenge === 'function') {
                  setOtpError(tr('pin.walletCreating', 'Creating your wallet on Arc…'));
                  try { await window.executeUcwChallenge(di.challengeId, { isPinSetup: true }); }
                  catch (pe) { console.warn('wallet creation skipped:', pe && pe.message); }
                }
              } catch (pe) { console.warn('PIN setup check skipped:', pe && pe.message); }
              setProvStep(PROVISION_STEPS.length + 1);
              const ru = await fetch(API + '/api/auth/unified', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userToken: uToken, email: email.trim(), encryptionKey: eKey, name: email.split('@')[0], username: uname }),
              });
              const du = await ru.json().catch(() => ({}));
              // wave9.B2 — belt-and-braces: if unified still reports a PIN
              // challenge (e.g. the initialize challenge didn't set the PIN),
              // run it before entering the app.
              await maybeRunPinSetup(du);
              // wave16 — HONESTY: never enter the app on a failed provisioning
              // response. The old code called onAuthed with user:null, which
              // set authed=true locally and produced a session that 401'd on
              // every subsequent API call.
              if (!ru.ok || !du || !du.user) {
                setStep('email');
                setOtpError('Wallet setup failed: ' + ((du && du.error) || ('HTTP ' + ru.status)));
                return;
              }
              setTimeout(() => { onAuthed({ kind: 'signup', name: du.user.name || email.split('@')[0], email: email.trim(), wallet: du.wallet?.address, user: du.user }); }, 1200);
            }, 1500);
          });
        }
      } else {
        const r2 = await fetch(API + '/api/auth/unified', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userToken: uToken, email: email.trim(), encryptionKey: eKey, username: uname }),
        });
        const d2 = await r2.json();
        await maybeRunPinSetup(d2);
        // wave16 — HONESTY: same rule as above — a failed response must not
        // produce a local "signed in" state.
        if (!r2.ok || !d2 || !d2.user) {
          setStep('email');
          setOtpError('Sign-in failed: ' + ((d2 && d2.error) || ('HTTP ' + r2.status)));
          return;
        }
        setProvStep(PROVISION_STEPS.length + 1);
        setTimeout(() => { onAuthed({ kind: 'login', name: d2.user.name, email: email.trim(), wallet: d2.wallet?.address, user: d2.user }); }, 800);
      }
    } catch (e) { setStep('email'); setOtpError('Wallet creation failed: ' + e.message); }
  };


  // ---- Username selection screen ----
  if (step === 'username') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-arc-bg arc-mesh grid-noise">
        <div className="w-full max-w-md anim-modal">
          <div className="flex flex-col items-center text-center mb-8">
            <SlimeLogo size={56} />
            <h1 className="text-xl font-bold text-white mt-4">{tr('auth.chooseUsername','Choose Your Username')}</h1>
            <p className="text-sm text-arc-muted mt-2">{tr('auth.usernameHint','This is how others will see you on SlimeMarket.')}</p>
          </div>
          <div className="space-y-4">
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-arc-faint text-sm">@</span>
              <input value={username} onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                placeholder="username" maxLength={20}
                className="w-full bg-arc-surface/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl pl-8 pr-10 h-12 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
              {username.length >= 3 && (
                <span className={`absolute right-3.5 top-1/2 -translate-y-1/2 text-sm ${usernameAvailable ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {checkingUsername ? '…' : usernameAvailable ? '✓' : '✗'}
                </span>
              )}
            </div>
            {username.length >= 3 && !checkingUsername && !usernameAvailable && (
              <div className="text-xs text-rose-400">{tr('auth.usernameTaken','Username taken. Try another.')}</div>
            )}
            {username.length > 0 && username.length < 3 && (
              <div className="text-xs text-amber-400">Minimum 3 characters.</div>
            )}
            <Btn variant="primary" full disabled={!usernameAvailable || checkingUsername || username.length < 3}
              onClick={() => proceedWithUsername()}>{tr('auth.continue','Continue')}</Btn>
          </div>
        </div>
      </div>
    );
  }

  // ---- Provisioning screen ----
  if (step === 'provisioning') {
    const done = provStep >= PROVISION_STEPS.length;
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-arc-bg arc-mesh grid-noise">
        <div className="w-full max-w-md anim-modal">
          <div className="flex flex-col items-center text-center mb-8">
            <SlimeLogo size={64} />
            <h1 className="text-xl font-bold text-white mt-4">{done ? tr('prov.done','Wallet Ready!') : tr('prov.title','Creating Your Wallet')}</h1>
            <p className="text-sm text-arc-muted mt-1.5">{done ? tr('prov.doneSub','Your secure wallet is ready on Arc testnet.') : tr('prov.sub','Secure MPC wallet powered by Circle.')}</p>
          </div>
          <div className="space-y-2.5">
            {PROVISION_STEPS.map((s, i) => {
              const state = i < provStep ? 'done' : i === provStep ? 'active' : 'wait';
              return (
                <div key={i} className={`flex items-center gap-3 rounded-xl p-3.5 ring-1 transition-all ${state === 'wait' ? 'ring-arc-border bg-arc-surface/40 opacity-50' : state === 'active' ? 'ring-arc-primary/40 bg-arc-primary/5' : 'ring-emerald-500/30 bg-emerald-500/5'}`}>
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${state === 'done' ? 'bg-emerald-500/20 text-emerald-400' : state === 'active' ? 'bg-arc-primary/20 text-arc-accent' : 'bg-arc-surface2 text-arc-faint'}`}>
                    {state === 'done' ? <Icon name="check" size={17} /> : state === 'active' ? <Icon name="loader" size={17} className="animate-spin" /> : <Icon name={s.icon} size={17} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium ${state === 'wait' ? 'text-arc-faint' : 'text-arc-text'}`}>{tr(s.key)}</div>
                    <div className="text-[11px] text-arc-faint">{tr(s.key + 'sub')}</div>
                  </div>
                </div>
              );
            })}
          </div>
          {done && walletAddr && (
            <div className="mt-5 rounded-xl ring-1 ring-arc-border bg-arc-bg/60 p-3.5 anim-fade">
              <div className="text-[11px] text-arc-faint mb-1">{tr('prov.addr','Wallet Address (Arc)')}</div>
              <div className="font-mono text-xs text-arc-accent break-all">{walletAddr}</div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ---- Email input screen ----
  return (
    <div className="min-h-screen flex bg-arc-bg">
      <div className="absolute top-4 right-4 z-10"><LangSwitcher /></div>
      {/* brand panel */}
      <div className="hidden lg:flex flex-col justify-between w-[44%] relative overflow-hidden arc-mesh p-12 border-r border-arc-border">
        <div className="absolute -right-10 bottom-10 opacity-20"><SlimeLogo size={320} /></div>
        <div className="relative flex items-center gap-3">
          <SlimeLogo size={40} />
          <div className="leading-none">
            <div className="font-bold text-lg text-white">Slime<span className="text-arc-accent">Market</span></div>
            <Pixel className="text-[7px] text-arc-faint">ARC ESCROW · TRUSTLESS</Pixel>
          </div>
        </div>
        <div className="relative">
          <Pixel className="text-arc-accent text-[10px]">{tr('auth.kicker','MPC WALLET · ON-CHAIN ESCROW')}</Pixel>
          <h1 className="mt-4 text-4xl font-bold text-white leading-tight" style={{ textWrap: 'balance' }}>{tr('auth.tagline','Buy digital assets without fear of scams.')}</h1>
          <p className="mt-3 text-sm text-arc-muted max-w-sm">{tr('auth.heroSub','Every transaction is protected by smart-contract escrow & middleman.')}</p>
          <div className="mt-6 flex flex-wrap gap-2">
            {[['shield-check', tr('auth.feat1','Non-custodial MPC')], ['lock', tr('auth.feat2','E2E Encrypted')], ['gavel', tr('auth.feat3','Tribunal Dispute')]].map(([ic, label]) => (
              <span key={ic} className="inline-flex items-center gap-1.5 text-xs text-arc-text bg-arc-bg/40 ring-1 ring-arc-border rounded-lg px-3 py-1.5"><Icon name={ic} size={14} className="text-emerald-400" /> {label}</span>
            ))}
          </div>
        </div>
        <div className="relative text-[11px] text-arc-faint">{tr('auth.copyright','© 2026 SlimeMarket · Secured on the Arc chain')}</div>
      </div>

      {/* form panel */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm anim-view">
          <div className="lg:hidden flex items-center gap-2.5 mb-8 justify-center">
            <SlimeLogo size={36} />
            <div className="font-bold text-lg text-white">Slime<span className="text-arc-accent">Market</span></div>
          </div>

          {recoverMode ? (
            <>
              <h2 className="text-xl font-bold text-white">{tr('auth.walletTitle','Sign in with Wallet')}</h2>
              <p className="text-sm text-arc-muted mt-1 mb-5">
                {tr('auth.walletSub','Connect your external wallet to sign in. Your wallet must be linked to your SlimeMarket account.')}
              </p>
              <div className="space-y-3">
                {recoverAddr ? (
                  <div className="rounded-xl ring-1 ring-arc-border bg-arc-surface/40 p-3.5 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-arc-primary/10 flex items-center justify-center shrink-0">
                      <Icon name="wallet" size={18} className="text-arc-accent" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] text-arc-faint">{tr('auth.connectedWallet','Connected wallet')}</div>
                      <div className="font-mono text-xs text-arc-text truncate">{recoverAddr}</div>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        if (!window.WalletBridge) return;
                        try { const a = await window.WalletBridge.connect(); if (a) setRecoverAddr(a); } catch (e) {}
                      }}
                      className="text-[11px] text-arc-accent hover:text-arc-text underline transition shrink-0"
                    >
                      {tr('auth.changeWallet','Change')}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      if (!window.WalletBridge) { setOtpError('Wallet bridge unavailable — reload the page'); return; }
                      try { const a = await window.WalletBridge.connect(); if (a) setRecoverAddr(a); }
                      catch (e) { setOtpError('Wallet connection cancelled'); }
                    }}
                    className="w-full h-12 rounded-xl bg-arc-surface/60 ring-1 ring-arc-border hover:ring-arc-borderlt hover:bg-arc-surface text-sm text-arc-text font-medium transition flex items-center justify-center gap-2"
                  >
                    <Icon name="wallet" size={16} className="text-arc-accent" />
                    {tr('auth.connectWallet','Connect Wallet')}
                  </button>
                )}

                {otpError && (
                  <div className={`text-sm text-center ${otpError.includes('not linked') ? 'text-amber-400' : 'text-rose-400'}`}>
                    {otpError}
                  </div>
                )}

                <Btn variant="primary" size="lg" full icon="fingerprint" disabled={recoverBusy || !recoverAddr.trim()} onClick={recoverWithWallet}>
                  {recoverBusy ? tr('auth.walletBusy','Waiting for signature…') : tr('auth.walletCta','Sign & Login')}
                </Btn>

                <div className="rounded-xl ring-1 ring-arc-border/60 bg-arc-surface/30 p-3">
                  <div className="flex items-start gap-2">
                    <Icon name="info" size={14} className="text-arc-faint shrink-0 mt-0.5" />
                    <p className="text-[11px] text-arc-faint leading-relaxed">
                      {tr('auth.walletNotice','New here? Create an account with email first, then link your wallet in Settings → Recovery.')}
                    </p>
                  </div>
                </div>

                <div className="text-center">
                  <button type="button" onClick={() => { setRecoverMode(false); setOtpError(''); }} className="text-xs text-arc-faint hover:text-arc-text underline transition">
                    {tr('auth.walletBack','← Back to email sign-in')}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <h2 className="text-xl font-bold text-white">{tr('auth.login','Sign In')}</h2>
              <p className="text-sm text-arc-muted mt-1 mb-5">Enter your email to sign in. A 6-digit code will be sent to you.</p>

              <div className="space-y-3">
                <AField label={tr('auth.email','Email')}>
                  <input type="email" value={email} onChange={e => { setEmail(e.target.value); setOtpError(''); }}
                    onKeyDown={e => e.key === 'Enter' && requestOtp()}
                    placeholder="you@email.com" className="w-full bg-arc-surface/60 ring-1 ring-arc-border focus:ring-arc-primary/50 rounded-xl px-4 h-12 text-sm text-arc-text placeholder-arc-faint outline-none transition" />
                </AField>

                {TURNSTILE_SITE_KEY && <div id="turnstile-widget" className="flex justify-center" style={{ minHeight: '65px' }}></div>}

                {otpError && <div className="text-sm text-rose-400 text-center">{otpError}</div>}

                <Btn variant="primary" size="lg" full icon="mail" disabled={!email.trim() || !email.includes('@') || otpLoading} onClick={requestOtp}>
                  {otpLoading ? 'Sending…' : 'Send Login Code'}
                </Btn>

                <div className="flex items-center justify-center gap-3 my-1">
                  <div className="h-px flex-1 bg-arc-border"></div>
                  <span className="text-[11px] text-arc-faint">{tr('auth.or','or')}</span>
                  <div className="h-px flex-1 bg-arc-border"></div>
                </div>

                <button
                  type="button"
                  onClick={() => { setRecoverMode(true); setOtpError(''); }}
                  className="w-full h-12 rounded-xl bg-arc-surface/60 ring-1 ring-arc-border hover:ring-arc-borderlt hover:bg-arc-surface text-sm text-arc-text font-medium transition flex items-center justify-center gap-2"
                >
                  <Icon name="wallet" size={16} className="text-arc-accent" />
                  {tr('auth.walletLogin','Sign in with Wallet')}
                </button>
              </div>
            </>
          )}

          <div className="flex items-center justify-center gap-3 mt-4">
            <div className="h-px w-12 bg-arc-border"></div>
            <span className="text-[11px] text-arc-faint">secure login</span>
            <div className="h-px w-12 bg-arc-border"></div>
          </div>
          <div className="flex items-center justify-center gap-1.5 mt-2 text-[11px] text-arc-faint">
            <Icon name="shield-check" size={13} className="text-emerald-500/70" />
            <span>{tr('auth.mpcNote','Your wallet is secured by Circle MPC technology')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function AField({ label, children }) {
  return (
    <div>
      <label className="text-xs text-arc-muted mb-1.5 block">{label}</label>
      {children}
    </div>
  );
}

Object.assign(window, { NOTIFS, NOTIF_TONE, NotifBell, AuthScreen });
