import { randomBytes, randomUUID } from "crypto";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { circleDeveloperSdk } from "@/lib/circle/client";
import { CIRCLE_USDC_TOKEN_ID } from "@/lib/arc";
import type { CurrentUser } from "@/lib/auth-ucw";
import { parseUsdc, formatUsdc } from "@/lib/money";
import { validateArcAddress } from "@/lib/arc";
import { isBlocklisted } from "./blocklist";
import type { WithdrawResult } from "./types";

/**
 * Withdraw USDC to an on-chain Arc address (crypto off-ramp / cash-out).
 *
 * Hybrid model: debits the internal ledger balance (so escrow fund-flow
 * invariants hold — see ERD-Fund-Flow.html Flow A/B) and broadcasts the
 * on-chain transfer via Circle DCW transferTransaction API.
 *
 * If Circle SDK is not configured (dev/mock), falls back to random tx hash.
 *
 * Blocklist guard (ARC_INTEGRATION.md §5): destination is screened BEFORE any
 * debit. A blocked/invalid address aborts before gas is spent.
 *
 * NOTE (.B4): the FE wallet "Send" action routes through this handler,
 * i.e. it spends from the platform DCW — NOT the user's UCW wallet. A true
 * user-initiated UCW send (CREATE_TRANSFER challenge + PIN approval) is
 * future work; escrow flows already use UCW challenges.
 *
 * Money = bigint micro-USDC.
 */
export interface CryptoWithdrawInput {
  user: CurrentUser;
  destAddress: string;
  amountUsdc: string;
}

export interface CryptoWithdrawResult extends WithdrawResult {
  arcTxHash: string | null;
  destAddress: string;
  /**
   * true when the ledger debit already happened in this call. When
   * false the row is left 'pending' with its circle_tx_id and the reconciler
   * completes the debit once Circle reports the transfer as settled.
   */
  debited: boolean;
}

/**
 * Decide whether to attempt a REAL Circle DCW transfer or fall back to the
 * dev/mock settle path. Honors CIRCLE_PAYMENTS_MOCK semantics (mock unless
 * explicitly "0") AND the wallet-id guards. Pure + unit-testable.
 *
 * Dev-login wallets carry real-looking UUIDs (not "mock-" prefixes), so the
 * flag check is what keeps them off the real Circle API — without it the
 * DCW call fails with "Cannot find target wallet in the system".
 */
export function shouldAttemptCircleTransfer(args: {
  sdkReady: boolean;
  circleWalletId: string | null | undefined;
}): boolean {
  const { sdkReady, circleWalletId } = args;
  if (process.env.CIRCLE_PAYMENTS_MOCK !== "0") return false;
  if (!sdkReady) return false;
  if (!circleWalletId) return false;
  if (circleWalletId.startsWith("mock-")) return false;
  return true;
}

export async function initiateCryptoWithdraw(
  args: CryptoWithdrawInput
): Promise<CryptoWithdrawResult> {
  const { user, destAddress, amountUsdc } = args;
  const amountMicro = parseUsdc(amountUsdc);
  if (amountMicro <= 0n) throw new Error("amount must be positive");

  // Validate + checksum destination (throws on malformed).
  const dest = validateArcAddress(destAddress);

  // Blocklist screen before any state mutation.
  if (await isBlocklisted(dest)) {
    throw new Error("destination address is blocklisted or invalid");
  }

  // Enforce flat daily withdrawal limit (applies to all users equally).
  const admin = supabaseAdminClient();
  const { error: limitErr } = await admin.rpc("check_daily_withdraw_limit", {
    p_user_id: user.id, p_amount: amountMicro.toString(),
  });
  if (limitErr) throw new Error(`withdrawal limit: ${limitErr.message}`);

  const { data: wallet, error: wErr } = await admin
    .from("wallets")
    .select("id, circle_wallet_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (wErr || !wallet) throw new Error("wallet not found for user");

  // Pending wallet_tx; method='onchain', dest recorded in sub for history display.
  const { data: txRow, error: txErr } = await admin
    .from("wallet_txs")
    .insert({
      wallet_id: wallet.id,
      type: "out",
      label: "Withdraw (on-chain)",
      sub: `to ${dest.slice(0, 8)}…${dest.slice(-4)}`,
      amount: amountMicro,
      status: "pending",
      method: "onchain",
      idempotency_key: randomUUID(),
    })
    .select("id")
    .single();
  if (txErr || !txRow) {
    throw new Error(`insert wallet_tx failed: ${txErr?.message}`);
  }

  // DO NOT debit here.

  // The previous version called debit_wallet_atomic up front, then wrote the row
  // back to status='pending' when Circle had not yet reached a terminal state.
  // debit_wallet_atomic flips the row to 'done' on success, so that write
  // REGRESSED done → pending, and `reconcileFailedWithdrawals` (which scans
  // status='pending' + circle_tx_id) then debited the same withdrawal a second
  // time — the user was charged twice for one withdrawal.

  // The reconciler is designed to own the debit: it waits for a terminal Circle
  // state and only then calls debit_wallet_atomic (idempotent, no-ops unless the
  // row is still 'pending'). So we broadcast, leave the row 'pending', and only
  // debit immediately when Circle already reports the transfer as settled.

  // Balance is still checked BEFORE broadcasting, so we never send funds the
  // user does not have.
  const { data: bal } = await admin.rpc("wallet_available_balance", { p_wallet_id: wallet.id });
  const available = bal === null || bal === undefined ? null : BigInt(String(bal));
  if (available !== null && available < amountMicro) {
    await admin.from("wallet_txs").update({ status: "failed" }).eq("id", txRow.id);
    throw new Error("insufficient available balance for this withdrawal");
  }

  // Broadcast on-chain transfer via Circle DCW (real) or fallback to mock hash.
  let arcTxHash: string | null = null;
  let txStatus: "done" | "pending" | "failed" = "pending";
  let debited = false;

  const sdk = circleDeveloperSdk;
  const attemptRealTransfer =
    sdk !== null &&
    shouldAttemptCircleTransfer({ sdkReady: true, circleWalletId: wallet.circle_wallet_id });

  if (attemptRealTransfer) {
    try {
      const transferResp = await sdk.createTransaction({
        walletId: wallet.circle_wallet_id,
        tokenId: CIRCLE_USDC_TOKEN_ID,
        amount: [formatUsdc(amountMicro)],
        destinationAddress: dest,
        fee: { type: "level", config: { feeLevel: "LOW" } },
      });
      // Circle returns { id, state } immediately; the on-chain txHash and the
      // final state arrive later via getTransaction / webhook.
      const circleTxId = transferResp.data?.id ?? null;
      const circleState = transferResp.data?.state ?? "UNKNOWN";
      if (circleTxId) {
        await admin.from("wallet_txs")
          .update({ circle_tx_id: circleTxId })
          .eq("id", txRow.id);
      }
      if (circleState === "COMPLETE" || circleState === "CONFIRMED") {
        // Settled synchronously — debit now (idempotent) and close the row.
        const { error: debitErr } = await admin.rpc("debit_wallet_atomic", {
          p_wallet_id: wallet.id,
          p_amount: amountMicro.toString(),
          p_ref_id: txRow.id,
          p_wallet_tx_id: txRow.id,
        });
        if (debitErr) throw new Error(`debit_wallet_atomic failed: ${debitErr.message}`);
        debited = true;
        txStatus = "done";
      } else {
        // In-flight: leave it 'pending' WITH the circle_tx_id so the reconciler
        // completes the debit once Circle confirms. It must never be debited twice.
        txStatus = "pending";
      }
      arcTxHash = null; // real hash is resolved by the indexer/reconciler
    } catch (e) {
      // On-chain failure — mark failed. No debit happened, so nothing to reverse.
      console.error("Circle createTransaction failed for wallet_tx", txRow.id, ":", e);
      txStatus = "failed";
    }
  } else {
    // Dev/mock fallback — no real transfer, so settle the ledger synchronously.
    const { error: debitErr } = await admin.rpc("debit_wallet_atomic", {
      p_wallet_id: wallet.id,
      p_amount: amountMicro.toString(),
      p_ref_id: txRow.id,
      p_wallet_tx_id: txRow.id,
    });
    if (debitErr) throw new Error(`debit_wallet_atomic failed: ${debitErr.message}`);
    debited = true;
    arcTxHash = `0x${randomBytes(32).toString("hex")}`;
    txStatus = "done";
  }

  if (txStatus === "failed") {
    await admin.from("wallet_txs").update({ status: "failed" }).eq("id", txRow.id);
    throw new Error("on-chain transfer failed. No funds were moved.");
  }

  await admin.from("wallet_txs")
    .update({ arc_tx_hash: arcTxHash, status: txStatus })
    .eq("id", txRow.id);

  return {
    walletTxId: txRow.id,
    destAddress: dest,
    arcTxHash,
    // 'pending' means the transfer is in flight and the reconciler will finish
    // it; the caller must not report it as settled.
    status: txStatus,
    debited,
  };
}

