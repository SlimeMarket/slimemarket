import { getCurrentUser, getUcwCredentials } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { createContractExecutionChallenge } from "@/lib/ucw/contract-execution-challenge";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { parseBody, WlCollateralChallengeBodySchema } from "@/lib/schemas";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { shouldMockChallenge } from "@/lib/wallet/challenge-gate";
import { checkPinGate } from "@/lib/wallet/pin-gate";
import { ARC_USDC_CONTRACT } from "@/lib/arc";
import { parseUsdc } from "@/lib/money";
import { randomUUID } from "crypto";

const ESCROW_CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS ?? "";

/**
 * POST /api/wl/deals/[id]/collateral-challenge — Phase 2 (F5) seller step.
 *
 * Creates a Circle UCW CONTRACT_EXECUTION challenge for the SELLER to sign
 * `USDC.approve(escrow, collateralAmount)`. The seller must approve the
 * escrow contract to pull collateral before calling `depositEscrowCollateral`.
 *
 * After the approve tx is confirmed, the seller (or FE on their behalf) calls
 * `POST /api/wl/deals/[id]/proceed-non-custodial` with the `approveTxId`.
 *
 * NOTE: This route only issues the approve challenge. The actual
 * `depositEscrowCollateral` call requires the seller's UCW to be `msg.sender`,
 * so the FE must issue a SECOND challenge for that call (the contract checks
 * `msg.sender == d.seller`). The FE flow:
 *   1. This route → approve challenge → W3SSdk.execute → approve tx CONFIRMED
 *   2. FE issues a depositEscrowCollateral challenge via a separate endpoint
 *      (or a future combined endpoint).
 * For now, this route handles step 1 only.
 *
 * Body: { collateralUsdc }
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  if (!ONCHAIN_FUNDS_ENABLED) {
    return jsonError("non-custodial WL deals require ONCHAIN_WALLET_FUNDS=1", 503);
  }
  if (!ESCROW_CONTRACT_ADDRESS || !ARC_USDC_CONTRACT) {
    return jsonError("escrow or USDC contract address not configured", 503);
  }

  const rlErr = await checkUserRateLimit(user.id, "wl-collateral-challenge", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const { id: dealId } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const parsed = parseBody(WlCollateralChallengeBodySchema, body);
  if (parsed instanceof Response) return parsed;

  const admin = supabaseAdminClient();
  const { data: deal, error: dErr } = await admin.from("wl_deals")
    .select("id, listing_id, on_chain_deal_id")
    .eq("id", dealId)
    .maybeSingle();
  if (dErr || !deal) return jsonError("deal not found", 404);
  // Any non-null on_chain_deal_id (including "0" — the first contract deal id)
  // means the deal IS confirmed on-chain. Only null blocks the challenge.
  if (!deal.on_chain_deal_id) return jsonError("deal not confirmed on-chain yet", 400);

  // Verify caller is the seller (via listing).
  const { data: listing } = await admin.from("wl_listings")
    .select("seller_id").eq("id", deal.listing_id).maybeSingle();
  if (!listing) return jsonError("listing not found", 404);
  if (listing.seller_id !== user.id) return jsonError("not the seller", 403);

  const collateralMicro = parseUsdc(parsed.collateralUsdc);

  // BUG 2: zero-collateral deals (needsCollateral=false) — the FE sends
  // { collateralUsdc: "0" }; there is nothing to approve, so skip the
  // Circle/mock challenge entirely.
  if (collateralMicro === 0n) {
    return jsonOk({ challengeId: "none", txId: null, devBypass: true, noCollateral: true }, 201);
  }

  const creds = await getUcwCredentials();
  if (!creds || !creds.circleWalletId) {
    return jsonError(
      "UCW credentials missing — refresh your wallet session (redirect to /refresh-session)",
      401,
    );
  }

  // Env-keyed dev/mock short-circuit (lib/wallet/challenge-gate.ts): DB
  // transition is source of truth; contract requires seller UCW which
  // dev/mock sessions don't have. The old code called the DCW SDK
  // createContractExecutionTransaction with the USER's wallet id, but Circle's
  // DCW API can only act on platform DCW wallets — any user wallet id fails
  // with "Cannot find target wallet in the system". The contract also requires
  // msg.sender == d.seller for the approve/deposit, so a platform relay is
  // architecturally wrong anyway. Real UCW path below stays intact for
  // FORCE_REAL_UCW=true / production.
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
      abiParameters: [ESCROW_CONTRACT_ADDRESS, collateralMicro.toString()],
      userToken: creds.userToken,
    });
    return jsonOk(result, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "collateral challenge failed";
    return jsonError(msg, /not configured|required/i.test(msg) ? 503 : 500);
  }
}
