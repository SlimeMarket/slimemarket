import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

export const dynamic = "force-dynamic";

// 0094 — one chat thread per (type, order_id). Reads use `limit(1)` instead of
// `.maybeSingle()`: that call ERRORS (PGRST116, "multiple rows returned") when
// duplicates already exist, and this handler used to read the error as "no
// thread" — so it inserted another one and served the empty room.
async function findThread(
  admin: ReturnType<typeof supabaseAdminClient>,
  type: string,
  orderId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("chat_threads")
    .select("id")
    .eq("type", type)
    .eq("order_id", orderId)
    .order("created_at", { ascending: true })
    .limit(1);
  return data?.[0]?.id ?? null;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const { id: orderId } = await params;
  const admin = supabaseAdminClient();

  // Verify user is buyer or seller of this order
  const { data: order } = await admin.from("orders")
    .select("buyer_id, store_id").eq("id", orderId).maybeSingle();
  if (!order) return jsonError("order not found", 404);

  const { data: store } = await admin.from("stores").select("owner_user_id").eq("id", order.store_id).maybeSingle();
  const isBuyer = order.buyer_id === user.id;
  const isSeller = store?.owner_user_id === user.id;
  const isAdmin = user.role === "Admin";
  if (!isBuyer && !isSeller && !isAdmin) return jsonError("not your order", 403);

  // Check if a dispute thread exists (it takes precedence over the normal room)
  const disputeThreadId = await findThread(admin, "dispute", orderId);

  // Check if a normal order chat thread exists
  let threadId = await findThread(admin, "normal", orderId);

  if (!threadId && !disputeThreadId) {
    // Create a normal order chat thread
    const { data: newThread, error } = await admin.from("chat_threads").insert({
      participant_ids: [order.buyer_id, store?.owner_user_id].filter(Boolean),
      type: "normal", status: "active", order_id: orderId,
    }).select("id").single();

    if (error) {
      // 23505 = unique_violation → a concurrent request created the thread first.
      // Re-select instead of inserting a duplicate.
      if (error.code === "23505") threadId = await findThread(admin, "normal", orderId);
      if (!threadId) return jsonError(dbErrorMessage("orders/[id]/chat", error), 500);
    } else {
      threadId = newThread.id;
    }
  }

  // If a dispute exists, return the dispute thread
  const finalThreadId = disputeThreadId || threadId;
  if (!finalThreadId) return jsonError("no chat thread", 404);

  // Fetch messages
  const { data: messages } = await admin.from("chat_messages")
    .select("*").eq("thread_id", finalThreadId).order("created_at", { ascending: true }).limit(100);

  return jsonOk({ threadId: finalThreadId, orderId, type: disputeThreadId ? "dispute" : "normal", messages: messages ?? [] });
}
