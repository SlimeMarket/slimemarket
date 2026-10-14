import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { parseBody, WlDealCollateralConfirmBodySchema } from "@/lib/schemas";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { validateDepositCollateralTx } from "@/lib/wl/eoa";
import { arcPublicClient } from "@/lib/arc";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import type { Hex } from "viem";

/**
 * POST /api/wl/deals/[id]/collateral-confirm — prove the UCW collateral deposit.
 *
 * WHY THIS EXISTS
 * ---------------
 * The EOA path is safe: `/collateral-eoa` verifies the deposit tx ON-CHAIN and
 * only then runs the WAITING→ESCROW transition.
 *
 * The UCW path is inverted. `proceed-non-custodial` runs the DB transition
 * FIRST — setting `status=ESCROW` and `seller_collateral=<amount>` — and only
 * then returns the `depositEscrowCollateral` challenge for the client to sign.
 * If the client never signs it, the row claims collateral the contract never
 * received, and a later `refundEscrowWithSlash` reverts with
 * "no collateral to slash" (observed in practice).
 *
 * This endpoint closes the loop: the client sends the deposit challenge id after
 * signing, we resolve it to the real on-chain tx, run the SAME
 * `validateDepositCollateralTx` check the EOA path uses, and record
 * `seller_collateral_tx_hash`. That column is the evidence that the collateral
 * actually exists on-chain — reconciliation can flag any ESCROW deal where
 * `seller_collateral > 0` but the hash is still NULL.
 *
 * Body: { depositChallengeId }
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  if (!ONCHAIN_FUNDS_ENABLED) {
    return jsonError("non-custodial WL deals require ONCHAIN_WALLET_FUNDS=1", 503);
  }
  const escrowAddress = process.env.ESCROW_CONTRACT_ADDRESS;
  if (!escrowAddress) return jsonError("escrow contract address not configured", 503);

  const rlErr = await checkUserRateLimit(user.id, "wl-collateral-confirm", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const { id: dealId } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const parsed = parseBody(WlDealCollateralConfirmBodySchema, body);
  if (parsed instanceof Response) return parsed;

  const admin = supabaseAdminClient();
  const { data: deal, error: dErr } = await admin.from("wl_deals")
    .select("id, listing_id, status, on_chain_deal_id, seller_collateral, seller_collateral_tx_hash")
    .eq("id", dealId)
    .maybeSingle();
  if (dErr || !deal) return jsonError("deal not found", 404);

  const { data: listing } = await admin.from("wl_listings")
    .select("seller_id").eq("id", deal.listing_id).maybeSingle();
  if (listing?.seller_id !== user.id) return jsonError("not the seller", 403);

  if (deal.status !== "ESCROW") {
    return jsonError(`deal is not awaiting collateral (status ${deal.status})`, 409);
  }
  const onChainDealId = deal.on_chain_deal_id as string | null;
  if (!onChainDealId) return jsonError("deal not confirmed on-chain yet", 409);

  const collateralMicro = BigInt(deal.seller_collateral ?? 0);
  if (collateralMicro <= 0n) {
    return jsonError("deal has no collateral to confirm", 400);
  }

  // Resolve the Circle CHALLENGE id to the real on-chain hash. The by-id endpoint
  // wants the transaction UUID, so the challenge lookup is the LIST endpoint.
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) return jsonError("CIRCLE_API_KEY not configured", 503);

  let depositTxHash: string | undefined;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const resp = await fetch(
      `https://api.circle.com/v1/w3s/transactions?challengeId=${encodeURIComponent(parsed.depositChallengeId)}`,
      { headers: { accept: "application/json", Authorization: `Bearer ${apiKey}` } },
    );
    const json = (await resp.json().catch(() => ({}))) as {
      data?: { transactions?: Array<{ state?: string; txHash?: string; errorDetails?: string }> };
    };
    const tx = json.data?.transactions?.[0];
    if (tx?.state === "FAILED" || tx?.state === "CANCELLED" || tx?.state === "DENIED") {
      return jsonError(`collateral deposit ${tx.state.toLowerCase()}${tx.errorDetails ? `: ${tx.errorDetails}` : ""}`, 400);
    }
    if (tx?.txHash) { depositTxHash = tx.txHash; break; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!depositTxHash) return jsonError("could not resolve the deposit transaction yet", 409);

  // Idempotent: the same deposit may be reported twice on a retry.
  if (deal.seller_collateral_tx_hash === depositTxHash) {
    return jsonOk({ dealId, ok: true, idempotent: true, depositTxHash }, 200);
  }

  // Same strict check the EOA path uses — sender must be the seller's wallet and
  // the call must be depositEscrowCollateral for THIS deal and amount.
  const { data: wallet } = await admin.from("wallets")
    .select("address").eq("user_id", user.id).maybeSingle();
  const sellerAddress = (wallet?.address ?? "").toLowerCase();
  if (!sellerAddress) return jsonError("seller has no on-chain wallet", 400);

  const client = arcPublicClient();
  let receipt: { status: string; to: string; from: string };
  let tx: { to: string | null; from: string; input: string };
  try {
    [receipt, tx] = await Promise.all([
      client.waitForTransactionReceipt({ hash: depositTxHash as Hex, timeout: 60_000 }) as Promise<{ status: string; to: string; from: string }>,
      client.getTransaction({ hash: depositTxHash as Hex }) as Promise<{ to: string | null; from: string; input: string }>,
    ]);
  } catch (e) {
    return jsonError(`deposit tx not found on Arc: ${(e as Error).message}`, 400);
  }

  const txSender = (tx.from ?? receipt.from ?? "").toLowerCase();
  if (txSender !== sellerAddress) {
    return jsonError(`deposit tx sender ${txSender} is not the seller's wallet (${sellerAddress})`, 400);
  }

  try {
    validateDepositCollateralTx(
      { to: tx.to ?? receipt.to ?? "", status: receipt.status, sender: txSender, input: tx.input ?? "0x" },
      { escrowAddress, sellerAddress, onChainDealId, collateralMicro },
    );
  } catch (e) {
    return jsonError((e as Error).message, 400);
  }

  const { error: upErr } = await admin.from("wl_deals")
    .update({ seller_collateral_tx_hash: depositTxHash, updated_at: new Date().toISOString() })
    .eq("id", dealId);
  if (upErr) return jsonError(`could not record the deposit: ${upErr.message}`, 500);

  return jsonOk({
    dealId,
    ok: true,
    depositTxHash,
    collateralMicro: collateralMicro.toString(),
  }, 201);
}
