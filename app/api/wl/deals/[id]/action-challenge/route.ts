import { getCurrentUser, getUcwCredentials } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { parseBody, WlDealActionChallengeBodySchema } from "@/lib/schemas";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { shouldMockChallenge } from "@/lib/wallet/challenge-gate";
import { checkPinGate } from "@/lib/wallet/pin-gate";
import { createContractExecutionChallenge } from "@/lib/ucw/contract-execution-challenge";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/**
 * POST /api/wl/deals/[id]/action-challenge — build the Circle challenge for a
 * deal action that the SELLER or BUYER performs on-chain.
 *
 * WHY THIS EXISTS
 * ---------------
 * `markDelivered`, `confirmEscrow` and `flagDispute` were only reachable through
 * `window.WalletBridge.sendTransaction(...)` in public/app.jsx — an EXTERNAL EOA
 * wallet. A user who signed up with email (UCW) therefore could not mark
 * delivered, confirm receipt, or open a dispute at all: the escrow could be
 * funded and could reach ESCROW, but never leave it. This route gives those
 * actions the same UCW rail that `proceed` and `collateral-challenge` already
 * use, so an email-only user can complete the deal.
 *
 * FLOW
 *   1. this route  → challengeId            (Circle CONTRACT_EXECUTION)
 *   2. browser     → W3SSdk.execute         (user approves with their PIN)
 *   3. existing route (mark-delivered / confirm-receipt / dispute) with the
 *      resulting txHash → verifyDealActionTx → DB transition
 *
 * Body: { action: "markDelivered" | "confirmEscrow" | "flagDispute" }
 */

/** Contract signature + who is allowed to call it, per action. */
const ACTIONS = {
  markDelivered: { signature: "markDelivered(uint256)", party: "seller" },
  confirmEscrow: { signature: "confirmEscrow(uint256)", party: "buyer" },
  flagDispute: { signature: "flagDispute(uint256)", party: "either" },
} as const;

type ActionName = keyof typeof ACTIONS;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  if (!ONCHAIN_FUNDS_ENABLED) {
    return jsonError("non-custodial WL deals require ONCHAIN_WALLET_FUNDS=1", 503);
  }
  if (!process.env.ESCROW_CONTRACT_ADDRESS) {
    return jsonError("escrow contract address not configured", 503);
  }

  const rlErr = await checkUserRateLimit(user.id, "wl-deal-action-challenge", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const { id: dealId } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const parsed = parseBody(WlDealActionChallengeBodySchema, body);
  if (parsed instanceof Response) return parsed;

  const action = parsed.action as ActionName;
  const spec = ACTIONS[action];
  if (!spec) return jsonError(`unsupported action: ${action}`, 400);

  const admin = supabaseAdminClient();
  const { data: deal, error: dErr } = await admin.from("wl_deals")
    .select("id, buyer_id, listing_id, on_chain_deal_id, status")
    .eq("id", dealId)
    .maybeSingle();
  if (dErr || !deal) return jsonError("deal not found", 404);

  // A non-null on_chain_deal_id (including "0", the first contract deal) means
  // the deal exists on-chain; only null blocks a challenge.
  if (!deal.on_chain_deal_id) return jsonError("deal not confirmed on-chain yet", 400);

  // Authorise: the seller comes from the listing, the buyer from the deal row.
  const { data: listing } = await admin.from("wl_listings")
    .select("seller_id").eq("id", deal.listing_id).maybeSingle();
  const isSeller = listing?.seller_id === user.id;
  const isBuyer = deal.buyer_id === user.id;
  if (spec.party === "seller" && !isSeller) return jsonError("not the seller", 403);
  if (spec.party === "buyer" && !isBuyer) return jsonError("not the buyer", 403);
  if (spec.party === "either" && !isSeller && !isBuyer) {
    return jsonError("not a party to this deal", 403);
  }

  const creds = await getUcwCredentials();
  if (!creds || !creds.circleWalletId) {
    return jsonError(
      "UCW credentials missing — refresh your wallet session (redirect to /refresh-session)",
      401,
    );
  }

  // Env-keyed dev/mock short-circuit: without a real UCW session there is no
  // wallet that can sign, so the DB transition is treated as the source of truth.
  if (shouldMockChallenge({ userToken: creds.userToken, circleWalletId: creds.circleWalletId })) {
    return jsonOk({ challengeId: "dev-bypass", txId: `mock-${crypto.randomUUID()}`, devBypass: true }, 201);
  }

  // PIN gate before the real challenge (UNSET → 422, LOCKED → 423).
  const pinGate = await checkPinGate(creds.userToken);
  if (!pinGate.ok) {
    return jsonError(pinGate.message, pinGate.httpStatus, { code: pinGate.code });
  }

  try {
    const result = await createContractExecutionChallenge({
      walletId: creds.circleWalletId,
      contractAddress: process.env.ESCROW_CONTRACT_ADDRESS,
      abiFunctionSignature: spec.signature,
      abiParameters: [String(deal.on_chain_deal_id)],
      userToken: creds.userToken,
    });
    return jsonOk({ ...result, action, onChainDealId: deal.on_chain_deal_id }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "deal action challenge failed";
    return jsonError(msg, /not configured|required/i.test(msg) ? 503 : 500);
  }
}
