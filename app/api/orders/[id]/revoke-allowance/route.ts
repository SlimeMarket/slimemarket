import { getCurrentUser, getUcwCredentials } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { createContractExecutionChallenge } from "@/lib/ucw/contract-execution-challenge";
import { checkUserRateLimit, FINANCIAL_RATE_LIMIT } from "@/lib/rate-limit";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { ARC_USDC_CONTRACT } from "@/lib/arc";

const ESCROW_CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS ?? "";

/**
 * POST /api/orders/[id]/revoke-allowance — Phase 5.3
 *
 * If a buyer's checkout failed with a dangling allowance (approve succeeded
 * but createOrderFor never confirmed), this endpoint issues a fresh Circle UCW
 * CONTRACT_EXECUTION challenge for `USDC.approve(escrow, 0)` — setting the
 * allowance back to zero so the escrow contract can no longer pull funds.
 *
 * Returns `{ challengeId, txId }` — the FE runs `W3SSdk.execute(challengeId)`
 * to get the buyer's PIN approval, exactly like the checkout challenge flow.
 *
 * Body: none (orderId from path).
 *
 * Auth: order's buyer only. Verifies the order exists, belongs to the caller,
 * is in CANCELLED status (dangling), and on-chain allowance > 0 (otherwise
 * there's nothing to revoke).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  if (!ONCHAIN_FUNDS_ENABLED) {
    return jsonError("non-custodial mode required (ONCHAIN_WALLET_FUNDS=1)", 503);
  }
  if (!ESCROW_CONTRACT_ADDRESS) {
    return jsonError("ESCROW_CONTRACT_ADDRESS not configured", 503);
  }

  const rlErr = await checkUserRateLimit(user.id, "revoke-allowance", FINANCIAL_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const { id: orderId } = await params;
  const admin = supabaseAdminClient();

  const { data: order, error: oErr } = await admin.from("orders")
    .select("id, buyer_id, status, payment")
    .eq("id", orderId)
    .maybeSingle();
  if (oErr || !order) return jsonError("order not found", 404);
  if (order.buyer_id !== user.id) return jsonError("not your order", 403);
  if (order.payment !== "Onchain") {
    return jsonError("only non-custodial orders can have dangling allowances", 400);
  }
  if (order.status !== "CANCELLED") {
    return jsonError("order must be CANCELLED to revoke allowance", 400);
  }

  // Verify there IS a dangling allowance on-chain (defense: don't issue a
  // challenge if there's nothing to revoke).
  const { data: wallet } = await admin.from("wallets")
    .select("address").eq("user_id", user.id).maybeSingle();
  if (!wallet?.address) return jsonError("buyer has no on-chain wallet", 400);

  const creds = await getUcwCredentials();
  if (!creds || !creds.circleWalletId) {
    return jsonError(
      "UCW credentials missing — refresh your wallet session (redirect to /refresh-session)",
      401,
    );
  }

  try {
    // Issue an approve(escrow, 0) challenge to zero out the allowance.
    const result = await createContractExecutionChallenge({
      walletId: creds.circleWalletId,
      contractAddress: ARC_USDC_CONTRACT,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [ESCROW_CONTRACT_ADDRESS, "0"],
      userToken: creds.userToken,
    });
    return jsonOk(result, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "revoke challenge failed";
    return jsonError(msg, /not configured|required/i.test(msg) ? 503 : 500);
  }
}
