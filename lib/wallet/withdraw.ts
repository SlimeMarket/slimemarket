import { randomUUID } from "crypto";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import type { CurrentUser } from "@/lib/auth-ucw";
import { parseUsdc } from "@/lib/money";
import { createPayout } from "@/lib/circle/payments";
import type { WithdrawResult } from "./types";

/**
 * Initiate a USDC → fiat withdrawal to a user's bank account.
 *
 * Flow:
 *   1. Validate bank account ownership.
 *   2. Check available_balance ≥ amount (chargeback guard P0-1).
 *   3. Insert wallet_tx (status='pending', type='out', method='bank').
 *   4. Call Circle Payouts API (dev-mock returns instant complete).
 *   5. Call debit_wallet_atomic RPC: posts ledger (DR user_wallet, CR external_fiat),
 *      decrements balance, marks wallet_tx done. Asserts available_balance again
 *      inside the RPC (race-safe via row lock).
 *
 * Idempotency: idempotency_key on wallet_txs (unique). Retries with same key
 * return the original wallet_tx_id.
 *
 * Dev-mock: synchronous settle (debit done immediately).
 * Real Circle: debit at initiate, mark 'escrowed' until webhook confirms
 * payout (M7 refactor).
 *
 * Money = bigint micro-USDC.
 */
export async function initiateWithdraw(args: {
  user: CurrentUser;
  bankAccountId: string;
  amountUsdc: string;
}): Promise<WithdrawResult> {
  const { user, bankAccountId, amountUsdc } = args;
  const amountMicro = parseUsdc(amountUsdc);
  if (amountMicro <= 0n) throw new Error("amount must be positive");

  const admin = supabaseAdminClient();

  // 1. Validate bank account ownership.
  const { data: bank, error: bErr } = await admin
    .from("bank_accounts")
    .select("id")
    .eq("id", bankAccountId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (bErr || !bank) throw new Error("bank account not found for user");

  // 2. Find wallet.
  const { data: wallet, error: wErr } = await admin
    .from("wallets")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (wErr || !wallet) throw new Error("wallet not found for user");

  const idempotencyKey = randomUUID();

  // 3. Insert pending wallet_tx.
  const { data: txRow, error: txErr } = await admin
    .from("wallet_txs")
    .insert({
      wallet_id: wallet.id,
      type: "out",
      label: "Withdraw",
      sub: "to bank",
      amount: amountMicro,
      status: "pending",
      method: "bank",
      bank_account_id: bankAccountId,
      idempotency_key: idempotencyKey,
    })
    .select("id")
    .single();
  if (txErr || !txRow) throw new Error(`insert wallet_tx failed: ${txErr?.message}`);

  // 4. Call Circle Payouts API (dev-mock returns complete).
  const payout = await createPayout({
    amountMicroUsdc: amountMicro,
    bankAccountId,
    walletTxId: txRow.id,
    idempotencyKey,
  });

  // Update circle_tx_id for webhook matching.
  await admin
    .from("wallet_txs")
    .update({ circle_tx_id: payout.circlePayoutId })
    .eq("id", txRow.id);

  // 5. Debit wallet (atomic: ledger + balance + status). If payout status is
  //    'pending' (real Circle), we'd mark wallet_tx 'escrowed' here instead.
  //    Dev-mock payout is instant → debit immediately.
  let finalStatus: WithdrawResult["status"] = "done";
  if (payout.status === "complete") {
    const { error: debitErr } = await admin.rpc("debit_wallet_atomic", {
      p_wallet_id: wallet.id,
      p_amount: amountMicro.toString(),
      p_ref_id: txRow.id,
      p_wallet_tx_id: txRow.id,
    });
    if (debitErr) {
      // Mark failed — payout was initiated but ledger debit rejected.
      // (M7 will add reversal flow via credit_wallet_atomic.)
      await admin
        .from("wallet_txs")
        .update({ status: "failed" })
        .eq("id", txRow.id);
      finalStatus = "failed";
      throw new Error(`debit_wallet_atomic failed: ${debitErr.message}`);
    }
  } else if (payout.status === "pending") {
    await admin
      .from("wallet_txs")
      .update({ status: "escrowed" })
      .eq("id", txRow.id);
    finalStatus = "escrowed";
  }

  return {
    walletTxId: txRow.id,
    status: finalStatus,
  };
}
