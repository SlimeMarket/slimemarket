import { randomUUID } from "crypto";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import type { CurrentUser } from "@/lib/auth-ucw";
import { parseUsdc } from "@/lib/money";
import { createTopupIntent, paymentsUseMock } from "@/lib/circle/payments";
import type { TopupMethod, TopupResult } from "./types";

/**
 * Initiate a fiat → USDC top-up.
 *
 * Flow:
 *   1. Look up user's wallet.
 *   2. Insert a `wallet_txs` row with status='pending', type='in', method,
 *      fiat_amount, fiat_currency, idempotency_key.
 *   3. Call Circle Payments API (or dev-mock) to create payment intent.
 *   4. Update wallet_txs.circle_tx_id with Circle payment id (for webhook match).
 *   5. Return { redirectUrl, walletTxId }.
 *
 * Async credit: the actual balance credit happens via webhook
 * (dispatchEvent → credit_wallet_atomic), NOT here. Per ARC_INTEGRATION.md §4
 * "do not credit synchronously — wait for the Circle webhook".
 *
 * Dev-mock path: when CIRCLE_API_KEY unset, returns mock redirect URL. Use
 * POST /api/wallet/dev/simulate-topup to trigger the credit.
 *
 * Money = bigint micro-USDC.
 */
export async function initiateTopup(args: {
  user: CurrentUser;
  method: TopupMethod;
  fiatAmount: number;
  currency: string;
}): Promise<TopupResult> {
  const { user, method, fiatAmount, currency } = args;
  if (fiatAmount <= 0) throw new Error("fiatAmount must be positive");
  if (!["IDR", "USD"].includes(currency.toUpperCase()))
    throw new Error(`unsupported currency: ${currency}`);

  // fail BEFORE inserting a pending wallet_tx. In real (non-mock) mode
  // the legacy Circle Payments path is gone: fiat → USDC now goes through the
  // Arc App Kit onramp. Failing here avoids leaving an orphan 'pending' row
  // behind for a payment that can never settle.
  if (!paymentsUseMock()) {
    const err = new Error(
      "Fiat top-up is handled by the onramp widget — open Add funds → Buy with card/bank.",
    ) as Error & { code: string };
    err.code = "SUPERSEDED_BY_ONRAMP";
    throw err;
  }

  const admin = supabaseAdminClient();

  const { data: wallet, error: wErr } = await admin
    .from("wallets")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (wErr || !wallet) throw new Error("wallet not found for user");

  const idempotencyKey = randomUUID();

  // fiat_amount stored in minor units (cents). For IDR: rupiah; for USD: cents.
  const fiatMinor = Math.round(fiatAmount);

  // Pending wallet_tx — actual credit comes via webhook.
  const { data: txRow, error: txErr } = await admin
    .from("wallet_txs")
    .insert({
      wallet_id: wallet.id,
      type: "in",
      label: "Top-up",
      sub: `${method.toUpperCase()} · ${currency.toUpperCase()}`,
      amount: 0, // unknown until webhook confirms USDC amount
      status: "pending",
      method,
      fiat_amount: fiatMinor,
      fiat_currency: currency.toUpperCase(),
      idempotency_key: idempotencyKey,
    })
    .select("id")
    .single();
  if (txErr || !txRow) throw new Error(`insert wallet_tx failed: ${txErr?.message}`);

  // Dev-mock only (the real branch is refused above). The mock ignores the
  // amount, so 0n here is a placeholder, not a payment value.
  const intent = await createTopupIntent({
    amountMicroUsdc: 0n,
    method,
    currency: currency.toUpperCase(),
    walletTxId: txRow.id,
    idempotencyKey,
  });

  // Link Circle payment id back to wallet_tx for webhook matching.
  await admin
    .from("wallet_txs")
    .update({ circle_tx_id: intent.circlePaymentId })
    .eq("id", txRow.id);

  return {
    redirectUrl: intent.redirectUrl,
    walletTxId: txRow.id,
  };
}

/** Parse a USDC amount string from user input. */
export function parseTopupAmount(s: string): bigint {
  return parseUsdc(s);
}
