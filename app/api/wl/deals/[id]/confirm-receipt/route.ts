import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { parseBody, WlDealActionBodySchema } from "@/lib/schemas";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { verifyDealActionTx } from "@/lib/wl/verify-deal-action";
import { confirmDealAsBuyer } from "@/lib/wl/transitions";

/**
 * POST /api/wl/deals/[id]/confirm-receipt — buyer confirms the goods arrived.
 *
 * The buyer's own wallet broadcast `confirmEscrow(dealId)`, which releases the
 * escrowed USDC to the seller ON CHAIN — no middleman, no platform relay, no
 * PIN. This route only proves that transaction happened and mirrors the result
 * into the DB.
 *
 * FUNDS FIRST: the chain already moved the money, so the DB must never flip to
 * COMPLETED on its own. If the tx cannot be verified the deal stays ESCROW and
 * nothing is lost.
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

  const rlErr = await checkUserRateLimit(user.id, "wl-confirm-receipt", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const { id: dealId } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const parsed = parseBody(WlDealActionBodySchema, body);
  if (parsed instanceof Response) return parsed;

  try {
    await verifyDealActionTx({
      dealId, actorId: user.id, txHash: parsed.txHash, action: "confirmEscrow",
    });
    await confirmDealAsBuyer(dealId, user.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "confirm failed";
    return jsonError(msg, /not found|only|must|malformed|not match|not configured/i.test(msg) ? 400 : 500);
  }

  return jsonOk({ dealId, ok: true, status: "COMPLETED" }, 201);
}
