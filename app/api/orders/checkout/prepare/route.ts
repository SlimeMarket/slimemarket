import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { prepareCheckoutOrder } from "@/lib/order/checkout";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { parseBody, CheckoutPrepareBodySchema } from "@/lib/schemas";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";

/**
 * POST /api/orders/checkout/prepare — Phase 3.5 non-custodial checkout step 1.
 *
 * Validates product + buyer, gates the buyer's UCW on-chain balance (must
 * cover itemAmount + gas buffer), inserts a draft order row (status PENDING),
 * returns the approve call data the buyer will sign via a Circle
 * CONTRACT_EXECUTION challenge.
 *
 * Active only when ONCHAIN_WALLET_FUNDS=1. When the flag is OFF, callers
 * should use the legacy POST /api/orders (custodial) path instead.
 *
 * Body: { productId, variantLabel?, qty?, payment? }
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  if (!ONCHAIN_FUNDS_ENABLED) {
    return jsonError(
      "non-custodial checkout requires ONCHAIN_WALLET_FUNDS=1; use POST /api/orders for custodial checkout",
      503,
    );
  }

  const rlErr = await checkUserRateLimit(user.id, "checkout-prepare", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }

  const parsed = parseBody(CheckoutPrepareBodySchema, body);
  if (parsed instanceof Response) return parsed;

  // Idempotency: re-use the same key the legacy endpoint accepts so a retry
  // across both paths returns the same order.
  const idempotencyKey = req.headers.get("x-idempotency-key") || null;

  try {
    const result = await prepareCheckoutOrder(user, {
      productId: parsed.productId,
      variantLabel: parsed.variantLabel,
      qty: parsed.qty,
      payment: parsed.payment,
      idempotencyKey,
      // .F-fix — EOA external-wallet checkout: gate the on-chain balance
      // of the payer (this address) instead of the buyer's session UCW.
      payerAddress: parsed.payerAddress,
    });
    return jsonOk(result, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "prepare failed";
    const httpStatus = (e as { httpStatus?: number })?.httpStatus;
    return jsonError(msg, httpStatus ?? (/insufficient|not found|must be|banned|frozen/i.test(msg) ? 400 : 500));
  }
}
