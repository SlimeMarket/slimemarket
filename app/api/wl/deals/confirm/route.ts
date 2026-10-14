import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { confirmWlDeal } from "@/lib/wl/transitions";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { parseBody, WlDealConfirmBodySchema } from "@/lib/schemas";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";

/**
 * POST /api/wl/deals/confirm — Phase 2 (F5) non-custodial WL deal step 3.
 *
 * Verifies the buyer's approve() tx reached CONFIRMED, then relays
 * `createEscrowDealFor` via the DCW with a dummy permit. The contract's
 * `_applyPermit` try/catch falls back to checking `allowance(buyer, escrow)`.
 *
 * Returns `{ dealId, onChainDealId, onChainTxHash }`.
 *
 * Body: { dealDraftId, approveTxId }
 *
 * Idempotent: if the deal's `on_chain_deal_id` is already set, returns the
 * existing confirmation without re-relaying.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  if (!ONCHAIN_FUNDS_ENABLED) {
    return jsonError("non-custodial WL deals require ONCHAIN_WALLET_FUNDS=1", 503);
  }

  const rlErr = await checkUserRateLimit(user.id, "wl-confirm", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const parsed = parseBody(WlDealConfirmBodySchema, body);
  if (parsed instanceof Response) return parsed;

  try {
    const result = await confirmWlDeal(user.id, {
      dealDraftId: parsed.dealDraftId,
      approveTxHash: parsed.approveTxHash, approveTxId: parsed.approveTxId,
      // .D3 — EOA gasless permit path (additive; approve-tx path unchanged).
      permit: parsed.permit,
      payerAddress: parsed.payerAddress,
    });
    return jsonOk(result, 200);
  } catch (e) {
    // Typed pattern errors first (resolveConfirmPayer 422 etc.) — httpStatus
    // mapping instead of regex sniffing.
    const typed = e as { httpStatus?: number; code?: string; message?: string };
    if (typeof typed.httpStatus === "number") {
      return jsonError(typed.message ?? "confirm failed", typed.httpStatus, { code: typed.code });
    }
    const msg = e instanceof Error ? e.message : "confirm failed";
    const status = /not confirmed|timeout|not your deal|not found/i.test(msg) ? 400
      : /not ready|not configured/i.test(msg) ? 503
      : 500;
    return jsonError(msg, status);
  }
}
