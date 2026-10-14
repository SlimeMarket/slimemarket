// ============ SlimeMarket — UCW Credential Helper (Phase 6.4) ============
// Single source of truth for fetching UCW credentials (userToken +
// encryptionKey) on-demand from the backend. Per Circle skill
// `use-user-controlled-wallets` Security Rule: credentials MUST live in
// httpOnly cookies, NOT localStorage. The FE fetches them via this helper
// only when needed for W3SSdk.setAuthentication, and does NOT persist them.

// Usage:
//   const creds = await fetchUcwCredentials();
//   if (!creds) { /* redirect to /refresh-session */ return; }
//   const sdk = new W3SSdk({ appSettings: { appId: window.CIRCLE_APP_ID || '' } });
//   sdk.setAuthentication({ userToken: creds.userToken, encryptionKey: creds.encryptionKey });
//   sdk.execute(challengeId, callback);

window.fetchUcwCredentials = async function fetchUcwCredentials() {
  try {
    const API = window.SLIME_API || '';
    const r = await fetch(API + '/api/my/ucw-credentials', { method: 'GET' });
    if (!r.ok) {
      console.warn('fetchUcwCredentials failed:', r.status);
      return null;
    }
    const data = await r.json();
    // Response shape: { userToken, encryptionKey, circleWalletId, ephemeral }
    if (!data.userToken || !data.encryptionKey) return null;
    return data;
  } catch (e) {
    console.warn('fetchUcwCredentials threw:', e.message);
    return null;
  }
};

/**
 * Helper: execute a W3SSdk challenge with on-demand credential fetch.
 * Returns the challenge result (which may contain a txHash for transaction
 * challenges). Resolves with the result object, or null if credentials missing.
 *
 * For contract-execution / transaction challenges, the result's `data.txHash`
 * (on-chain hash) should be passed to the confirm endpoint.
 *
 * @param {string} challengeId - The Circle challenge ID from the backend.
 * @param {{isPinSetup?: boolean}} [opts] - .B2: pass { isPinSetup: true }
 *   for the PIN-setup (+wallet) hosted-UI challenge to apply custom security
 *   questions + localizations (no-op when the SDK build doesn't support them).
 * @returns {Promise<{txHash?: string}|null>} Result object, or null for redirect.
 */
window.executeUcwChallenge = async function executeUcwChallenge(challengeId, opts) {
  if (typeof W3SSdk === 'undefined') {
    throw new Error('Wallet SDK not loaded. Reload and try again.');
  }
  const o = opts || {};
  const creds = await window.fetchUcwCredentials();
  if (!creds) {
    return null;
  }
  return new Promise((resolve, reject) => {
    const sdk = new W3SSdk({ appSettings: { appId: window.CIRCLE_APP_ID || '' } }, (err) => {
      if (err) reject(new Error('W3S init: ' + (err.message || 'unknown')));
    });
    sdk.setAuthentication({ userToken: creds.userToken, encryptionKey: creds.encryptionKey });

    // .B4 — "Forgot PIN" in the hosted UI → refresh-session escape hatch
    // (re-runs OTP, gets a fresh userToken; handles Circle error 155104).
    // No-op-safe: older SDK builds without setOnForgotPin just skip it.
    if (typeof sdk.setOnForgotPin === 'function') {
      sdk.setOnForgotPin(() => window.redirectToRefreshSession());
    }

    // .B2 — PIN-setup challenge customizations. The W3S SDK shim may not
    // implement these methods (they exist on the full @circle-fin SDK), so
    // every call is guarded by a typeof check (no-op-safe).
    if (o.isPinSetup) {
      if (typeof sdk.setCustomSecurityQuestions === 'function') {
        sdk.setCustomSecurityQuestions([
          { question: tr('pin.sq1', 'What city were you born in?'), type: 'TEXT' },
          { question: tr('pin.sq2', 'What is your favorite product category?'), type: 'TEXT' },
        ], 2);
      }
      if (typeof sdk.setLocalizations === 'function') {
        const lang = (window.ME && window.ME.preferred_lang) || 'en';
        sdk.setLocalizations(lang);
      }
    }

    sdk.execute(challengeId, (err, result) => {
      if (err) reject(new Error('Challenge failed: ' + (err.message || 'user cancelled')));
      else {
        // .D — gate debug logging to localhost and never dump the full
        // result (can carry tokens/PII); log only the shape we need to debug.
        if (typeof location !== 'undefined' && /^(localhost|127\.)/.test(location.hostname)) {
          console.log('[W3SSdk execute] result keys:', Object.keys(result || {}));
        }
        const r = result || {};
        const data = r.data || {};
        // Try multiple possible field names — Circle's result shape isn't
        // fully documented in the SDK types.
        const txHash = data.txHash || data.id || data.transactionHash || data.txid || undefined;
        resolve({ txHash, raw: r });
      }
    });
  });
};

/**
 * Helper: redirect to /refresh-session if UCW credentials are unavailable.
 * Passes `next` query param so the user returns to the current page after.
 */
window.redirectToRefreshSession = function redirectToRefreshSession() {
  const next = window.location.pathname + window.location.search;
  window.location.href = '/refresh-session?next=' + encodeURIComponent(next);
};
