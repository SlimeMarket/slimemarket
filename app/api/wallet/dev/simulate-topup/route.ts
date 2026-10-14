import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { parseUsdc } from "@/lib/money";
import {
  ONCHAIN_FUNDS_ENABLED,
  canFundOnChain,
  fundUcwFromTreasury,
} from "@/lib/wallet/onchain-funding";

/**
 * POST /api/wallet/dev/simulate-topup  (DEV ONLY — 404 in production)
 *
 * Simulates a Circle webhook confirming a pending top-up. Looks up the pending
 * wallet_tx by id + ownership, then calls credit_wallet_atomic (with a 72h
 * chargeback holding window, matching real webhook behavior).
 *
 * Body: { walletTxId: string, amountUsdc: string }
 *
 * This mirrors what `dispatchEvent()` will do in the real webhook once Circle
 * fires `payments` / `wallets/transactions` CONFIRMED events.
 */
export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return jsonError("not found", 404);
  }
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }
  const { walletTxId, amountUsdc } = (body ?? {}) as {
    walletTxId?: string;
    amountUsdc?: string;
  };
  if (!walletTxId) return jsonError("walletTxId is required", 400);
  if (!amountUsdc) return jsonError("amountUsdc is required", 400);

  let amountMicro: bigint;
  try {
    amountMicro = parseUsdc(amountUsdc);
  } catch {
    return jsonError("amountUsdc is not a valid decimal amount", 400);
  }

  const admin = supabaseAdminClient();

  // Verify the wallet_tx belongs to this user and is a pending inbound top-up.
  const { data: tx, error: txErr } = await admin
    .from("wallet_txs")
    .select("id, wallet_id, status, type")
    .eq("id", walletTxId)
    .eq("type", "in")
    .maybeSingle();
  if (txErr || !tx) return jsonError("wallet_tx not found", 404);
  if (tx.status !== "pending") {
    return jsonError(`wallet_tx already processed (status=${tx.status})`, 409);
  }

  // Ownership: wallet must belong to the caller.
  const { data: wallet } = await admin
    .from("wallets")
    .select("user_id, address, circle_wallet_id")
    .eq("id", tx.wallet_id)
    .maybeSingle();
  if (!wallet || wallet.user_id !== user.id) {
    return jsonError("wallet_tx not found", 404);
  }

  if (ONCHAIN_FUNDS_ENABLED) {
    // Non-custodial: deliver REAL USDC to the UCW from the treasury (the dev
    // stand-in for Circle's on-ramp settlement). DB row stays a mirror.
    if (!canFundOnChain(wallet.circle_wallet_id)) {
      return jsonError(
        "on-chain funding required (ONCHAIN_WALLET_FUNDS=1) but platform relayer / user wallet not configured",
        400
      );
    }
    const circleTxId = await fundUcwFromTreasury({
      toAddress: wallet.address,
      amountMicro,
    });
    await admin
      .from("wallet_txs")
      .update({ circle_tx_id: circleTxId, status: "done" })
      .eq("id", tx.id);
    return jsonOk({ walletTxId: tx.id, status: "done", amountUsdcMicro: amountMicro.toString() });
  }

  const { error: creditErr } = await admin.rpc("credit_wallet_atomic", {
    p_wallet_id: tx.wallet_id,
    p_amount: amountMicro.toString(),
    p_ref_id: tx.id,
    p_wallet_tx_id: tx.id,
    p_holding_hours: 72,
  });
  if (creditErr) {
    return jsonError(`credit_wallet_atomic failed: ${creditErr.message}`, 500);
  }

  return jsonOk({ walletTxId: tx.id, status: "done", amountUsdcMicro: amountMicro.toString() });
}
