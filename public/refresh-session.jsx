// ============ SlimeMarket — Refresh Wallet Session (Phase 6.4) ============
// One-time flow for existing users whose httpOnly UCW credential cookies
// have expired or are missing. Triggers a fresh Circle OTP flow to obtain
// new credentials, then POSTs them to /api/auth/unified which sets them
// as httpOnly cookies (server-side). FE never persists credentials in JS —
// they are fetched on-demand via /api/my/ucw-credentials when needed for
// W3SSdk.setAuthentication.

// Loaded only when the user lands on /refresh-session (router.jsx maps it).

const { useState, useEffect } = React;

function RefreshSession() {
  useLang();
  const [step, setStep] = useState('email');   // email | otp | provisioning | done
  const [email, setEmail] = useState('');
  const [otpToken, setOtpToken] = useState('');
  const [deviceToken, setDeviceToken] = useState('');
  const [deviceEncryptionKey, setDeviceEncryptionKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [next, setNext] = useState('/');

  const API = window.SLIME_API || '';

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const n = params.get('next');
    if (n && n.startsWith('/')) setNext(n);
  }, []);

  const requestOtp = async () => {
    if (!email.trim() || !email.includes('@')) { setError('Please enter a valid email'); return; }
    setLoading(true); setError('');
    try {
      if (typeof W3SSdk === 'undefined') { setError('Wallet SDK not loaded'); setLoading(false); return; }
      const sdk = new W3SSdk({ appSettings: { appId: window.CIRCLE_APP_ID || '' } });
      const did = await sdk.getDeviceId();
      const r = await fetch(API + '/api/auth/email-otp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request', email: email.trim(), deviceId: did }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || 'Failed to send code'); setLoading(false); return; }
      setOtpToken(d.otpToken); setDeviceToken(d.deviceToken); setDeviceEncryptionKey(d.deviceEncryptionKey);
      setStep('otp');
    } catch (e) { setError('Network error. Try again.'); }
    setLoading(false);
  };

  const verifyOtp = async () => {
    setLoading(true); setError('');
    try {
      new W3SSdk({
        appSettings: { appId: window.CIRCLE_APP_ID || '' },
        loginConfigs: { deviceToken, deviceEncryptionKey, otpToken },
      }, async (err, result) => {
        if (err || !result) {
          setError(typeof err === 'object' ? (err.message || 'Verification failed') : 'Verification failed');
          setLoading(false);
          return;
        }
        // Phase 6.4 — POST credentials to /api/auth/unified which sets them
        // as httpOnly cookies (server-side). FE never persists them — fetched
        // on-demand via /api/my/ucw-credentials when needed for W3SSdk.
        try {
          const API = window.SLIME_API || '';
          const r = await fetch(API + '/api/auth/unified', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userToken: result.userToken,
              encryptionKey: result.encryptionKey,
              email: email.trim(),
            }),
          });
          if (!r.ok) {
            // the status used to be ignored entirely. The page then
            // announced "session refreshed" and redirected the user back into a
            // page whose UCW calls still 401'd — a recovery path that fails
            // silently fails forever, because the user has no reason to retry.
            // Fail LOUDLY and stay on the page so they can try again.
            const d = await r.json().catch(() => ({}));
            setError(
              'Could not save the refreshed credentials (HTTP ' + r.status +
                (d && d.error ? ': ' + d.error : '') +
                '). Your wallet session was NOT refreshed — please try again.',
            );
            setLoading(false);
            return;
          }
        } catch (e) {
          setError(
            'Could not reach the server to save your wallet session: ' + e.message +
              ' — please try again.',
          );
          setLoading(false);
          return;
        }
        setStep('done');
        setLoading(false);
        // Redirect after a short delay so the user sees the success state.
        setTimeout(() => { window.location.href = next; }, 800);
      }).verifyOtp();
    } catch (e) { setError('Verification error: ' + e.message); setLoading(false); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-arc-bg arc-mesh grid-noise">
      <div className="w-full max-w-md anim-modal">
        <div className="flex flex-col items-center text-center mb-8">
          <SlimeLogo size={56} />
          <h1 className="text-xl font-bold text-white mt-4">Refresh Wallet Session</h1>
          <p className="text-sm text-arc-muted mt-2">
            We need to re-establish your wallet credentials to enable non-custodial checkout.
            Your account is unaffected — this only refreshes the signing keys.
          </p>
        </div>

        {error && <div className="mb-4 px-4 py-3 rounded-lg bg-rose-500/15 text-rose-300 text-sm">{error}</div>}

        {step === 'email' && (
          <div className="space-y-4">
            <input
              type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              className="w-full px-4 py-3 rounded-xl bg-arc-surface ring-1 ring-arc-border text-arc-text focus:ring-arc-accent"
              onKeyDown={(e) => { if (e.key === 'Enter') requestOtp(); }}
            />
            <button onClick={requestOtp} disabled={loading}
              className="w-full py-3 rounded-xl bg-arc-primary text-white font-semibold hover:brightness-110 disabled:opacity-50">
              {loading ? 'Sending...' : 'Send Code'}
            </button>
          </div>
        )}

        {step === 'otp' && (
          <div className="space-y-4">
            <p className="text-sm text-arc-muted">Enter the code sent to {email}</p>
            <button onClick={verifyOtp} disabled={loading}
              className="w-full py-3 rounded-xl bg-arc-primary text-white font-semibold hover:brightness-110 disabled:opacity-50">
              {loading ? 'Verifying...' : 'Open OTP Prompt'}
            </button>
            <button onClick={() => setStep('email')} className="w-full py-2 text-sm text-arc-muted hover:text-arc-text">
              ← Use a different email
            </button>
          </div>
        )}

        {step === 'done' && (
          <div className="text-center space-y-3">
            <div className="text-emerald-400 text-5xl">✓</div>
            <p className="text-arc-text font-semibold">Wallet session refreshed!</p>
            <p className="text-sm text-arc-muted">Redirecting you back...</p>
          </div>
        )}
      </div>
    </div>
  );
}

window.RefreshSession = RefreshSession;
