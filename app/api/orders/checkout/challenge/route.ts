import { getCurrentUser, getUcwCredentials } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { createContractExecutionChallenge } from "@/lib/ucw/contract-execution-challenge";
import { circleErrorExtra, circleErrorStatus } from "@/lib/ucw/error-status";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { parseBody, CheckoutChallengeBodySchema } from "@/lib/schemas";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { shouldMockChallenge } from "@/lib/wallet/challenge-gate";
import { checkPinGate } from "@/lib/wallet/pin-gate";
import { ARC_USDC_CONTRACT } from "@/lib/arc";
import { guardTransition, recordLifecycleEvent } from "@/lib/order/patterns";
import { randomUUID } from "crypto";

const ESCROW_CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS ?? "";
const USDC_CONTRACT_ADDRESS = ARC_USDC_CONTRACT;

/**
 * POST /api/orders/checkout/challenge — Phase 3.5 non-custodial checkout step 2.
 *
 * Creates a Circle UCW CONTRACT_EXECUTION challenge for the buyer to sign an
 * `USDC.approve(escrowAddress, itemAmount)` call. The buyer completes the
 * challenge in the browser via `W3SSdk.execute(challengeId)` (entering their
 * PIN), which sets the on-chain allowance that the DCW relayer's
 * `createOrderFor` will pull from.
 *
 * Returns `{ challengeId, txId }`:
 *   - challengeId: pass to `W3SSdk.execute()`.
 *   - txId: Circle tx UUID; pass to POST /api/orders/checkout/confirm.
 *
 * Body: { orderDraftId }
 *
 * Auth: buyer's UCW credentials (userToken + encryptionKey) are read from
 * the session cookies via `getUcwCredentials()`. If either is missing (e.g.
 * user signed up before localStorage mirror was added), the FE should
 * redirect to /refresh-session.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  if (!ONCHAIN_FUNDS_ENABLED) {
    return jsonError("non-custodial checkout requires ONCHAIN_WALLET_FUNDS=1", 503);
  }
  if (!ESCROW_CONTRACT_ADDRESS || !USDC_CONTRACT_ADDRESS) {
    return jsonError("escrow or USDC contract address not configured", 503);
  }

  const rlErr = await checkUserRateLimit(user.id, "checkout-challenge", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const parsed = parseBody(CheckoutChallengeBodySchema, body);
  if (parsed instanceof Response) return parsed;

  // Verify the draft belongs to the buyer + fetch itemAmount + buyerFee.
  const admin = supabaseAdminClient();
  const { data: order, error: oErr } = await admin.from("orders")
    .select("id, buyer_id, amount, buyer_fee, status, on_chain_order_id")
    .eq("id", parsed.orderDraftId)
    .maybeSingle();
  if (oErr || !order) return jsonError("order draft not found", 404);
  if (order.buyer_id !== user.id) return jsonError("not your order", 403);
  if (order.on_chain_order_id) return jsonError("order already confirmed", 409);

  // (b) State-machine guard: only a PENDING draft may be challenged. Turns a
  // cryptic downstream failure into a clean 409 with a stable code.
  try {
    guardTransition(order.status as string, ["PENDING"], "challenge");
  } catch (e) {
    const err = e as { httpStatus?: number; code?: string; message?: string };
    return jsonError(err.message ?? "invalid order status", err.httpStatus ?? 409, {
      code: err.code ?? "INVALID_ORDER_STATUS",
    });
  }

  const itemAmountMicro = BigInt(order.amount as string);
  const buyerFeeMicro = BigInt((order.buyer_fee as string) ?? "0");
  // Approve must cover the TOTAL the escrow will pull: item + buyer fee.
  const approveAmountMicro = itemAmountMicro + buyerFeeMicro;

  // (c) CHALLENGED lifecycle event — AUTHORIZED op + transition note. Called
  // right before returning a successful challenge (best-effort, never throws).
  const recordChallenged = () =>
    recordLifecycleEvent(
      admin as unknown as Parameters<typeof recordLifecycleEvent>[0],
      {
        orderId: parsed.orderDraftId,
        operation: "AUTHORIZED",
        txHash: null,
        amountMicro: approveAmountMicro,
        note: "checkout-transition:CHALLENGED",
      },
    );

  // Fetch UCW credentials from session cookies.
  const creds = await getUcwCredentials();
  if (!creds || !creds.circleWalletId) {
    return jsonError(
      "UCW credentials missing — refresh your wallet session (redirect to /refresh-session)",
      401,
    );
  }

  // Env-keyed dev/mock short-circuit (lib/wallet/challenge-gate.ts). Mock
  // short-circuit: DB transition is the source of truth in mock mode.
  // The old code called Circle's DCW API with the BUYER's wallet id, but the
  // DCW API can only act on platform DCW wallets — any user wallet id fails
  // with "Cannot find target wallet in the system". confirm() proceeds with
  // the allowance-fallback relay; real UCW challenge path below stays intact
  // for FORCE_REAL_UCW=true / production.
  if (shouldMockChallenge({ userToken: creds.userToken, circleWalletId: creds.circleWalletId })) {
    await recordChallenged();
    return jsonOk({ challengeId: "dev-bypass", txId: `mock-${randomUUID()}`, devBypass: true }, 201);
  }

  // PIN gate BEFORE creating the real challenge. Legacy accounts
  // (wallet exists, pinStatus UNSET) used to get a challenge that dead-ended
  // at "Contract Interaction → Confirm" with no PIN prompt. Now:
  //   UNSET → 422 PIN_SETUP_REQUIRED (FE triggers the setup gate, retries 1x)
  //   LOCKED → 423 PIN_LOCKED
  const pinGate = await checkPinGate(creds.userToken);
  if (!pinGate.ok) {
    return jsonError(pinGate.message, pinGate.httpStatus, { code: pinGate.code });
  }

  try {
    const result = await createContractExecutionChallenge({
      walletId: creds.circleWalletId,
      contractAddress: USDC_CONTRACT_ADDRESS,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [ESCROW_CONTRACT_ADDRESS, approveAmountMicro.toString()],
      userToken: creds.userToken,
    });
    await recordChallenged();
    return jsonOk(result, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "challenge creation failed";
    // An invalid/expired Circle session is a CLIENT problem — the browser has to
    // re-authenticate, retrying will never help. See lib/ucw/error-status.ts.
    const status = circleErrorStatus(msg);
    return jsonError(msg, status, circleErrorExtra(status));
  }
}
