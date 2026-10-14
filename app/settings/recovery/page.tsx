'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface RecoveryWallet {
  id: string;
  address: string;
  chainId: number;
  label: string | null;
  linkedAt: string;
  lastUsedAt: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function SlimeLogo({ size = 40 }: { size?: number }) {
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

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
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

export default function SettingsRecoveryPage() {
  const router = useRouter();
  const [wallets, setWallets] = useState<RecoveryWallet[]>([]);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  /** Load recovery wallets. */
  const loadWallets = useCallback(async () => {
    try {
      const res = await fetch('/api/me/recovery-wallet');
      if (!res.ok) {
        if (res.status === 401) {
          router.push('/');
          return;
        }
        throw new Error('Failed to load recovery wallets.');
      }
      const data = await res.json();
      setWallets(data.wallets || []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    loadWallets();
  }, [loadWallets]);

  /** Link a new recovery wallet. */
  const handleLink = async () => {
    setLinking(true);
    setError(null);
    setSuccess(null);
    try {
      // 1. Connect wallet
      const address = await connectWallet();

      // 2. Request link challenge
      const challengeRes = await fetch('/api/auth/recovery/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, purpose: 'link_wallet' }),
      });
      if (!challengeRes.ok) {
        const err = await challengeRes.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to request link challenge.');
      }
      const challenge = await challengeRes.json();

      // 3. Sign message
      const signature = await signMessage(address, challenge.message);

      // 4. Link wallet
      const linkRes = await fetch('/api/me/recovery-wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, nonce: challenge.nonce, signature }),
      });
      if (!linkRes.ok) {
        const err = await linkRes.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to link wallet.');
      }

      setSuccess(`Recovery wallet ${truncateAddress(address)} linked successfully.`);
      await loadWallets();
    } catch (e: any) {
      setError(e.message || 'Failed to link wallet.');
    } finally {
      setLinking(false);
    }
  };

  /** Unlink a recovery wallet. */
  const handleUnlink = async (address: string) => {
    if (!confirm('Are you sure you want to remove this recovery wallet? You will not be able to recover your account with it anymore.')) {
      return;
    }
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch('/api/me/recovery-wallet', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to unlink wallet.');
      }
      setSuccess(`Recovery wallet ${truncateAddress(address)} removed.`);
      await loadWallets();
    } catch (e: any) {
      setError(e.message || 'Failed to unlink wallet.');
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ background: 'linear-gradient(135deg, #060A14 0%, #0C1322 50%, #111C33 100%)' }}
    >
      <div className="w-full max-w-lg" style={{ animation: 'fadeIn 0.4s ease-out' }}>
        {/* Header */}
        <div className="flex flex-col items-center mb-8">
          <SlimeLogo size={48} />
          <h1 className="text-2xl font-bold text-white mt-4" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>
            Slime<span style={{ color: '#38BDF8' }}>Market</span>
          </h1>
          <p className="text-xs mt-1" style={{ color: '#5A6B8C', fontFamily: 'JetBrains Mono, monospace' }}>
            ACCOUNT SETTINGS
          </p>
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
            Recovery Wallets
          </h2>
          <p className="text-sm mb-6" style={{ color: '#8A9BB8' }}>
            External wallets that can restore access to your account if you lose your email.
          </p>

          {/* Warning if no wallets */}
          {wallets.length === 0 && !loading && (
            <div
              className="rounded-xl p-4 mb-6 flex items-start gap-3"
              style={{ background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.2)' }}
            >
              <span className="text-lg">⚠️</span>
              <div>
                <p className="text-sm font-medium" style={{ color: '#fbbf24' }}>
                  No recovery wallet linked
                </p>
                <p className="text-xs mt-1" style={{ color: '#d97706' }}>
                  If you lose access to your email, you will have no way to recover your account. Link a wallet now.
                </p>
              </div>
            </div>
          )}

          {/* Success / Error banners */}
          {success && (
            <div
              className="mb-4 p-3 rounded-xl text-sm flex items-start gap-2.5"
              style={{
                background: 'rgba(16, 185, 129, 0.1)',
                border: '1px solid rgba(16, 185, 129, 0.3)',
                color: '#6ee7b7',
              }}
            >
              <span>✅</span>
              <span className="flex-1">{success}</span>
            </div>
          )}
          {error && (
            <div
              className="mb-4 p-3 rounded-xl text-sm flex items-start gap-2.5"
              style={{
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#fca5a5',
              }}
            >
              <span>⚠️</span>
              <span className="flex-1">{error}</span>
            </div>
          )}

          {/* Wallet List */}
          {loading ? (
            <div className="text-center py-8">
              <div className="text-2xl animate-spin inline-block">⏳</div>
              <p className="text-xs mt-2" style={{ color: '#5A6B8C' }}>Loading...</p>
            </div>
          ) : wallets.length > 0 ? (
            <div className="space-y-3 mb-6">
              {wallets.map((wallet) => (
                <div
                  key={wallet.id}
                  className="rounded-xl p-4 flex items-center justify-between"
                  style={{ background: 'rgba(17, 28, 51, 0.5)', border: '1px solid #1C2740' }}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-9 h-9 rounded-lg flex items-center justify-center text-lg"
                      style={{ background: 'rgba(16, 185, 129, 0.15)' }}
                    >
                      🔗
                    </div>
                    <div>
                      <p className="text-sm font-medium text-white font-mono">
                        {truncateAddress(wallet.address)}
                      </p>
                      <p className="text-[10px]" style={{ color: '#5A6B8C' }}>
                        Linked {formatDate(wallet.linkedAt)}
                        {wallet.lastUsedAt && ` · Last used ${formatDate(wallet.lastUsedAt)}`}
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleUnlink(wallet.address)}
                    className="text-xs px-3 py-1.5 rounded-lg transition-all duration-200 hover:opacity-80"
                    style={{ color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)' }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          {/* Link New Wallet Button */}
          <button
            onClick={handleLink}
            disabled={linking}
            className="w-full h-11 rounded-xl font-medium text-sm transition-all duration-200 disabled:opacity-50 flex items-center justify-center gap-2"
            style={{ background: '#2F6BFF', color: '#FFFFFF' }}
          >
            {linking ? (
              <>
                <span className="animate-spin">⏳</span>
                Connecting...
              </>
            ) : (
              <>
                <span>+</span>
                Link Recovery Wallet
              </>
            )}
          </button>

          {/* Info box */}
          <div
            className="mt-4 rounded-lg p-3"
            style={{ background: 'rgba(17, 28, 51, 0.4)', border: '1px solid #1C2740' }}
          >
            <p className="text-[11px]" style={{ color: '#5A6B8C', lineHeight: 1.6 }}>
              <strong style={{ color: '#8A9BB8' }}>How it works:</strong> When you link a wallet, you prove ownership by signing a message. Later, if you lose email access, you can sign a recovery message with the same wallet to log back in. Your funds remain secured by Circle — this only restores account data access.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 text-center">
          <button
            onClick={() => router.push('/')}
            className="text-xs transition hover:underline"
            style={{ color: '#8A9BB8' }}
          >
            ← Back to Dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
