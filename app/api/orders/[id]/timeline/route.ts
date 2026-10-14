import { jsonOk, jsonError , clientErrorMessage } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth-ucw";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/**
 * GET /api/orders/[id]/timeline
 *
 * Returns the ordered lifecycle events for an order (timeline visualization).
 *
 * FIXED (two live bugs):
 *
 *  1. The ownership check selected `seller_id` — a column that does NOT exist
 *     on `orders` (the schema links the seller through `store_id`). PostgREST
 *     returned an error, `order` came back `null`, and the handler answered
 *     `404 Order not found or unauthorized` for EVERY caller — including the
 *     actual buyer. The timeline was effectively dead.
 *
 *  2. It "read" the timeline by calling the `add_lifecycle_event` RPC. That
 *     function is `RETURNS VOID` and performs an **INSERT** — so opening the
 *     timeline WROTE a junk row (operation = NULL) every single time. A GET
 *     must never mutate. Replaced with a plain SELECT on `lifecycle_events`.
 *
 * Authorization now resolves the seller from the order's store, and staff
 * (Admin/MM) may also read a timeline for moderation.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  try {
    const { id: orderId } = await params;
    const admin = supabaseAdminClient();

    const { data: order, error: oErr } = await admin
      .from("orders")
      .select("id, buyer_id, store_id")
      .eq("id", orderId)
      .maybeSingle();

    if (oErr) return jsonError(`failed to load order: ${oErr.message}`, 500);
    if (!order) return jsonError("Order not found or unauthorized", 404);

    // Seller is the owner of the order's store (orders has no seller_id).
    let sellerId: string | null = null;
    if (order.store_id) {
      const { data: store } = await admin
        .from("stores")
        .select("owner_user_id")
        .eq("id", order.store_id)
        .maybeSingle();
      sellerId = store?.owner_user_id ?? null;
    }

    const role = (user.role || "").toLowerCase();
    const isStaff = role === "admin" || role === "mm";
    const isParty = order.buyer_id === user.id || (!!sellerId && sellerId === user.id);

    if (!isParty && !isStaff) {
      // Same message as a genuine miss so order ids can't be enumerated.
      return jsonError("Order not found or unauthorized", 404);
    }

    // Plain read — never mutate on GET.
    const { data: events, error: eErr } = await admin
      .from("lifecycle_events")
      .select("id, operation, tx_hash, amount, note, created_at")
      .eq("order_id", orderId)
      .order("created_at", { ascending: true });

    if (eErr) return jsonError(`failed to fetch timeline: ${eErr.message}`, 500);

    return jsonOk({
      orderId,
      buyerId: order.buyer_id,
      sellerId,
      events: events ?? [],
    });
  } catch (e) {
    return jsonError(clientErrorMessage(e, "failed to get timeline"), 500);
  }
}
