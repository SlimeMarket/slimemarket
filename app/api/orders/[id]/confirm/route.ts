import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { confirmOrder } from "@/lib/order/transitions";

/**
 * POST /api/orders/[id]/confirm — buyer confirms receipt (SENT → DONE).
 *
 * `confirmOrder` owns the whole settlement: the atomic RPC (ledger credit or the
 * no-credit variant, decided per order by its settlement rail), the RELEASED
 * lifecycle row, and the on-chain `releaseOrder` relay. The route only maps
 * errors.
 *
 * REMOVED a dead "instant delivery" block that used to run after
 * `confirmOrder`. It was unreachable AND would have corrupted state if it ever
 * did run:
 *
 *   - it gated on `order.status === "CONFIRMED"`, a status this codebase never
 *     writes (`confirmOrder` lands `DONE`), so the branch never executed;
 *   - had it executed it would have flipped a PAID order back to `SENT`,
 *     re-opening a settled order for another release/double payout;
 *   - it wrote `seller_delivered` and `delivered_via`, neither of which exists on
 *     `orders` — so it would have thrown anyway.
 *
 * Instant delivery is handled where it belongs: `auto_advance_instant_order`
 * (migration 0044) pops stock and attaches credentials at CHECKOUT confirm time,
 * inside `confirmCheckoutOrder`. There is nothing to do here.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  const { id } = await params;

  try {
    await confirmOrder(id, user);
    return jsonOk({ status: "DONE" });
  } catch (e) {
    // Typed pattern errors (guard 409 / ownership 403 / unresolved rail 409)
    // carry their own httpStatus — surface it instead of flattening to 400.
    const t = e as { httpStatus?: number; code?: string; message?: string };
    if (typeof t.httpStatus === "number") {
      return jsonError(t.message ?? "confirm failed", t.httpStatus, { code: t.code });
    }
    return jsonError(clientErrorMessage(e, "confirm failed"), 400);
  }
}
