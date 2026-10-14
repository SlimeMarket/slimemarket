import { randomUUID } from "crypto";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import type { CurrentUser } from "@/lib/auth-ucw";
import { parseUsdc } from "@/lib/money";
import {
  ONCHAIN_FUNDS_ENABLED,
  canFundOnChain,
  fundUcwFromTreasury,
} from "@/lib/wallet/onchain-funding";

/**
 * flip a mirror `wallet_txs` row from `pending` to `failed` when the
 * on-chain leg never happened. Best-effort: a failure here must not mask the
 * original error the caller is about to throw.
 */
async function markFaucetTxFailed(
  admin: ReturnType<typeof supabaseAdminClient>,
  txId: string,
  reason: string
): Promise<void> {
  try {
    await admin
      .from("wallet_txs")
      .update({ status: "failed", sub: `faucet failed: ${reason}`.slice(0, 200) })
      .eq("id", txId);
  } catch (e) {
    console.error("faucet: failed to mark wallet_tx as failed", txId, e);
  }
}

/**
 * Dev-only Arc testnet faucet credit.
 *
 * Two modes (see lib/wallet/onchain-funding.ts):
 *   - ONCHAIN_WALLET_FUNDS=1: sends REAL USDC to the user's UCW from the platform
 *     treasury and leaves the DB ledger as a *mirror* (NO credit_wallet_atomic,
 *     so spendable balance is not double-counted). Hard-fails if funding is not
 *     possible — never invents phantom balance.
 *   - unset/"0" (legacy): credits the DB ledger and best-effort sends on-chain.
 *
 * Gated by NODE_ENV !== 'production' at the route layer.
 */
export async function arcFaucetCredit(args: {
  user: CurrentUser;
  amountUsdc: string;
}): Promise<{ walletTxId: string; amountMicroUsdc: bigint }> {
  const { user, amountUsdc } = args;
  const amountMicro = parseUsdc(amountUsdc);
  if (amountMicro <= 0n) throw new Error("amount must be positive");

  const admin = supabaseAdminClient();

  const { data: wallet, error: wErr } = await admin
    .from("wallets")
    .select("id, circle_wallet_id, address")
    .eq("user_id", user.id)
    .maybeSingle();
  if (wErr || !wallet) throw new Error("wallet not found for user");

  const idempotencyKey = randomUUID();

  const { data: txRow, error: txErr } = await admin
    .from("wallet_txs")
    .insert({
      wallet_id: wallet.id,
      type: "in",
      label: "Arc faucet (dev)",
      sub: "testnet credit",
      amount: amountMicro,
      status: "pending",
      method: "onchain",
      idempotency_key: idempotencyKey,
    })
    .select("id")
    .single();
  if (txErr || !txRow) throw new Error(`insert wallet_tx failed: ${txErr?.message}`);

  if (ONCHAIN_FUNDS_ENABLED) {
    // Non-custodial: money lives on-chain. DB row stays a mirror (no ledger
    // credit). Hard-fail if we cannot actually move USDC to the UCW.
    if (!canFundOnChain(wallet.circle_wallet_id)) {
      // the row was already inserted as `pending`; leaving it that way
      // makes `sum_pending_wallet_txs` count money that was never sent, which
      // shows up as permanent negative treasury drift. Mark it failed.
      await markFaucetTxFailed(admin, txRow.id, "platform relayer / user wallet not configured");
      throw new Error(
        "on-chain funding required (ONCHAIN_WALLET_FUNDS=1) but platform relayer / user wallet not configured"
      );
    }
    let circleTxId: string;
    try {
      circleTxId = await fundUcwFromTreasury({
        toAddress: wallet.address,
        amountMicro,
      });
    } catch (e) {
      // CRITICAL: a failed treasury transfer must not leave a `pending`
      // wallet_tx behind. Previously every failed faucet call (e.g. empty
      // treasury) stranded a zombie `pending` row forever, inflating
      // `sum_pending_wallet_txs` and flipping reconcile/balance into a false
      // negative drift alert. No USDC moved, so the mirror row is `failed`.
      await markFaucetTxFailed(admin, txRow.id, e instanceof Error ? e.message : "transfer failed");
      throw e;
    }
    await admin
      .from("wallet_txs")
      .update({ circle_tx_id: circleTxId, status: "done" })
      .eq("id", txRow.id);
    return { walletTxId: txRow.id, amountMicroUsdc: amountMicro };
  }

  // Legacy custodial path: credit the DB ledger (no holding window — faucet has
  // no chargeback) and best-effort mirror it on-chain.
  const { error: creditErr } = await admin.rpc("credit_wallet_atomic", {
    p_wallet_id: wallet.id,
    p_amount: amountMicro.toString(),
    p_ref_id: txRow.id,
    p_wallet_tx_id: txRow.id,
    p_holding_hours: 0,
  });
  if (creditErr) throw new Error(`credit_wallet_atomic failed: ${creditErr.message}`);

  if (canFundOnChain(wallet.circle_wallet_id)) {
    try {
      const circleTxId = await fundUcwFromTreasury({
        toAddress: wallet.address,
        amountMicro,
      });
      await admin
        .from("wallet_txs")
        .update({ circle_tx_id: circleTxId, status: "done" })
        .eq("id", txRow.id);
    } catch (e) {
      console.error("faucet on-chain transfer failed:", e);
      // DB already credited — just warn (dev tool, not critical).
    }
  }

  return { walletTxId: txRow.id, amountMicroUsdc: amountMicro };
}
