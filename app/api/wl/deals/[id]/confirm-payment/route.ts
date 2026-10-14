import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { confirmDealPayment } from "@/lib/wl/transitions";

/**
 * POST /api/wl/deals/[id]/confirm-payment — seller confirms the fiat arrived.
 *
 * D3. The other half of the off-platform payment record. Requires the buyer to
 * have declared the payment first, so the two stamps always pair — you can never
 * have "seller confirmed money arrived" with no matching "buyer says they sent
 * it" on the record.
 *
 * On a fiat deal this is what unlocks `mark-delivered`: the seller's reason for
 * handing over the goods is that the money landed, so the DB refuses to let them
 * claim delivery before saying so.
 *
 * No on-chain call — a declaration, not a transfer.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  const rlErr = await checkUserRateLimit(user.id, "wl-confirm-payment", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const { id: dealId } = await params;
  try {
    await confirmDealPayment(dealId, user.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "confirm payment failed";
    // "buyer has not marked" is a 409 — the caller must wait for the other side,
    // not fix their request.
    const status = /not marked/i.test(msg) ? 409 : /not found|only|must/i.test(msg) ? 400 : 500;
    return jsonError(msg, status);
  }

  return jsonOk({ dealId, ok: true, paymentConfirmed: true }, 201);
}
