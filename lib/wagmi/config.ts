import { createConfig, http } from 'wagmi';
import { base, avalanche } from 'wagmi/chains';
import { injected, coinbaseWallet } from 'wagmi/connectors';
import type { Chain } from 'viem';

/**
 * NOTE: the live frontend does NOT use this config — the public/ SPA loads
 * `public/wallet-bridge.js`, which resolves the chain at runtime from
 * `/config.js` (see wallet-bridge/entry.tsx). This module is kept for the
 * Next-rendered routes, and is env-driven for the same reason: it used to
 * hardcode Arc Testnet (5042002) + rpc.testnet.arc.network, which is dead and
 * silently pointed external wallets at the wrong network on a mainnet deploy.
 *
 * Client-side values must be NEXT_PUBLIC_* to be inlined at build time.
 * Defaults are MAINNET, matching production.
 */
const ARC_CHAIN_ID = Number(process.env.NEXT_PUBLIC_ARC_CHAIN_ID ?? 5042);
const ARC_RPC_URL = process.env.NEXT_PUBLIC_ARC_RPC_URL ?? 'https://rpc.mainnet.arc.io';
const ARC_CHAIN_NAME = process.env.NEXT_PUBLIC_ARC_CHAIN_NAME ?? 'Arc';

const arcChain = {
  id: ARC_CHAIN_ID,
  name: ARC_CHAIN_NAME,
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
  rpcUrls: {
    default: { http: [ARC_RPC_URL] },
  },
} as unknown as Chain;

// Declare config type for wagmi
declare module 'wagmi' {
  interface Register {
    config: typeof config;
  }
}

/**
 * Wagmi config for SlimeMarket
 *
 * Uses FREE wallet connection methods (no WalletConnect subscription needed):
 * - injected(): MetaMask, Coinbase, Brave Wallet, Trust Wallet, etc. (via EIP-6963)
 * - coinbaseWallet(): Coinbase Wallet SDK (free, includes mobile)
 *
 * Supported wallets:
 * - MetaMask (browser extension)
 * - Coinbase Wallet (browser extension + mobile via SDK)
 * - Brave Wallet (built-in)
 * - Trust Wallet (browser extension)
 * - Rainbow (browser extension)
 * - Any wallet supporting EIP-6963
 */
export const config = createConfig({
  chains: [arcChain, base, avalanche] as const,
  connectors: [
    injected(), // EIP-6963 auto-detected wallets (MetaMask, Brave, Trust, Rainbow, etc.)
    coinbaseWallet({
      appName: 'SlimeMarket',
    }),
  ],
  transports: {
    [ARC_CHAIN_ID]: http(ARC_RPC_URL),
    [base.id]: http(),
    [avalanche.id]: http(),
  },
} as any);
