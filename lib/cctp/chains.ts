import { createPublicClient, http, getAddress, isAddress, pad, type Address, type Hex } from "viem";

/**
 * CCTP v2 source-chain registry for paying into Arc.
 *
 * WHY THIS FILE EXISTS
 * Buyers hold USDC on other chains. To pay an Arc escrow they must get that USDC
 * onto Arc. For buyers with an external wallet that is the App Kit bridge
 * (`app-kit-bridge/entry.ts`). For email-login (UCW) buyers the bridge is
 * unusable — it needs an EIP-1193 provider — so we drive CCTP directly with
 * CONTRACT_EXECUTION challenges signed by the user's PIN.
 *
 * EVERY VALUE BELOW WAS READ OUT OF `@circle-fin/provider-cctp-v2`, NOT TYPED
 * FROM MEMORY. CCTP v2 deploys its contracts through a deterministic factory, so
 * TokenMessengerV2 / MessageTransmitterV2 have the SAME address on every chain of
 * a given network tier. Only the domain, chain id, USDC address and RPC differ
 * per chain. That is why those two are tier constants rather than per-chain
 * fields — and why a copy-paste slip is much less likely.
 *
 * Verified 2026-10-07 against `@circle-fin/provider-cctp-v2` (installed).
 * If Circle redeploys, re-extract rather than trusting this table:
 *
 *   node -e "const s=require('fs').readFileSync('node_modules/@circle-fin/provider-cctp-v2/index.cjs','utf8');
 *            console.log(s.match(/tokenMessenger: '0x[0-9a-fA-F]+'/g).slice(0,4))"
 */

import { IS_ARC_MAINNET, ARC_CCTP_DOMAIN } from "@/lib/arc";

/** CCTP v2 TokenMessenger — deterministic address per network tier. */
export const CCTP_TOKEN_MESSENGER_V2 = (IS_ARC_MAINNET
  ? "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"
  : "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA") as Address;

/** CCTP v2 MessageTransmitter — deterministic address per network tier. */
export const CCTP_MESSAGE_TRANSMITTER_V2 = (IS_ARC_MAINNET
  ? "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64"
  : "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275") as Address;

/**
 * Circle's attestation service (Iris).
 *
 * Sandbox and production are SEPARATE HOSTS — a sandbox attestation is useless
 * against a mainnet MessageTransmitter and vice versa. Derived from the Arc
 * network so the two can never drift apart.
 */
export const IRIS_API_BASE = IS_ARC_MAINNET
  ? "https://iris-api.circle.com"
  : "https://iris-api-sandbox.circle.com";

export interface CctpSourceChain {
  /** Stable key used in API bodies and the DB. */
  key: string;
  /** Human label for the UI. */
  label: string;
  /** Circle SDK / UCW blockchain string (used when provisioning wallets). */
  circleBlockchain: string;
  chainId: number;
  cctpDomain: number;
  usdc: Address;
  rpcUrl: string;
  explorerUrl: string;
  nativeSymbol: string;
  /**
   * True when the chain has no Fast Transfer support, so a CCTP transfer must
   * request Standard (Bridge Kit surfaces this as `transferSpeed: "SLOW"`).
   * Every chain in this table is standard-only today.
   */
  standardOnly: boolean;
}

const TESTNET_CHAINS: Record<string, CctpSourceChain> = {
  ethereumSepolia: {
    key: "ethereumSepolia",
    label: "Ethereum Sepolia",
    circleBlockchain: "ETH-SEPOLIA",
    chainId: 11155111,
    cctpDomain: 0,
    usdc: getAddress("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"),
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    explorerUrl: "https://sepolia.etherscan.io",
    nativeSymbol: "ETH",
    standardOnly: true,
  },
  avalancheFuji: {
    key: "avalancheFuji",
    label: "Avalanche Fuji",
    circleBlockchain: "AVAX-FUJI",
    chainId: 43113,
    cctpDomain: 1,
    usdc: getAddress("0x5425890298aed601595a70ab815c96711a31bc65"),
    rpcUrl: "https://api.avax-test.network/ext/bc/C/rpc",
    explorerUrl: "https://testnet.snowtrace.io",
    nativeSymbol: "AVAX",
    standardOnly: true,
  },
  arbitrumSepolia: {
    key: "arbitrumSepolia",
    label: "Arbitrum Sepolia",
    circleBlockchain: "ARB-SEPOLIA",
    chainId: 421614,
    cctpDomain: 3,
    usdc: getAddress("0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"),
    rpcUrl: "https://sepolia-rollup.arbitrum.io/rpc",
    explorerUrl: "https://sepolia.arbiscan.io",
    nativeSymbol: "ETH",
    standardOnly: true,
  },
  baseSepolia: {
    key: "baseSepolia",
    label: "Base Sepolia",
    circleBlockchain: "BASE-SEPOLIA",
    chainId: 84532,
    cctpDomain: 6,
    usdc: getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
    rpcUrl: "https://sepolia.base.org",
    explorerUrl: "https://sepolia.basescan.org",
    nativeSymbol: "ETH",
    standardOnly: true,
  },
};

const MAINNET_CHAINS: Record<string, CctpSourceChain> = {
  ethereum: {
    key: "ethereum",
    label: "Ethereum",
    circleBlockchain: "ETH",
    chainId: 1,
    cctpDomain: 0,
    usdc: getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    explorerUrl: "https://etherscan.io",
    nativeSymbol: "ETH",
    standardOnly: false,
  },
  avalanche: {
    key: "avalanche",
    label: "Avalanche",
    circleBlockchain: "AVAX",
    chainId: 43114,
    cctpDomain: 1,
    usdc: getAddress("0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"),
    rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    explorerUrl: "https://snowtrace.io",
    nativeSymbol: "AVAX",
    standardOnly: true,
  },
  arbitrum: {
    key: "arbitrum",
    label: "Arbitrum One",
    circleBlockchain: "ARB",
    chainId: 42161,
    cctpDomain: 3,
    usdc: getAddress("0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    explorerUrl: "https://arbiscan.io",
    nativeSymbol: "ETH",
    standardOnly: false,
  },
  base: {
    key: "base",
    label: "Base",
    circleBlockchain: "BASE",
    chainId: 8453,
    cctpDomain: 6,
    usdc: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    rpcUrl: "https://mainnet.base.org",
    explorerUrl: "https://basescan.org",
    nativeSymbol: "ETH",
    standardOnly: false,
  },
};

/** Source chains available on the active network. */
export const CCTP_SOURCE_CHAINS: Record<string, CctpSourceChain> = IS_ARC_MAINNET
  ? MAINNET_CHAINS
  : TESTNET_CHAINS;

export const CCTP_SOURCE_CHAIN_KEYS: string[] = Object.keys(CCTP_SOURCE_CHAINS);

/** Look up a source chain, or null when the key is unknown on this network. */
export function cctpSourceChain(key: string | null | undefined): CctpSourceChain | null {
  if (!key) return null;
  return CCTP_SOURCE_CHAINS[key] ?? null;
}

/**
 * CCTP encodes the destination recipient as a `bytes32` (left-padded), because
 * the same message format carries non-EVM addresses. Passing a bare 20-byte
 * address makes `depositForBurn` revert with a generic error that is painful to
 * diagnose, so this validates rather than truncating.
 */
export function toMintRecipient(address: string): Hex {
  if (!isAddress(address)) {
    throw new Error(`toMintRecipient: not a valid EVM address: ${address}`);
  }
  return pad(getAddress(address), { size: 32 });
}

/** Read-only client for a source chain (used to verify burn txs). */
export function cctpSourcePublicClient(chain: CctpSourceChain) {
  return createPublicClient({
    chain: {
      id: chain.chainId,
      name: chain.label,
      nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: 18 },
      rpcUrls: { default: { http: [chain.rpcUrl] } },
    },
    transport: http(chain.rpcUrl),
  });
}

/**
 * The Arc side of a CCTP transfer, as consumed by the relay step.
 * Domain 26 on BOTH Arc testnet and mainnet (verified from the SDK).
 */
export const ARC_CCTP = {
  domain: ARC_CCTP_DOMAIN,
  messageTransmitter: CCTP_MESSAGE_TRANSMITTER_V2,
} as const;
