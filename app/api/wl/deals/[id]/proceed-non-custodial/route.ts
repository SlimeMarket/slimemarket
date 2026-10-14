import { getCurrentUser, getUcwCredentials } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { proceedWlDealNonCustodial } from "@/lib/wl/transitions";
import { createContractExecutionChallenge } from "@/lib/ucw/contract-execution-challenge";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { parseBody, WlCollateralProceedBodySchema } from "@/lib/schemas";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { shouldMockChallenge } from "@/lib/wallet/challenge-gate";
import { checkPinGate } from "@/lib/wallet/pin-gate";
import { ARC_USDC_CONTRACT } from "@/lib/arc";
import { parseUsdc } from "@/lib/money";
import { randomUUID } from "crypto";

const ESCROW_CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS ?? "";

/**
 * Sane upper bound for client-supplied collateral. The RPC/contract accept any
 * uint256, so without a route-layer cap a client could pass an absurd amount
 * that overflows downstream arithmetic or drains the seller's wallet far
 * beyond the listing intent. 1M USDC mirrors the max listing unit.
 */
const MAX_COLLATERAL_MICRO = 1_000_000n * 1_000_000n;

/**
 * POST /api/wl/deals/[id]/proceed-non-custodial — Phase 2 (F5) seller step 2.
 *
 * Two-phase operation:
 *   1. Verify the seller's `approve(escrow, collateral)` tx is CONFIRMED.
 *   2. Issue a SECOND Circle UCW CONTRACT_EXECUTION challenge for the seller
 *      to call `depositEscrowCollateral(dealId, collateral)` directly (the
 *      contract requires `msg.sender == d.seller`, so the seller's UCW must
 *      be the caller — not the DCW).
 *   3. Update DB state via `proceedWlDealNonCustodial` (proceed_wl_deal_atomic).
 *
 * Returns `{ challengeId, txId, dealId, ok }`. The FE runs `W3SSdk.execute`
 * for the deposit challenge; on completion, the on-chain collateral is locked.
 *
 * Body: { approveTxId, collateralUsdc }
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

  const rlErr = await checkUserRateLimit(user.id, "wl-proceed", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const { id: dealId } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const parsed = parseBody(WlCollateralProceedBodySchema, body);
  if (parsed instanceof Response) return parsed;

  const collateralMicro = parseUsdc(parsed.collateralUsdc);
  if (collateralMicro > MAX_COLLATERAL_MICRO) {
    return jsonError(
      `collateral exceeds maximum ${MAX_COLLATERAL_MICRO / 1_000_000n} USDC`,
      400,
      { code: "COLLATERAL_TOO_LARGE" },
    );
  }

  // Verify the seller is the caller + fetch on_chain_deal_id.
  const admin = supabaseAdminClient();
  const { data: deal, error: dErr } = await admin.from("wl_deals")
    .select("id, listing_id, on_chain_deal_id, needs_collateral").eq("id", dealId).maybeSingle();
  if (dErr || !deal) return jsonError("deal not found", 404);
  // Any non-null on_chain_deal_id (including "0" — the first contract deal id)
  // means the deal IS confirmed on-chain. Only null blocks proceed.
  if (!deal.on_chain_deal_id) return jsonError("deal not confirmed on-chain yet", 400);
  const { data: listing } = await admin.from("wl_listings")
    .select("seller_id, collateral").eq("id", deal.listing_id).maybeSingle();
  if (!listing || listing.seller_id !== user.id) return jsonError("not the seller", 403);

  // A listing that demands collateral must not proceed with 0 — otherwise the
  // seller could lock the buyer's funds with no skin in the game. The
  // requirement is snapshotted on the deal (needs_collateral) at create time;
  // the listing is the fallback for legacy rows.
  if ((deal.needs_collateral === true || listing.collateral === true) && collateralMicro === 0n) {
    return jsonError("collateral is required for this listing", 400, { code: "COLLATERAL_REQUIRED" });
  }

  // PIN gate BEFORE any DB mutation in REAL mode: the deposit
  // challenge below needs a PIN to prompt; without one the deal would be
  // stranded mid-transition behind an un-actionable challenge. Mock/dev
  // sessions skip the gate (automation stays green).
  if (collateralMicro > 0n) {
    try {
      const gateCreds = await getUcwCredentials();
      if (
        gateCreds && gateCreds.circleWalletId
        && !shouldMockChallenge({ userToken: gateCreds.userToken, circleWalletId: gateCreds.circleWalletId })
      ) {
        const pinGate = await checkPinGate(gateCreds.userToken);
        if (!pinGate.ok) {
          return jsonError(pinGate.message, pinGate.httpStatus, { code: pinGate.code });
        }
      }
    } catch (e) {
      // Fail-open (same policy as checkPinGate): a transient Circle outage
      // must not brick the proceed flow.
      console.error("[wl/proceed] pre-gate check failed (continuing):", e);
    }
  }

  // Step 1: verify approve tx CONFIRMED + update DB state.
  try {
    await proceedWlDealNonCustodial({
      dealId,
      sellerId: user.id,
      collateralMicro,
      approveTxHash: parsed.approveTxHash, approveTxId: parsed.approveTxId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "proceed failed";
    return jsonError(msg, /not confirmed|timeout|not found|not your/i.test(msg) ? 400 : 500);
  }

  // .D3 — seller collateral via the UCW PIN challenge path (migration
  // 0051). Zero-collateral deals leave the wallet type NULL (nothing deposited).
  if (collateralMicro > 0n) {
    await admin.from("wl_deals")
      .update({ seller_collateral_wallet_type: "ucw" })
      .eq("id", dealId);
  }

  // Step 2: zero-collateral deals (needsCollateral=false) — the DB transition
  // above is the whole operation; there is no collateral to approve or deposit
  // on-chain, so skip the Circle/mock challenge entirely. Mirrors how the
  // custodial proceedDeal guards `collateralMicro > 0n` before depositing.
  if (collateralMicro === 0n) {
    return jsonOk({ challengeId: "none", txId: null, devBypass: true, noCollateral: true, dealId, ok: true }, 201);
  }

  // Step 2: issue depositEscrowCollateral challenge for the seller's UCW.
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
  // msg.sender == d.seller for the collateral deposit, so a platform relay is
  // architecturally wrong anyway. The DB transition above (proceed_wl_deal_atomic)
  // already ran and is the source of truth. Real UCW path stays intact for
  // FORCE_REAL_UCW=true / production.
  if (shouldMockChallenge({ userToken: creds.userToken, circleWalletId: creds.circleWalletId })) {
    return jsonOk({ challengeId: "dev-bypass", txId: `mock-${randomUUID()}`, devBypass: true, dealId, ok: true }, 201);
  }

  try {
    const result = await createContractExecutionChallenge({
      walletId: creds.circleWalletId,
      contractAddress: ESCROW_CONTRACT_ADDRESS,
      abiFunctionSignature: "depositEscrowCollateral(uint256,uint256)",
      abiParameters: [deal.on_chain_deal_id as string, collateralMicro.toString()],
      userToken: creds.userToken,
    });
    return jsonOk({
      ...result,
      dealId,
      ok: true,
    }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "deposit challenge failed";
    return jsonError(msg, /not configured|required/i.test(msg) ? 503 : 500);
  }
}
