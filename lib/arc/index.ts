import { getAddress, isAddress, createPublicClient, http, type Hex } from "viem";
import { arc } from "viem/chains";

/**
 * Arc network config (source: docs.arc.io/arc/references/rpc-endpoints).
 *
 * MAINNET vs TESTNET is selected entirely by env, because the two differ in ways
 * that would silently break money if hardcoded:
 *
 *   chain id      5042 (mainnet)   vs  5042002 (testnet)
 *   RPC           rpc.mainnet.arc.io  vs  rpc.testnet.arc.io
 *   Circle chain  ARC              vs  ARC-TESTNET
 *
 * A wrong chain id means signed transactions are rejected (or worse, replayed on
 * the wrong network), so these were previously hardcoded to testnet — which made
 * mainnet impossible without editing this file. They are now env-driven with the
 * testnet values as defaults, so existing dev setups keep working untouched.
 *
 * USDC is native on Arc (no separate gas token) and lives at the same system
 * address on both networks; it is still overridable in case that ever changes.
 */
export const ARC_CHAIN_ID = Number(process.env.ARC_CHAIN_ID ?? 5042002);

/** True when the app is pointed at Arc mainnet rather than testnet. */
export const IS_ARC_MAINNET = ARC_CHAIN_ID === 5042;

export const ARC_CCTP_DOMAIN = Number(process.env.ARC_CCTP_DOMAIN ?? 26);

export const ARC_USDC_CONTRACT = (process.env.ARC_USDC_CONTRACT ??
  "0x3600000000000000000000000000000000000000") as Hex;

/** Native USDC system emitter (EIP-7708). Filter Transfer events here to catch native sends. */
export const ARC_NATIVE_USDC_EMITTER =
  "0xfffffffffffffffffffffffffffffffffffffffe" as Hex;

/** Default RPC per network — mainnet when ARC_CHAIN_ID says so, else testnet. */
const DEFAULT_ARC_RPC = IS_ARC_MAINNET
  ? "https://rpc.mainnet.arc.io"
  : "https://rpc.testnet.arc.io";

export const ARC_RPC_URL = process.env.ARC_RPC_URL ?? DEFAULT_ARC_RPC;

/** Block explorer for the active network (for tx links in the UI / ops). */
export const ARC_EXPLORER_URL =
  process.env.ARC_EXPLORER_URL ??
  (IS_ARC_MAINNET ? "https://arc.etherscan.io" : "https://explorer.testnet.arc.io");

/**
 * Validates and checksums an Arc address (EIP-55). Throws on invalid.
 * Per ARC_INTEGRATION.md §2.
 */
export function validateArcAddress(a: string): Hex {
  if (!isAddress(a)) {
    throw new Error(`Invalid Arc address: ${a}`);
  }
  return getAddress(a) as Hex;
}

/** viem public client for read-only chain calls (event monitoring, balance checks). */
export function arcPublicClient() {
  return createPublicClient({
    chain: { ...arc, id: ARC_CHAIN_ID, rpcUrls: { default: { http: [ARC_RPC_URL] } } },
    transport: http(ARC_RPC_URL),
  });
}

/**
 * Circle "blockchain" string for the DCW SDK. Matches arc-commerce convention.
 * ARC-TESTNET is the value used in CHAIN_IDS_TO_USDC_TOKEN_ID mapping.
 *
 * Network-aware: Circle identifies mainnet as plain "ARC". Sending "ARC-TESTNET"
 * while pointed at mainnet makes the DCW SDK reject the chain outright, so this
 * follows ARC_CHAIN_ID rather than defaulting to testnet unconditionally.
 */
export const CIRCLE_BLOCKCHAIN =
  process.env.CIRCLE_BLOCKCHAIN ?? (IS_ARC_MAINNET ? "ARC" : "ARC-TESTNET");

/**
 * Circle token id for USDC on Arc (from arc-commerce/lib/chains.ts).
 * Used by the DCW SDK when creating wallets / transferring USDC.
 *
 * NOTE: the default below is the TESTNET token id. Mainnet has its own id — it
 * MUST be set explicitly via CIRCLE_USDC_TOKEN_ID when running on mainnet, or
 * the DCW SDK will resolve the wrong token. This is asserted in
 * assertArcNetworkConfig().
 */
export const CIRCLE_USDC_TOKEN_ID =
  process.env.CIRCLE_USDC_TOKEN_ID ?? "15dc2b5d-0994-58b0-bf8c-3a0501148ee8";

/**
 * Fails fast on an inconsistent mainnet configuration.
 *
 * Money-touching code should call this at startup. A half-configured mainnet
 * (chain id set, Circle token id still the testnet one) is worse than a loud
 * crash: the app would look healthy while pointing the DCW at the wrong token.
 */
export function assertArcNetworkConfig(): void {
  if (!IS_ARC_MAINNET) return;
  const problems: string[] = [];
  if (!process.env.CIRCLE_USDC_TOKEN_ID) {
    problems.push(
      "CIRCLE_USDC_TOKEN_ID is still the testnet default — set the Arc MAINNET token id",
    );
  }
  if (!process.env.ESCROW_CONTRACT_ADDRESS) {
    problems.push("ESCROW_CONTRACT_ADDRESS is not set — deploy the contract to Arc mainnet first");
  }
  if (process.env.CIRCLE_BLOCKCHAIN && process.env.CIRCLE_BLOCKCHAIN !== "ARC") {
    problems.push(`CIRCLE_BLOCKCHAIN is "${process.env.CIRCLE_BLOCKCHAIN}" but mainnet requires "ARC"`);
  }
  if (problems.length) {
    throw new Error(`Arc mainnet config is incomplete:\n  - ${problems.join("\n  - ")}`);
  }
}
