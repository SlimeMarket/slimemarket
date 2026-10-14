'use client';

import React, { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type Step = 'connect' | 'sign' | 'verify' | 'success' | 'error';

interface RecoveryState {
  step: Step;
  address: string | null;
  nonce: string | null;
  message: string | null;
  error: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function SlimeLogo({ size = 48 }: { size?: number }) {
  return (
    <div style={{ width: size, height: size }} className="flex items-center justify-center">
      <svg width={size} height={size} viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="50" cy="50" r="45" fill="url(#slime-grad)" />
        <defs>
          <linearGradient id="slime-grad" x1="0" y1="0" x2="100" y2="100">
            <stop stopColor="#6366f1" />
            <stop offset="1" stopColor="#22d3ee" />
          </linearGradient>
        </defs>
        <text x="50" y="62" textAnchor="middle" fill="white" fontSize="40" fontWeight="bold" fontFamily="monospace">S</text>
      </svg>
    </div>
  );
}

/** Prompt MetaMask / injected wallet to connect. */
async function connectWallet(): Promise<string> {
  const ethereum = (window as any).ethereum;
  if (!ethereum) {
    throw new Error('No Ethereum wallet detected. Please install MetaMask or a compatible wallet.');
  }
  const accounts: string[] = await ethereum.request({ method: 'eth_requestAccounts' });
  if (!accounts || accounts.length === 0) {
    throw new Error('Wallet connection rejected.');
  }
  return accounts[0];
}

/** Ask the wallet to sign a message (EIP-191 personal_sign). */
async function signMessage(address: string, message: string): Promise<string> {
  const ethereum = (window as any).ethereum;
  if (!ethereum) throw new Error('Wallet disconnected.');
  const signature: string = await ethereum.request({
    method: 'personal_sign',
    params: [message, address],
  });
  return signature;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                 */
/* -------------------------------------------------------------------------- */

export default function RecoveryWalletPage() {
  const router = useRouter();
  const [state, setState] = useState<RecoveryState>({
    step: 'connect',
    address: null,
    nonce: null,
    message: null,
    error: null,
  });
  const [loading, setLoading] = useState(false);

  const update = useCallback((patch: Partial<RecoveryState>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  /** Step 1 — Connect wallet. */
  const handleConnect = async () => {
    setLoading(true);
    try {
      const address = await connectWallet();
      update({ step: 'sign', address, error: null });
    } catch (e: any) {
      update({ error: e.message || 'Failed to connect wallet.' });
    } finally {
      setLoading(false);
    }
  };

  /** Step 2 — Request challenge + sign. */
  const handleSign = async () => {
    if (!state.address) return;
    setLoading(true);
    try {
      // 1. Request nonce challenge from server
      const challengeRes = await fetch('/api/auth/recovery/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: state.address, purpose: 'recovery_login' }),
      });
      if (!challengeRes.ok) {
        const err = await challengeRes.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to request recovery challenge.');
      }
      const challenge = await challengeRes.json();

      // 2. Sign the message with the wallet
      const signature = await signMessage(state.address, challenge.message);

      update({
        step: 'verify',
        nonce: challenge.nonce,
        message: challenge.message,
        error: null,
      });

      // 3. Verify with server
      const verifyRes = await fetch('/api/auth/recovery/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: state.address,
          nonce: challenge.nonce,
          signature,
        }),
      });
      if (!verifyRes.ok) {
        const err = await verifyRes.json().catch(() => ({}));
        throw new Error(err.error || 'Signature verification failed.');
      }
      const result = await verifyRes.json();

      if (result.recovered) {
        update({ step: 'success', error: null });
      } else {
        throw new Error('Recovery failed. This wallet may not be linked to an account.');
      }
    } catch (e: any) {
      update({ step: 'error', error: e.message || 'Recovery failed.' });
    } finally {
      setLoading(false);
    }
  };

  /** Navigate to dashboard after successful recovery. */
  const handleContinue = () => {
    window.location.href = '/';
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ background: 'linear-gradient(135deg, #060A14 0%, #0C1322 50%, #111C33 100%)' }}
    >
      <div className="w-full max-w-md" style={{ animation: 'fadeIn 0.4s ease-out' }}>
        {/* Header */}
        <div className="flex flex-col items-center mb-8">
          <SlimeLogo size={56} />
          <h1 className="text-2xl font-bold text-white mt-4" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>
            Slime<span style={{ color: '#38BDF8' }}>Market</span>
          </h1>
        </div>

        {/* Card */}
        <div
          className="rounded-2xl p-8"
          style={{
            background: 'rgba(12, 19, 34, 0.6)',
            backdropFilter: 'blur(12px)',
            border: '1px solid #1C2740',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
          }}
        >
          <h2 className="text-lg font-bold text-white mb-2" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>
            Recovery Wallet Login
          </h2>
          <p className="text-sm mb-6" style={{ color: '#8A9BB8' }}>
            Sign a message with your linked recovery wallet to restore account access.
          </p>

          {/* Error Banner */}
          {state.error && (
            <div
              className="mb-4 p-3 rounded-xl text-sm flex items-start gap-2.5"
              style={{
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#fca5a5',
              }}
            >
              <span>⚠️</span>
              <span className="flex-1">{state.error}</span>
            </div>
          )}

          {/* Step: Connect */}
          {state.step === 'connect' && (
            <div className="space-y-4">
              <div
                className="rounded-xl p-5 text-center"
                style={{ background: 'rgba(17, 28, 51, 0.5)', border: '1px solid #1C2740' }}
              >
                <div className="text-3xl mb-3">🦊</div>
                <h3 className="text-sm font-semibold text-white mb-2">Connect Your Wallet</h3>
                <p className="text-xs mb-4" style={{ color: '#8A9BB8' }}>
                  Connect the MetaMask or EOA wallet you previously linked as a recovery method.
                </p>
                <button
                  onClick={handleConnect}
                  disabled={loading}
                  className="w-full h-11 rounded-xl font-medium text-sm transition-all duration-200 disabled:opacity-50"
                  style={{ background: '#2F6BFF', color: '#FFFFFF' }}
                >
                  {loading ? 'Connecting...' : 'Connect Wallet'}
                </button>
              </div>
            </div>
          )}

          {/* Step: Sign */}
          {state.step === 'sign' && state.address && (
            <div className="space-y-4">
              <div
                className="rounded-xl p-5"
                style={{ background: 'rgba(17, 28, 51, 0.5)', border: '1px solid #1C2740' }}
              >
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-xs font-mono" style={{ color: '#10b981' }}>
                    {state.address.slice(0, 6)}...{state.address.slice(-4)}
                  </span>
                </div>
                <h3 className="text-sm font-semibold text-white mb-2">Sign Recovery Message</h3>
                <p className="text-xs mb-4" style={{ color: '#8A9BB8' }}>
                  You will be asked to sign a message proving ownership of this wallet. This does not spend any gas or move funds.
                </p>
                <button
                  onClick={handleSign}
                  disabled={loading}
                  className="w-full h-11 rounded-xl font-medium text-sm transition-all duration-200 disabled:opacity-50"
                  style={{ background: '#10b981', color: '#FFFFFF' }}
                >
                  {loading ? 'Processing...' : 'Sign & Verify'}
                </button>
              </div>
            </div>
          )}

          {/* Step: Verify */}
          {state.step === 'verify' && (
            <div className="space-y-4 text-center py-8">
              <div className="text-4xl mb-4 animate-spin">⏳</div>
              <h3 className="text-sm font-semibold text-white">Verifying signature...</h3>
              <p className="text-xs" style={{ color: '#8A9BB8' }}>
                Please wait while we verify your wallet signature.
              </p>
            </div>
          )}

          {/* Step: Success */}
          {state.step === 'success' && (
            <div className="space-y-4">
              <div
                className="rounded-xl p-5 text-center"
                style={{ background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.3)' }}
              >
                <div className="text-4xl mb-3">✅</div>
                <h3 className="text-sm font-semibold text-white mb-2">Recovery Successful</h3>
                <p className="text-xs mb-4" style={{ color: '#8A9BB8' }}>
                  Your account access has been restored. You can now view your orders, store, and history.
                </p>
                <div
                  className="rounded-lg p-3 mb-4 text-left"
                  style={{ background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.2)' }}
                >
                  <p className="text-xs" style={{ color: '#fbbf24' }}>
                    ⚠️ <strong>Limitation:</strong> Actions that sign with your Slime Wallet (sending USDC, checkout) still require a normal email-code login through Circle.
                  </p>
                </div>
                <button
                  onClick={handleContinue}
                  className="w-full h-11 rounded-xl font-medium text-sm transition-all duration-200"
                  style={{ background: '#10b981', color: '#FFFFFF' }}
                >
                  Continue to Dashboard
                </button>
              </div>
            </div>
          )}

          {/* Step: Error */}
          {state.step === 'error' && (
            <div className="space-y-4">
              <div
                className="rounded-xl p-5 text-center"
                style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)' }}
              >
                <div className="text-4xl mb-3">❌</div>
                <h3 className="text-sm font-semibold text-white mb-2">Recovery Failed</h3>
                <p className="text-xs mb-4" style={{ color: '#8A9BB8' }}>
                  {state.error || 'This wallet is not linked to any account, or the signature could not be verified.'}
                </p>
                <button
                  onClick={() => update({ step: 'connect', address: null, nonce: null, message: null, error: null })}
                  className="w-full h-11 rounded-xl font-medium text-sm transition-all duration-200"
                  style={{ background: '#2F6BFF', color: '#FFFFFF' }}
                >
                  Try Again
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 text-center space-y-2">
          <button
            onClick={() => router.push('/forgot-pin')}
            className="text-xs transition hover:underline block w-full"
            style={{ color: '#8A9BB8' }}
          >
            ← Back to Recovery Options
          </button>
        </div>
      </div>
    </div>
  );
}
