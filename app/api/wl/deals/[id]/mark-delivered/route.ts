import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { parseBody, WlDealActionBodySchema } from "@/lib/schemas";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { verifyDealActionTx } from "@/lib/wl/verify-deal-action";
import { markDeliveredDeal } from "@/lib/wl/transitions";

/**
 * POST /api/wl/deals/[id]/mark-delivered — seller marks the goods delivered.
 *
 * Starts the buyer's confirmation clock (7 days on-chain). The seller's wallet
 * already broadcast `markDelivered(dealId)`; this route proves that transaction
 * really happened (correct sender, correct call, correct deal) before flipping
 * the DB — the same "verify then settle" shape as collateral-eoa.
 *
 * No money moves here, so there is no funds-first ordering to worry about.
 */
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

  const rlErr = await checkUserRateLimit(user.id, "wl-mark-delivered", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const { id: dealId } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const parsed = parseBody(WlDealActionBodySchema, body);
  if (parsed instanceof Response) return parsed;

  try {
    await verifyDealActionTx({
      dealId, actorId: user.id, txHash: parsed.txHash, action: "markDelivered",
    });
    await markDeliveredDeal(dealId, user.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "mark delivered failed";
    return jsonError(msg, /not found|only|must|malformed|not match|not configured/i.test(msg) ? 400 : 500);
  }

  return jsonOk({ dealId, ok: true, status: "ESCROW", delivered: true }, 201);
}
