import { getCurrentUser, getUcwCredentials } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { createContractExecutionChallenge } from "@/lib/ucw/contract-execution-challenge";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { parseBody, WlDealChallengeBodySchema } from "@/lib/schemas";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { shouldMockChallenge } from "@/lib/wallet/challenge-gate";
import { checkPinGate } from "@/lib/wallet/pin-gate";
import { ARC_USDC_CONTRACT } from "@/lib/arc";
import { randomUUID } from "crypto";

const ESCROW_CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS ?? "";

/**
 * POST /api/wl/deals/challenge — Phase 2 (F5) non-custodial WL deal step 2.
 *
 * Creates a Circle UCW CONTRACT_EXECUTION challenge for the buyer to sign
 * `USDC.approve(escrow, price+baseFee)`. Buyer completes via
 * `W3SSdk.execute(challengeId)` (PIN approval).
 *
 * Returns `{ challengeId, txId }`. Pass `txId` to
 * `POST /api/wl/deals/confirm`.
 *
 * Body: { dealDraftId }
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  if (!ONCHAIN_FUNDS_ENABLED) {
    return jsonError("non-custodial WL deals require ONCHAIN_WALLET_FUNDS=1", 503);
  }
  if (!ESCROW_CONTRACT_ADDRESS || !ARC_USDC_CONTRACT) {
    return jsonError("escrow or USDC contract address not configured", 503);
  }

  const rlErr = await checkUserRateLimit(user.id, "wl-challenge", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const parsed = parseBody(WlDealChallengeBodySchema, body);
  if (parsed instanceof Response) return parsed;

  const admin = supabaseAdminClient();
  const { data: deal, error: dErr } = await admin.from("wl_deals")
    .select("id, buyer_id, unit, qty, price, base_fee, on_chain_deal_id")
    .eq("id", parsed.dealDraftId)
    .maybeSingle();
  if (dErr || !deal) return jsonError("deal draft not found", 404);
  if (deal.buyer_id !== user.id) return jsonError("not your deal", 403);
  if (deal.on_chain_deal_id) return jsonError("deal already confirmed", 409);

  // total approve = price + base_fee
  const totalApprove = BigInt(deal.price as string) + BigInt(deal.base_fee as string);

  const creds = await getUcwCredentials();
  if (!creds || !creds.circleWalletId) {
    return jsonError(
      "UCW credentials missing — refresh your wallet session (redirect to /refresh-session)",
      401,
    );
  }

  // Env-keyed dev/mock short-circuit (lib/wallet/challenge-gate.ts): DB
  // transition is source of truth; contract requires buyer UCW which
  // dev/mock sessions don't have. The old code called the DCW SDK
  // createContractExecutionTransaction with the USER's wallet id, but Circle's
  // DCW API can only act on platform DCW wallets — any user wallet id fails
  // with "Cannot find target wallet in the system". Real UCW path below stays
  // intact for FORCE_REAL_UCW=true / production.
  if (shouldMockChallenge({ userToken: creds.userToken, circleWalletId: creds.circleWalletId })) {
    return jsonOk({ challengeId: "dev-bypass", txId: `mock-${randomUUID()}`, devBypass: true }, 201);
  }

  // PIN gate before the real challenge (UNSET → 422 PIN_SETUP_REQUIRED, LOCKED → 423).
  const pinGate = await checkPinGate(creds.userToken);
  if (!pinGate.ok) {
    return jsonError(pinGate.message, pinGate.httpStatus, { code: pinGate.code });
  }

  try {
    const result = await createContractExecutionChallenge({
      walletId: creds.circleWalletId,
      contractAddress: ARC_USDC_CONTRACT,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [ESCROW_CONTRACT_ADDRESS, totalApprove.toString()],
      userToken: creds.userToken,
    });
    return jsonOk(result, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "challenge creation failed";
    return jsonError(msg, /not configured|required/i.test(msg) ? 503 : 500);
  }
}
