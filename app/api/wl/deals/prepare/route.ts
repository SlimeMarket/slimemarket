import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { prepareWlDeal } from "@/lib/wl/transitions";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { parseBody, WlDealPrepareBodySchema } from "@/lib/schemas";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";

/**
 * POST /api/wl/deals/prepare — Phase 2 (F5) non-custodial WL deal step 1.
 *
 * Validates listing + buyer, gates the buyer's UCW on-chain balance (must
 * cover price+baseFee+gas buffer), inserts a draft deal row (WAITING),
 * returns the approve call data the buyer will sign via a Circle
 * CONTRACT_EXECUTION challenge.
 *
 * Body: { listingId, unit?, qty?, isOffer? }
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  if (!ONCHAIN_FUNDS_ENABLED) {
    return jsonError(
      "non-custodial WL deals require ONCHAIN_WALLET_FUNDS=1; use POST /api/wl/deals for custodial",
      503,
    );
  }

  const rlErr = await checkUserRateLimit(user.id, "wl-prepare", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const parsed = parseBody(WlDealPrepareBodySchema, body);
  if (parsed instanceof Response) return parsed;

  try {
    const result = await prepareWlDeal(user.id, {
      listingId: parsed.listingId,
      unit: parsed.unit,
      qty: parsed.qty,
      isOffer: parsed.isOffer,
      // .D3 — EOA permit funding: skips the buyer's UCW balance gate
      // (the external wallet pays; Arc gas is USDC so no native token needed).
      payerAddress: parsed.payerAddress,
    });
    return jsonOk(result, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "prepare failed";
    return jsonError(msg, /insufficient|not found|must be|banned|frozen/i.test(msg) ? 400 : 500);
  }
}
