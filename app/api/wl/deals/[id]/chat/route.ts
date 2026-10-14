import { getCurrentUser } from "@/lib/auth-ucw";
import { isWlStaff } from "@/lib/types";
import { jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const { id: dealId } = await params;
  const admin = supabaseAdminClient();

  const { data: deal } = await admin.from("wl_deals")
    .select("buyer_id, seller_id").eq("id", dealId).maybeSingle();
  if (!deal) return jsonError("deal not found", 404);

  const isBuyer = deal.buyer_id === user.id;
  const isSeller = deal.seller_id === user.id;
  // 3 — deal-room monitoring is staff (Admin OR MM), not Admin only.
  const isStaff = isWlStaff(user.role);
  if (!isBuyer && !isSeller && !isStaff) return jsonError("not your deal", 403);

  // Find or create the escrow chat thread.
  // 0094 — `limit(1)` instead of `.maybeSingle()`: that call ERRORS (PGRST116)
  // when duplicates exist, which made this handler treat an existing thread as
  // missing and insert another one.
  const { data: existingRows } = await admin.from("chat_threads")
    .select("id").eq("type", "escrow").eq("order_id", dealId)
    .order("created_at", { ascending: true }).limit(1);

  let threadId = existingRows?.[0]?.id as string | undefined;
  if (!threadId) {
    // Get all staff user ids (Admin + MM — 3)
    const { data: staff } = await admin.from("users").select("id").in("role", ["Admin", "MM"]);
    const participantIds = [...new Set([deal.buyer_id, deal.seller_id, ...(staff ?? []).map((a) => a.id)])];
    const { data: newThread, error } = await admin.from("chat_threads").insert({
      participant_ids: participantIds, type: "escrow", status: "active", order_id: dealId,
    }).select("id").single();

    if (error) {
      // 23505 = unique_violation → a concurrent request created it first. Re-select
      // rather than insert a duplicate.
      if (error.code === "23505") {
        const { data: again } = await admin.from("chat_threads")
          .select("id").eq("type", "escrow").eq("order_id", dealId)
          .order("created_at", { ascending: true }).limit(1);
        threadId = again?.[0]?.id as string | undefined;
      }
      if (!threadId) return jsonError(dbErrorMessage("wl/deals/[id]/chat", error), 500);
    } else {
      threadId = newThread.id;
      // Post the system message ONLY when this request actually created the
      // thread — otherwise the losing racer would post a duplicate greeting.
      await admin.from("chat_messages").insert({
        thread_id: threadId, sender_id: null, sender_role: "system",
        text: "Escrow deal chat opened. Buyer, seller, and admins can communicate here.",
      });
    }
  }

  // Join sender identity via the named FK (migration 0010: chat_messages.sender_id
  // → users.id, constraint `chat_messages_sender_id_fkey`). The FE needs the
  // sender's name/avatar to render identity-based bubbles (alignment is by
  // sender_id vs viewer id, NOT by role — sender_role can be stale/wrong for
  // old rows written with the account role).
  const { data: messages } = await admin.from("chat_messages")
    .select("sender_id, sender_role, text, created_at, users!chat_messages_sender_id_fkey(name, avatar_gradient)")
    .eq("thread_id", threadId).order("created_at", { ascending: true }).limit(100);

  return jsonOk({
    threadId,
    dealId,
    type: "escrow",
    myId: user.id,
    buyerId: deal.buyer_id,
    sellerId: deal.seller_id,
    messages: messages ?? [],
  });
}
