/**
 * W3SSdk browser shim — faithful port of @circle-fin/w3s-pw-web-sdk src/index.ts
 * Strips Firebase/social-login (only needed for Apple/Google/Facebook login).
 * Implements: email OTP verification, challenge execution, deviceId.
 * Source: https://github.com/circlefin/w3s-pw-web-sdk/blob/master/src/index.ts
 */
(function () {
  var SERVICE_URL = 'https://pw-auth.circle.com';
  var SDK_VERSION = '1.1.11';

  function W3SSdk(configs, onLoginComplete) {
    if (W3SSdk.instance != null) {
      W3SSdk.instance._setupInstance(configs, onLoginComplete);
      return W3SSdk.instance;
    }
    this._iframe = document.createElement('iframe');
    this._window = window;
    this._serviceUrl = SERVICE_URL;
    this._setupInstance(configs, onLoginComplete);
    W3SSdk.instance = this;
  }

  // --- Public API ---

  W3SSdk.prototype.setAppSettings = function (appSettings) {
    if (this._configs) {
      this._configs.appSettings = appSettings;
    } else {
      this._configs = { appSettings: appSettings };
    }
  };

  W3SSdk.prototype.setAuthentication = function (auth) {
    if (this._configs) {
      this._configs.authentication = auth;
    } else {
      this._configs = { appSettings: { appId: '' }, authentication: auth };
    }
  };

  W3SSdk.prototype.verifyOtp = function () {
    this._subscribeMessage();
    this._appendIframe(true, 'social/verify-email');
    // Arrow function keeps `this` bound to the SDK instance (no `self` alias).
    setTimeout(() => {
      if (!this._receivedResponseFromService) {
        if (this._onComplete) {
          this._onComplete({ code: 155706, message: 'Network error' }, undefined);
        }
      }
    }, 10000);
  };

  W3SSdk.prototype.execute = function (challengeId, onCompleted) {
    this._subscribeMessage();
    this._challenge = { challengeId: challengeId };
    // FIX (2026-09-27): the hosted UI (Create PIN → Verify ×2 → security
    // questions) MUST be visible. The real SDK calls `exec(onCompleted)` whose
    // `showIframe` defaults to TRUE (see @circle-fin/w3s-pw-web-sdk src/index.ts
    // line 277). This shim passed `false`, so the iframe was appended hidden
    // (`display:none`, 0×0). Circle's UI therefore never rendered — the user
    // saw no PIN prompt, and the challenge still resolved, so the app claimed
    // "Your PIN is set" while pinStatus stayed UNSET.
    this._exec(onCompleted, true);
  };

  W3SSdk.prototype.setOnForgotPin = function (onForgotPin, shouldCloseModalOnForgotPin) {
    this._shouldCloseModalOnForgotPin = shouldCloseModalOnForgotPin || false;
    // Arrow function keeps `this` bound to the SDK instance (no `self` alias).
    this._onForgotPin = () => {
      if (this._shouldCloseModalOnForgotPin) {
        this._closeModal();
      }
      if (onForgotPin) onForgotPin();
    };
  };

  W3SSdk.prototype.setOnResendOtpEmail = function (onResendOtpEmail) {
    this._onResendOtpEmail = onResendOtpEmail;
  };

  W3SSdk.prototype.getDeviceId = function () {
    // Arrow functions keep `this` bound to the SDK instance (no `self` alias).
    return new Promise((resolve, reject) => {
      this._resolveDeviceIdPromise = resolve;
      this._rejectDeviceIdPromise = reject;
      this._subscribeMessage();
      this._appendIframe(false, 'device-id');
      setTimeout(() => {
        if (!this._receivedResponseFromService) {
          if (this._rejectDeviceIdPromise) this._rejectDeviceIdPromise('Failed to receive deviceId');
          this._closeModal();
          this._unSubscribeMessage();
        }
      }, 10000);
    });
  };

  // --- Private methods ---

  W3SSdk.prototype._setupInstance = function (configs, onLoginComplete) {
    this._onLoginComplete = onLoginComplete;
    this._configs = configs;
    this._deviceInfo = { model: 'Web', version: SDK_VERSION };
    this._receivedResponseFromService = false;
    // Reset state
    this._challenge = undefined;
    this._onComplete = undefined;
    this._securityQuestions = undefined;
    this._securityQuestionsRequiredCount = 2;
    this._securityConfirmItems = undefined;
    this._socialLoginToken = undefined;
    this._socialLoginProvider = undefined;
  };

  W3SSdk.prototype._appendIframe = function (showIframe, subRoute) {
    subRoute = subRoute || '';
    var protocol = this._window.location.protocol;
    var host = this._window.location.host;
    var fullDomainWithProtocol = protocol + '//' + host;

    this._iframe.src = this._serviceUrl + '/' + subRoute + '?origin=' + encodeURIComponent(fullDomainWithProtocol);
    this._iframe.id = 'sdkIframe';
    this._iframe.width = showIframe ? '100%' : '0%';
    this._iframe.height = showIframe ? '100%' : '0%';
    this._iframe.style.zIndex = showIframe ? '2147483647' : '-1';
    this._iframe.style.display = 'none';

    if (showIframe) {
      this._iframe.style.position = 'fixed';
      this._iframe.style.top = '50%';
      this._iframe.style.left = '50%';
      this._iframe.style.transform = 'translate(-50%, -50%)';
      this._iframe.style.display = '';
    }

    document.body.appendChild(this._iframe);
  };

  W3SSdk.prototype._exec = function (onCompleted, showIframe = true) {
    this._appendIframe(showIframe);
    this._onComplete = onCompleted;
    // Arrow function keeps `this` bound to the SDK instance (no `self` alias).
    setTimeout(() => {
      if (!this._receivedResponseFromService) {
        if (this._onComplete) {
          this._onComplete({ code: 155706, message: 'Network error' }, undefined);
        }
      }
    }, 10000);
  };

  W3SSdk.prototype._closeModal = function () {
    var iframe = this._window.document.getElementById('sdkIframe');
    if (iframe && iframe.parentNode) {
      iframe.parentNode.removeChild(iframe);
    }
  };

  W3SSdk.prototype._subscribeMessage = function () {
    if (!this._boundHandler) {
      // Arrow function keeps `this` bound to the SDK instance (no `self` alias).
      this._boundHandler = (event) => { this._messageHandler(event); };
    }
    this._window.addEventListener('message', this._boundHandler, false);
  };

  W3SSdk.prototype._unSubscribeMessage = function () {
    if (this._boundHandler) {
      this._window.removeEventListener('message', this._boundHandler, false);
    }
  };

  W3SSdk.prototype._messageHandler = function (event) {
    if (event.origin !== this._serviceUrl) {
      return;
    }

    var data = event.data;
    if (!data) return;

    if (data.onFrameReady) {
      this._receivedResponseFromService = true;
      var iframe = this._window.document.getElementById('sdkIframe');
      if (iframe && iframe.contentWindow) {
        var lc = (this._configs && this._configs.loginConfigs) || {};
        var w3sPayload = {
          appSettings: this._configs ? this._configs.appSettings : undefined,
          auth: this._configs ? this._configs.authentication : undefined,
          challenge: this._challenge,
          customizations: {
            securityQuestions: {
              questions: this._securityQuestions,
              requiredCount: this._securityQuestionsRequiredCount,
              securityConfirmItems: this._securityConfirmItems
            },
            themeColor: undefined,
            localizations: undefined,
            resources: undefined,
            customLinks: undefined,
            ssoSettings: undefined
          },
          deviceInfo: this._deviceInfo
        };
        // CONDITIONAL: only send verification data relevant to the CURRENT
        // flow. OTP verify needs emailVerification; social login needs
        // socialVerification. Sending BOTH with empty values confuses the
        // Circle hosted UI (blank skeleton state).
        if (this._challenge) {
          // Challenge execution (create wallet / PIN setup / tx sign)
          // → no verification context needed
        } else if (lc.otpToken) {
          // Email OTP verification flow
          w3sPayload.emailVerification = {
            deviceToken: lc.deviceToken,
            deviceEncryptionKey: lc.deviceEncryptionKey,
            otpToken: lc.otpToken
          };
        } else if (lc.deviceToken) {
          // Social login flow
          w3sPayload.socialVerification = {
            token: this._socialLoginToken,
            deviceToken: lc.deviceToken,
            deviceEncryptionKey: lc.deviceEncryptionKey,
            socialLoginProvider: this._socialLoginProvider
          };
        }
        iframe.contentWindow.postMessage({ w3s: w3sPayload }, this._serviceUrl);
      }
    } else if (data.onForgotPin) {
      if (this._onForgotPin) this._onForgotPin();
    } else if (data.onComplete) {
      var iframe2 = this._window.document.getElementById('sdkIframe');
      if (iframe2 && iframe2.parentNode) iframe2.parentNode.removeChild(iframe2);
      // FIX: Circle sends `{ onComplete: true }` with NO result when the hosted
      // UI was dismissed, failed to render, or the user closed it. The old code
      // passed that straight through as a SUCCESS, so the app toasted
      // "Your PIN is set" while no PIN was set and no wallet existed. Treat an
      // empty/absent result as a failure so callers can fall back correctly.
      var res = data.result;
      var looksEmpty = !res || (typeof res === 'object' && Object.keys(res).length === 0);
      if (looksEmpty) {
        if (this._onComplete) {
          this._onComplete({ code: 155706, message: 'Challenge not completed' }, undefined);
        }
      } else {
        if (this._onComplete) this._onComplete(undefined, res);
      }
    } else if (data.deviceId) {
      if (this._resolveDeviceIdPromise) this._resolveDeviceIdPromise(data.deviceId);
      this._closeModal();
      this._unSubscribeMessage();
    } else if (data.showUi) {
      this._iframe.width = '100%';
      this._iframe.height = '100%';
      this._iframe.style.zIndex = '2147483647';
      this._iframe.style.position = 'fixed';
      this._iframe.style.top = '50%';
      this._iframe.style.left = '50%';
      this._iframe.style.transform = 'translate(-50%, -50%)';
      this._iframe.style.display = '';
    } else if (data.onSocialLoginVerified) {
      if (this._onLoginComplete) {
        this._onLoginComplete(data.onSocialLoginVerified.error, data.onSocialLoginVerified.result);
      }
      this._closeModal();
      this._unSubscribeMessage();
    } else if (data.onEmailLoginVerified) {
      if (this._onLoginComplete) {
        this._onLoginComplete(data.onEmailLoginVerified.error, data.onEmailLoginVerified.result);
      }
      if (data.onEmailLoginVerified.result && !data.onEmailLoginVerified.error) {
        this._unSubscribeMessage();
        this._closeModal();
      }
    } else if (data.onResendOtpEmail) {
      if (this._onResendOtpEmail) this._onResendOtpEmail();
    } else if (data.onError) {
      if (this._onComplete) this._onComplete(data.error, undefined);
    } else if (data.onClose) {
      this._closeModal();
      this._unSubscribeMessage();
    }
  };

  window.W3SSdk = W3SSdk;
})();
