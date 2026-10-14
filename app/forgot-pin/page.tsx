'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';

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

export default function RecoveryHubPage() {
  const router = useRouter();
  const [loading, setLoading] = useState<number | null>(null);

  const handleCircleRestore = () => {
    setLoading(1);
    // Redirect to login with pin-restore flag
    window.location.href = '/?pin-restore=true';
  };

  const handleRecoveryWallet = () => {
    setLoading(2);
    router.push('/recovery/wallet');
  };

  const handleContactSupport = () => {
    window.location.href = 'mailto:support@slimemarket.app?subject=Account%20Recovery%20Help';
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ background: 'linear-gradient(135deg, #060A14 0%, #0C1322 50%, #111C33 100%)' }}
    >
      <div className="w-full max-w-lg" style={{ animation: 'fadeIn 0.4s ease-out' }}>
        {/* Header */}
        <div className="flex flex-col items-center mb-8">
          <SlimeLogo size={56} />
          <h1
            className="text-2xl font-bold text-white mt-4"
            style={{ fontFamily: 'Space Grotesk, sans-serif' }}
          >
            Slime<span style={{ color: '#38BDF8' }}>Market</span>
          </h1>
          <p className="text-xs mt-1" style={{ color: '#5A6B8C', fontFamily: 'JetBrains Mono, monospace' }}>
            ARC ESCROW · TRUSTLESS
          </p>
        </div>

        {/* Recovery Hub Card */}
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
            Account Recovery
          </h2>
          <p className="text-sm mb-6" style={{ color: '#8A9BB8' }}>
            Choose the path that matches your situation. Your funds are safe — recovery paths only restore access, they never move assets.
          </p>

          {/* Option 1: Forgot PIN */}
          <div
            className="rounded-xl p-5 mb-4 cursor-pointer transition-all duration-200 hover:brightness-110"
            style={{ background: 'rgba(17, 28, 51, 0.5)', border: '1px solid #1C2740' }}
            onClick={handleCircleRestore}
          >
            <div className="flex items-start gap-4">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center text-lg shrink-0"
                style={{ background: 'rgba(47, 107, 255, 0.15)' }}
              >
                🔐
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-white mb-1">Forgot your PIN?</h3>
                <p className="text-xs mb-3" style={{ color: '#8A9BB8', lineHeight: 1.5 }}>
                  You still have access to your email. Reset your wallet PIN through Circle&apos;s secure recovery flow using your security questions.
                </p>
                <button
                  disabled={loading === 1}
                  className="text-xs font-medium px-4 py-2 rounded-lg transition-all duration-200 disabled:opacity-50"
                  style={{
                    background: loading === 1 ? '#1E4FD9' : '#2F6BFF',
                    color: '#FFFFFF',
                  }}
                >
                  {loading === 1 ? 'Redirecting...' : 'Reset via Circle'}
                </button>
              </div>
            </div>
          </div>

          {/* Option 2: Lost Email */}
          <div
            className="rounded-xl p-5 mb-4 cursor-pointer transition-all duration-200 hover:brightness-110"
            style={{ background: 'rgba(17, 28, 51, 0.5)', border: '1px solid #1C2740' }}
            onClick={handleRecoveryWallet}
          >
            <div className="flex items-start gap-4">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center text-lg shrink-0"
                style={{ background: 'rgba(16, 185, 129, 0.15)' }}
              >
                🔗
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-white mb-1">Lost access to email?</h3>
                <p className="text-xs mb-3" style={{ color: '#8A9BB8', lineHeight: 1.5 }}>
                  You have a linked recovery wallet (MetaMask, Coinbase, or any EOA). Sign a message to regain account access.
                </p>
                <button
                  disabled={loading === 2}
                  className="text-xs font-medium px-4 py-2 rounded-lg transition-all duration-200 disabled:opacity-50"
                  style={{
                    background: loading === 2 ? '#047857' : '#10b981',
                    color: '#FFFFFF',
                  }}
                >
                  {loading === 2 ? 'Loading...' : 'Use Recovery Wallet'}
                </button>
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="flex items-center gap-3 my-5">
            <div className="flex-1 h-px" style={{ background: '#1C2740' }} />
            <span className="text-xs" style={{ color: '#5A6B8C' }}>or</span>
            <div className="flex-1 h-px" style={{ background: '#1C2740' }} />
          </div>

          {/* Option 3: Contact Support */}
          <div
            className="rounded-xl p-5 cursor-pointer transition-all duration-200 hover:brightness-110"
            style={{ background: 'rgba(17, 28, 51, 0.5)', border: '1px solid #1C2740' }}
            onClick={handleContactSupport}
          >
            <div className="flex items-start gap-4">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center text-lg shrink-0"
                style={{ background: 'rgba(245, 158, 11, 0.15)' }}
              >
                🆘
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-white mb-1">Stuck on both?</h3>
                <p className="text-xs mb-3" style={{ color: '#8A9BB8', lineHeight: 1.5 }}>
                  No recovery wallet linked and no email access. Contact our support team for identity verification and manual assistance.
                </p>
                <button
                  className="text-xs font-medium px-4 py-2 rounded-lg transition-all duration-200"
                  style={{ background: 'transparent', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.3)' }}
                >
                  Contact Support
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 text-center">
          <button
            onClick={() => router.push('/')}
            className="text-xs transition hover:underline"
            style={{ color: '#8A9BB8' }}
          >
            ← Back to Login
          </button>
        </div>

        {/* Security Note */}
        <p className="text-center text-[10px] mt-4" style={{ color: '#5A6B8C' }}>
          🔒 Recovery paths use cryptographically secure challenges. No private keys are ever transmitted.
        </p>
      </div>
    </div>
  );
}
