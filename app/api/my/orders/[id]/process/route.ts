import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , dbErrorMessage , clientErrorMessage } from "@/lib/utils";
import { advanceOrder } from "@/lib/order/transitions";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const { id } = await params;

  try {
    // Look up the order's delivery type first. Instant orders should auto-send
    // credentials from stock (no manual "Set Process" needed) — the buyer
    // already paid and stock was provided upfront.
    const admin = supabaseAdminClient();
    const { data: order } = await admin
      .from("orders")
      .select("delivery")
      .eq("id", id)
      .maybeSingle();

    if (order?.delivery === "instant") {
      // Atomic: pop qty stock items FIFO + mark SENT + auto-soldout if empty.
      const { data: result, error } = await admin.rpc("auto_advance_instant_order", {
        p_order_id: id,
        p_actor_id: user.id,
      });
      if (error) return jsonError(dbErrorMessage("my/orders/[id]/process", error), 400);
      return jsonOk({ status: "SENT", auto: true, result });
    }

    // Manual delivery: keep the original PENDING→PROCESS transition.
    await advanceOrder(id, user);
    return jsonOk({ status: "PROCESS" });
  } catch (e) {
    return jsonError(clientErrorMessage(e, "process failed"), 400);
  }
}
