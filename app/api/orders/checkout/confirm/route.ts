import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { confirmCheckoutOrder } from "@/lib/order/checkout";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { parseBody, CheckoutConfirmBodySchema } from "@/lib/schemas";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";

/**
 * POST /api/orders/checkout/confirm — Phase 3.5 non-custodial checkout step 3.
 *
 * Verifies the buyer's approve() tx reached CONFIRMED, then relays
 * `createOrderFor` via the DCW with a dummy permit. The contract's
 * `_applyPermit` try/catch falls back to checking `allowance(buyer, escrow)`,
 * which the buyer's approve tx just set.
 *
 * Returns `{ orderId, onChainOrderId, onChainTxHash }`.
 *
 * Body: { orderDraftId, approveTxId }
 *
 * Idempotent: if the order's `on_chain_order_id` is already set, returns the
 * existing confirmation without re-relaying.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  if (!ONCHAIN_FUNDS_ENABLED) {
    return jsonError("non-custodial checkout requires ONCHAIN_WALLET_FUNDS=1", 503);
  }

  const rlErr = await checkUserRateLimit(user.id, "checkout-confirm", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const parsed = parseBody(CheckoutConfirmBodySchema, body);
  if (parsed instanceof Response) return parsed;

  // Optional anti-tamper echo (additive — schema strips unknown keys, so read
  // from the raw body). If present, confirmCheckoutOrder requires it to EXACTLY
  // equal the server-held draft amount (422 otherwise) and ALWAYS relays the
  // server value regardless.
  const clientAmountMicro = (body as { clientAmountMicro?: unknown }).clientAmountMicro;

  try {
    const result = await confirmCheckoutOrder(user, {
      orderDraftId: parsed.orderDraftId,
      approveTxHash: parsed.approveTxHash, approveTxId: parsed.approveTxId,
      clientAmountMicro: typeof clientAmountMicro === "string" ? clientAmountMicro : undefined,
      // .D — EOA gasless permit path (additive; approve-tx path unchanged).
      permit: parsed.permit,
      payerAddress: parsed.payerAddress,
    });
    return jsonOk(result, 200);
  } catch (e) {
    // Typed pattern errors first (guard 409 / amount 422 / ownership 403) —
    // arc-style preflight mapping instead of regex sniffing.
    const typed = e as { httpStatus?: number; code?: string; message?: string };
    if (typeof typed.httpStatus === "number") {
      return jsonError(typed.message ?? "confirm failed", typed.httpStatus, {
        code: typed.code,
      });
    }
    const msg = e instanceof Error ? e.message : "confirm failed";
    const status = /not confirmed|timeout|not found/i.test(msg) ? 400
      : /not ready|not configured/i.test(msg) ? 503
      : 500;
    return jsonError(msg, status);
  }
}
