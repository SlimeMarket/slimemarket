import type { Hex } from "viem";
import { arcPublicClient } from "@/lib/arc";
import { sendUsdc } from "@/lib/contracts/escrow-client";

/**
 * F1 — On-chain wallet funding (non-custodial migration).
 *
 * Staged behind a feature flag so the money-flow migration can be rolled out
 * without breaking the currently-running custodial checkout (which still gates
 * on the DB ledger). See docs/ONCHAIN_ESCROW_PLAN.md §3.
 *
 *   ONCHAIN_WALLET_FUNDS=1  → top-ups send REAL USDC to the user's UCW and the
 *                             DB ledger becomes a *mirror* (no credit_wallet_atomic
 *                             inflating spendable balance). Checkout should gate on
 *                             the on-chain balance (F2).
 *   unset / "0"             → legacy behavior (DB credit is the money source).
 *
 * Keep this the SINGLE source of truth for the flag so every top-up path
 * (faucet, on-ramp webhook, dev simulate) stays consistent.
 */
export const ONCHAIN_FUNDS_ENABLED = process.env.ONCHAIN_WALLET_FUNDS === "1";

/**
 * Same flag, read at CALL time instead of module-load time.
 *
 * `ONCHAIN_FUNDS_ENABLED` above is evaluated once when the module is first
 * imported, which makes it untestable under `vi.stubEnv` and stale for any
 * caller that mutates process.env after boot. Decision points that must react to
 * the CURRENT mode (e.g. `isStuckInstantDraft` in lib/order/draft-cleanup.ts)
 * should use this instead.
 */
export function onchainFundsEnabled(): boolean {
  return process.env.ONCHAIN_WALLET_FUNDS === "1";
}

/**
 * .F-fix — mock-mode graceful skip for on-chain balance gates.
 *
 * In mock/dev environments (`CIRCLE_PAYMENTS_MOCK !== "0"`) wallet addresses
 * are synthetic (dev-login generates deterministic fake addresses that hold no
 * real USDC), so gating prepare on a real Arc balance read would block every
 * mock checkout — including dev-login sessions. Mirrors challenge-gate's
 * `shouldMockChallenge` semantics: also bypasses outside production so unit
 * tests + local dev never depend on a live Arc RPC.
 *
 * In production with `CIRCLE_PAYMENTS_MOCK=0` the gate is REAL for every
 * address (UCW or EOA payer).
 */
export function shouldBypassOnChainBalanceGate(): boolean {
  if (process.env.NODE_ENV === "production" && process.env.CIRCLE_PAYMENTS_MOCK === "0") {
    return false;
  }
  return true;
}

/** Read at CALL time (not module-load) so tests can stub env per-case. */
function platformWalletId(): string {
  return process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";
}

/** Arc native balance is 18-decimals (EIP-7708); micro-USDC is 6-decimals. */
const NATIVE_TO_MICRO = 10n ** 12n;

/**
 * Reads a UCW's spendable USDC balance as micro-USDC (bigint). Source of truth
 * for on-chain funds. Throws if the RPC is unreachable (callers decide whether
 * to hard-fail or fall back to the mirror for display).
 */
export async function getOnChainBalanceMicro(address: string): Promise<bigint> {
  const balance = await arcPublicClient().getBalance({ address: address as Hex });
  return balance / NATIVE_TO_MICRO;
}

/** True only when a real (non-mock) Circle wallet + platform relayer are configured. */
export function canFundOnChain(circleWalletId?: string | null): boolean {
  return (
    !!platformWalletId() &&
    !!circleWalletId &&
    !circleWalletId.startsWith("mock-")
  );
}

/**
 * Sends `amountMicro` USDC from the Platform DCW to the user's UCW address.
 * Returns the Circle tx id (on-chain hash resolves later). Throws on failure so
 * callers can leave the mirror tx `pending` instead of inventing phantom money.
 */
export async function fundUcwFromTreasury(params: {
  toAddress: string;
  amountMicro: bigint;
}): Promise<string> {
  if (!platformWalletId()) {
    throw new Error("PLATFORM_CIRCLE_WALLET_ID not configured");
  }
  const result = await sendUsdc(platformWalletId(), params.toAddress, params.amountMicro);
  if (!result.id) throw new Error("Circle transfer returned no id");
  return result.id;
}
