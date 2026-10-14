// ============ AppKitHelper — lazy loader + wrapper for Circle Arc App Kit ============

// the inbound rails (buy with fiat / bridge / swap) run on Circle's Arc
// App Kit, bundled to /app-kit-bridge.js (~2.2 MB). We deliberately do NOT load
// that on every page — it is injected the first time the user opens the
// "Add funds" panel, so the rest of the SPA is unaffected.

// Consumed by balance.jsx. Never holds secrets: the Circle API key stays on the
// server, which mints the short-lived onramp session.

window.AppKitHelper = (function () {
  var SCRIPT_SRC = '/app-kit-bridge.js';
  var loadPromise = null;

  function loadScript() {
    if (loadPromise) return loadPromise;
    loadPromise = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-app-kit-bridge]');
      if (existing) {
        if (window.AppKitBridge) { resolve(window.AppKitBridge); return; }
        existing.addEventListener('load', function () { resolve(window.AppKitBridge); });
        existing.addEventListener('error', function () { reject(new Error('App Kit bundle failed to load')); });
        return;
      }
      var s = document.createElement('script');
      s.src = SCRIPT_SRC;
      s.async = true;
      s.setAttribute('data-app-kit-bridge', '1');
      s.onload = function () {
        if (window.AppKitBridge) resolve(window.AppKitBridge);
        else reject(new Error('App Kit bundle loaded but window.AppKitBridge is missing'));
      };
      s.onerror = function () { reject(new Error('App Kit bundle failed to load')); };
      document.head.appendChild(s);
    });
    return loadPromise;
  }

  function env() {
    var cfg = window.SLIME_CONFIG || {};
    return cfg.appKitEnv === 'sandbox' ? 'sandbox' : 'production';
  }

  // The container is rendered by React, so it may not exist (or may not have
  // been laid out yet) at the moment we call mount. Poll briefly instead of
  // relying on a fixed delay — the kit throws NO_CONTAINER / CONTAINER_NO_HEIGHT
  // otherwise, and the widget would silently never appear.
  function waitForContainer(id, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 3000);
    return new Promise(function (resolve, reject) {
      (function check() {
        var el = document.getElementById(id);
        if (el && el.clientHeight > 0) { resolve(el); return; }
        if (Date.now() > deadline) {
          reject(new Error(el ? ('#' + id + ' has zero height') : ('#' + id + ' not found')));
          return;
        }
        setTimeout(check, 50);
      })();
    });
  }

  return {
    /** Which environment the widget will talk to (sandbox vs production). */
    environment: env,

    /** True once the bundle has been injected and is usable. */
    isLoaded: function () { return !!window.AppKitBridge; },

    /** Preload the bundle (safe to call when the panel opens). */
    preload: function () { return loadScript().then(function () { return true; }); },

    /**
     * Mount the fiat onramp widget into `containerId`.
     * The container MUST have an explicit non-zero height or the iframe
     * collapses to 0px.
     */
    mountOnramp: function (opts) {
      opts = opts || {};
      return loadScript()
        .then(function () { return waitForContainer(opts.containerId); })
        .then(function () {
          return window.AppKitBridge.mountOnramp({
            containerId: opts.containerId,
            onReady: opts.onReady,
            onSettled: opts.onSettled,
            onNotCompleted: opts.onNotCompleted,
          });
        });
    },

    closeOnramp: function () {
      if (window.AppKitBridge) window.AppKitBridge.closeOnramp();
    },

    /**
     * Bridge USDC from another chain into Arc. Signs from the user's connected
     * external wallet (window.ethereum); the destination address is typically
     * the user's Slime Wallet (UCW), which cannot itself sign off-Arc.
     */
    bridge: function (params) {
      return loadScript().then(function (kit) { return kit.bridge(params); });
    },

    /**
     * Swap a token for USDC. NOTE: Swap is mainnet-only except Arc testnet — on
     * testnet only USDC/EURC are swappable, so BNB/ETH -> USDC is a mainnet
     * capability. Callers must surface that honestly.
     */
    swap: function (params) {
      return loadScript().then(function (kit) { return kit.swap(params); });
    },

    supportedChains: function () {
      if (!window.AppKitBridge) return { bridge: [], swap: [] };
      return window.AppKitBridge.supportedChains();
    },
  };
})();
