import { requireRole } from "@/lib/auth-ucw";
import { jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { sendUsdc } from "@/lib/contracts/escrow-client";
import { waitForCircleTxState } from "@/lib/wallet/circle-tx-status";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { validateArcAddress } from "@/lib/arc";
import { parseUsdc } from "@/lib/money";
import { checkUserRateLimit, WITHDRAW_RATE_LIMIT } from "@/lib/rate-limit";
import { createMmAuditLog } from "@/lib/mm";
import { parseBody, EarningsWithdrawBodySchema } from "@/lib/schemas";
import { randomUUID } from "crypto";

const PLATFORM_WALLET_ID = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";

/**
 * POST /api/my/earnings/withdraw — Withdraw seller earnings to an on-chain Arc address.
 *
 * SAGA PATTERN (Phase 1.2 fix — eliminates the money-loss bug where the ledger
 * was debited but on-chain transfer failed and never reversed):
 *
 *   1. Validate amount + destination + sufficient balance (read-only).
 *   2. Create wallet_txs row (status='pending') — captures intent for audit + reconcile.
 *   3. sendUsdc via Circle DCW → returns Circle tx id (NOT yet confirmed).
 *   4. Poll Circle getTransaction until CONFIRMED or terminal-failed.
 *      - If FAILED: mark wallet_txs 'failed' (no ledger debit happened → no loss).
 *      - If CONFIRMED: proceed to step 5.
 *   5. debit_wallet_atomic (atomic: ledger + balance + status, row-locked).
 *      - If debit fails (rare, e.g. race drained balance): the USDC already left
 *        the treasury; record a RECONCILE_DEBIT_FAILED audit + leave wallet_txs
 *        'pending' so the reconcile job can reverse via credit_wallet_atomic.
 *   6. Mark wallet_txs 'done'. Audit. Return.
 *
 * Residual: if the server crashes between step 4 (CONFIRMED) and step 5
 * (debit), the treasury is short the USDC but the user's balance wasn't debited.
 * The reconcile job (`lib/wallet/reconcile.ts`) detects wallet_txs rows in
 * 'pending' with a CONFIRMED Circle tx and either completes the debit or
 * reverses the on-chain side (refund back to user).
 *
 * Security:
 *   - Requires Seller+ role.
 *   - Per-user rate limited (3/min).
 *   - UCW device approval is the security layer for the on-chain tx.
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireRole("Seller");
  } catch {
    return jsonError("Seller role required", 403);
  }
  if (user.banned) return jsonError("account is banned", 403);

  // B4 — non-custodial mode: releases pay the seller DIRECTLY on-chain
  // (MarketEscrow.releaseOrder → seller wallet), so there is no platform-held
  // balance to withdraw. The custodial ledger is no longer credited either,
  // so withdrawing from the platform DCW would send money it doesn't hold.
  if (ONCHAIN_FUNDS_ENABLED) {
    return jsonError(
      "Withdrawals are disabled in non-custodial mode — earnings are paid directly to your on-chain wallet at release.",
      409,
    );
  }

  // Per-user rate limit on earnings withdraw
  const rlErr = await checkUserRateLimit(user.id, "earnings-withdraw", WITHDRAW_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const body = await req.json().catch(() => ({}));

  // Validate body. EarningsWithdrawBodySchema enforces amountUsdc is a
  // positive decimal string + destAddress is a valid 0x... hex (the value
  // feeds an on-chain sendUsdc call — must be a real address).
  const parsed = parseBody(EarningsWithdrawBodySchema, body);
  if (parsed instanceof Response) return parsed;

  try {
    const amountMicro = parseUsdc(parsed.amountUsdc);
    if (amountMicro <= 0n) return jsonError("amount must be positive", 400);
    const dest = validateArcAddress(parsed.destAddress);
    const amountUsdc = parsed.amountUsdc;
    const destAddress = parsed.destAddress;

    const admin = supabaseAdminClient();
    const { data: wallet } = await admin
      .from("wallets")
      .select("id, usdc_balance, circle_wallet_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (!wallet) return jsonError("wallet not found", 404);
    if (BigInt(wallet.usdc_balance as string) < amountMicro) {
      return jsonError("insufficient balance", 400);
    }

    // Step 1: create wallet_txs row (status='pending') — captures intent for audit.
    const { data: txRow, error: txErr } = await admin
      .from("wallet_txs")
      .insert({
        wallet_id: wallet.id,
        type: "out",
        label: "Earnings Withdraw",
        sub: `to ${dest.slice(0, 8)}…${dest.slice(-4)}`,
        amount: amountMicro,
        status: "pending",
        method: "onchain",
        idempotency_key: randomUUID(),
      })
      .select("id")
      .single();
    if (txErr || !txRow) {
      return jsonError(`insert wallet_tx failed: ${txErr?.message}`, 500);
    }
    const walletTxId = txRow.id;

    // Dev/mock fallback (no platform wallet configured) — no on-chain tx, mark done.
    if (!PLATFORM_WALLET_ID) {
      await admin.from("wallet_txs").update({ status: "done" }).eq("id", walletTxId);
      return jsonOk({ ok: true, amount: amountUsdc, destination: destAddress });
    }

    // Step 2: sendUsdc first — if this fails, balance is untouched (no loss).
    let circleTxId: string;
    try {
      const result = await sendUsdc(PLATFORM_WALLET_ID, dest, amountMicro);
      circleTxId = result.id;
    } catch (e) {
      await admin.from("wallet_txs").update({ status: "failed" }).eq("id", walletTxId);
      console.error("earnings withdraw sendUsdc failed (balance not debited):", e);
      return jsonError("on-chain transfer failed. Balance was not debited; please retry.", 502);
    }

    // Step 3: wait for Circle tx to reach a terminal state.
    // On a transient server crash here, the reconcile job will detect the
    // 'pending' wallet_txs row with a CONFIRMED Circle tx and complete the debit.
    let confirmed = false;
    try {
      const state = await waitForCircleTxState(circleTxId, { timeoutMs: 60_000 });
      if (state === "CONFIRMED" || state === "COMPLETE") {
        confirmed = true;
      } else {
        // FAILED / CANCELLED / DENIED / null (timeout)
        await admin.from("wallet_txs")
          .update({ status: "failed", circle_tx_id: circleTxId })
          .eq("id", walletTxId);
        return jsonError(
          `on-chain transfer did not confirm (state: ${state ?? "timeout"}). Balance not debited.`,
          502,
        );
      }
    } catch (e) {
      // waitForCircleTxState threw — treat as unconfirmed. Reconcile will backstop.
      await admin.from("wallet_txs")
        .update({ status: "pending", circle_tx_id: circleTxId })
        .eq("id", walletTxId);
      console.error("earnings withdraw waitForCircleTxState threw:", e);
      return jsonError(
        "transfer confirmation timed out. Reconcile job will verify within 5 min — please check your balance later.",
        504,
      );
    }

    // Step 4: debit wallet (atomic). If this fails post-confirmation, the USDC
    // already left the treasury — flag for reconcile to either complete the
    // debit or reverse the on-chain transfer.
    const { error: debitErr } = await admin.rpc("debit_wallet_atomic", {
      p_wallet_id: wallet.id,
      p_amount: amountMicro.toString(),
      p_ref_id: walletTxId,
      p_wallet_tx_id: walletTxId,
    });
    if (debitErr) {
      // Reconcile will pick this up via `circle_tx_id` set + status='pending'.
      await createMmAuditLog({
        mmUserId: user.id,
        mmWalletId: PLATFORM_WALLET_ID,
        actorType: "user",
        action: "TREASURY_WITHDRAW",
        refId: walletTxId,
        circleTxId,
        detail: {
          reason: "debit_failed_post_send",
          debitError: debitErr.message,
          amountMicro: amountMicro.toString(),
          destination: dest,
          type: "earnings-withdraw-reconcile-needed",
        },
      }).catch(() => {});
      return jsonError(
        `on-chain transfer confirmed but ledger debit failed: ${debitErr.message}. Reconcile will resolve within 5 min.`,
        500,
      );
    }

    // Step 5: success — mark wallet_txs done + audit.
    await admin.from("wallet_txs")
      .update({ circle_tx_id: circleTxId, status: "done" })
      .eq("id", walletTxId);
    await createMmAuditLog({
      mmUserId: user.id,
      mmWalletId: PLATFORM_WALLET_ID,
      actorType: "user",
      action: "TREASURY_WITHDRAW",
      refId: walletTxId,
      circleTxId,
      detail: { amountMicro: amountMicro.toString(), destination: dest, type: "earnings-withdraw" },
    }).catch(() => {});

    return jsonOk({
      txId: circleTxId,
      status: "CONFIRMED",
      amount: amountUsdc,
      destination: destAddress,
    });
  } catch (e) {
    const err = e as Error & { status?: number };
    return jsonError(dbErrorMessage("my/earnings/withdraw", err), err.status ?? 400);
  }
}
