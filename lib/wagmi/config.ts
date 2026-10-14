import { createConfig, http } from 'wagmi';
import { base, avalanche } from 'wagmi/chains';
import { injected, coinbaseWallet } from 'wagmi/connectors';

// Arc Testnet custom chain
const arcTestnet = {
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.arc.network'] },
  },
} as const;

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
  chains: [arcTestnet, base, avalanche],
  connectors: [
    injected(), // EIP-6963 auto-detected wallets (MetaMask, Brave, Trust, Rainbow, etc.)
    coinbaseWallet({
      appName: 'SlimeMarket',
    }),
  ],
  transports: {
    [arcTestnet.id]: http('https://rpc.testnet.arc.network'),
    [base.id]: http(),
    [avalanche.id]: http(),
  },
});
