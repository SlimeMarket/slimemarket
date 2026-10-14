import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { markDealPaid } from "@/lib/wl/transitions";

/**
 * POST /api/wl/deals/[id]/mark-paid — buyer declares the fiat payment was sent.
 *
 * D3. In an OTC deal the IDR (or any fiat) moves buyer→seller OUTSIDE the
 * platform. The platform cannot witness a bank transfer, so the deal's record of
 * "the buyer paid" can only come from the buyer saying so. This stamps that
 * declaration so the seller has something concrete to confirm against, and so a
 * later dispute is not one party's word against the other's.
 *
 * No on-chain call and no money movement — purely a statement of fact, which is
 * why it needs no tx verification. Idempotent: re-clicking never moves the stamp.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  const rlErr = await checkUserRateLimit(user.id, "wl-mark-paid", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const { id: dealId } = await params;
  try {
    await markDealPaid(dealId, user.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "mark paid failed";
    return jsonError(msg, /not found|only|must/i.test(msg) ? 400 : 500);
  }

  return jsonOk({ dealId, ok: true, paymentMarked: true }, 201);
}
