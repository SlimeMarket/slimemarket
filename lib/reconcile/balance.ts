import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { readEscrowStats, isContractAddressSet } from "@/lib/contracts/escrow-client";
import { arcPublicClient, ARC_USDC_CONTRACT } from "@/lib/arc";
import { createMmAuditLog } from "@/lib/mm";
import { logger } from "@/lib/logger";
import type { Hex } from "viem";

const PLATFORM_WALLET_ID = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";
const ESCROW_CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS ?? "";
/**
 * the treasury DCW address does NOT live in `wallets` (that table only
 * holds *user* wallets), so the old `wallets.circle_wallet_id = PLATFORM_*`
 * lookup always returned nothing and `dcwOnChainBalanceMicro` was hard-wired to
 * 0. That made every drift negative by the whole treasury balance, tripping a
 * permanent false RECONCILE_DRIFT alert. Read the address from env instead
 * (same source `/api/admin/treasury` uses), with a DB fallback for envs where
 * the treasury gets mirrored into `wallets`.
 */
function treasuryAddressFromEnv(): string | null {
  const a = process.env.NEXT_PUBLIC_AGENT_WALLET_ADDRESS ?? process.env.AGENT_WALLET_ADDRESS ?? "";
  return a.trim() || null;
}

/** USDC ERC-20 ABI for balanceOf. */
const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export interface BalanceReconcileResult {
  /** On-chain DCW USDC balance (micro). */
  dcwOnChainBalanceMicro: bigint;
  /** On-chain pendingFees in escrow contract (micro). */
  escrowPendingFeesMicro: bigint;
  /** Sum of DB wallets.usdc_balance (micro). */
  dbWalletsSumMicro: bigint;
  /** Sum of pending wallet_txs.amount (micro) — funds not yet settled. */
  dbPendingTxsSumMicro: bigint;
  /**
   * Drift = dcwOnChainBalance + escrowPendingFees - dbWalletsSum - dbPendingTxs.
   *
   * Meaningful ONLY in the custodial model, where the treasury is expected to
   * hold every user's balance. See `mode` below. Positive = treasury holds more
   * than DB accounts for (unrecorded fees / unsettled payouts). Negative = DB
   * owes more than chain holds (BAD — double-spend or reconciliation gap).
   */
  driftMicro: bigint;
  /** True if |drift| exceeds the alert threshold. */
  driftExceedsThreshold: boolean;
  /**
   * Which money model produced this reading.
   *
   * `custodial` — `ONCHAIN_WALLET_FUNDS` unset/0: user balances live in the DB
   *   ledger and the treasury custodies them, so comparing treasury-vs-ledger is
   *   a real invariant and drift is actionable.
   *
   * `non-custodial` — `ONCHAIN_WALLET_FUNDS=1`: each user's USDC sits in their
   *   own wallet on-chain; `wallets.usdc_balance` is only a display mirror (and
   *   stays 0 because there is no ledger credit). The treasury is a transient
   *   transit account, NOT a custodian. The formula above therefore reports a
   *   permanent POSITIVE "drift" equal to the treasury balance — structurally,
   *   not because anything is wrong. Alerting on it is pure noise, so
   *   `driftExceedsThreshold` is forced false in this mode.
   */
  mode: "custodial" | "non-custodial";
}

/** Alert if |drift| > 1 USDC (1_000_000 micro). Tunable via env. */
const DRIFT_THRESHOLD_MICRO = BigInt(process.env.RECONCILE_DRIFT_THRESHOLD_MICRO ?? "1000000");

/**
 * `ONCHAIN_WALLET_FUNDS=1` switches the platform to the non-custodial
 * model, where the treasury-vs-ledger invariant does not apply. Read at call
 * time so tests can stub it.
 */
function isNonCustodial(): boolean {
  return process.env.ONCHAIN_WALLET_FUNDS === "1";
}

/**
 * Compare on-chain DCW/treasury USDC balance against the DB ledger.
 *
 * Formula:
 *   drift = (dcwOnChainBalance + escrowPendingFees)
 *         - (sum(wallets.usdc_balance) + sum(pending wallet_txs.amount))
 *
 * - dcwOnChainBalance: real USDC the DCW holds on-chain (source of truth VALUE)
 * - escrowPendingFees: USDC sitting in the MarketEscrow contract (held for
 *   platform fees, not yet swept via collectFees)
 * - wallets.usdc_balance sum: what the DB ledger says users own collectively
 * - pending wallet_txs sum: funds in-flight (e.g. sent on-chain but wallet_txs
 *   still 'pending' — counted here so they don't show as drift)
 *
 * Zero drift = perfect reconciliation. Non-zero drift logs an audit row +
 * Sentry capture (via logger.error) so ops can investigate.
 *
 * CRON: `app/api/admin/reconcile/balance/route.ts` every hour.
 */
export async function reconcileTreasuryBalance(): Promise<BalanceReconcileResult> {
  const admin = supabaseAdminClient();

  // 1. On-chain DCW balance.
  let dcwOnChainBalanceMicro = 0n;
  if (PLATFORM_WALLET_ID && ESCROW_CONTRACT_ADDRESS) {
    // Resolve the treasury DCW address: env first (authoritative — the treasury
    // is NOT a row in `wallets`), then a DB lookup as a fallback for setups that
    // do mirror it there.
    let treasuryAddress = treasuryAddressFromEnv();
    if (!treasuryAddress) {
      const { data: dcwWallet } = await admin.from("wallets")
        .select("address").eq("circle_wallet_id", PLATFORM_WALLET_ID).maybeSingle();
      treasuryAddress = dcwWallet?.address ?? null;
    }
    if (!treasuryAddress) {
      // Loud, because this silently zeroes the whole reconciliation.
      logger.warn(
        { platformWalletId: PLATFORM_WALLET_ID },
        "reconcile: treasury DCW address unresolved (set NEXT_PUBLIC_AGENT_WALLET_ADDRESS) — on-chain balance treated as 0"
      );
    } else {
      const client = arcPublicClient();
      dcwOnChainBalanceMicro = await client.readContract({
        address: ARC_USDC_CONTRACT as Hex,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [treasuryAddress as Hex],
      }) as bigint;
    }
  }

  // 2. On-chain escrow pendingFees.
  let escrowPendingFeesMicro = 0n;
  if (isContractAddressSet()) {
    try {
      const stats = await readEscrowStats();
      escrowPendingFeesMicro = stats.pendingFees;
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "reconcile: readEscrowStats failed");
    }
  }

  // 3. DB wallets sum.
  const { data: walletSumRow, error: wErr } = await admin.rpc("sum_wallets_balance");
  const dbWalletsSumMicro = wErr ? 0n : BigInt((walletSumRow as string) ?? "0");

  // 4. DB pending wallet_txs sum (status='pending').
  const { data: pendingSumRow, error: pErr } = await admin.rpc("sum_pending_wallet_txs");
  const dbPendingTxsSumMicro = pErr ? 0n : BigInt((pendingSumRow as string) ?? "0");

  // 5. Drift.
  const driftMicro =
    dcwOnChainBalanceMicro + escrowPendingFeesMicro
    - dbWalletsSumMicro - dbPendingTxsSumMicro;

  // In the non-custodial model the treasury is a transit account, so the
  // treasury-vs-ledger comparison is structurally non-zero and must NOT alert
  // (see the `mode` doc on BalanceReconcileResult). Still computed + reported so
  // ops can eyeball it; only the alert is suppressed.
  const nonCustodial = isNonCustodial();
  const driftExceedsThreshold = nonCustodial
    ? false
    : (driftMicro < 0n ? -driftMicro > DRIFT_THRESHOLD_MICRO : driftMicro > DRIFT_THRESHOLD_MICRO);

  const result: BalanceReconcileResult = {
    dcwOnChainBalanceMicro,
    escrowPendingFeesMicro,
    dbWalletsSumMicro,
    dbPendingTxsSumMicro,
    driftMicro,
    driftExceedsThreshold,
    mode: nonCustodial ? "non-custodial" : "custodial",
  };

  if (driftExceedsThreshold) {
    logger.error(result, "treasury balance drift exceeds threshold");
    await createMmAuditLog({
      mmUserId: null,
      mmWalletId: PLATFORM_WALLET_ID || "system",
      actorType: "system",
      action: "RECONCILE_DRIFT",
      refId: `balance-${new Date().toISOString()}`,
      detail: {
        dcwOnChainBalance: dcwOnChainBalanceMicro.toString(),
        escrowPendingFees: escrowPendingFeesMicro.toString(),
        dbWalletsSum: dbWalletsSumMicro.toString(),
        dbPendingTxsSum: dbPendingTxsSumMicro.toString(),
        drift: driftMicro.toString(),
        threshold: DRIFT_THRESHOLD_MICRO.toString(),
      },
    }).catch(() => {});
  } else {
    logger.info(result, "treasury balance reconciled (within threshold)");
  }

  return result;
}
