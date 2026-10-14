import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { sanitizeText } from "@/lib/sanitize";
import { sendMessage } from "@/lib/chat/queries";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { resolveDealSenderRole, toSenderRole } from "@/lib/wl/chat";

/**
 * Resolves the sender_role to store for a message in `threadId`.
 *
 * Escrow deal threads (chat_threads.type='escrow', order_id = wl_deals.id):
 * the sender's DEAL SIDE is stored, not the account role — a Seller-account
 * acting as the deal's buyer is stored as 'buyer' (A3). Any other
 * thread keeps the account role, mapped through `toSenderRole()` so that
 * "Member"/"MM" (which the sender_role CHECK constraint rejects) become
 * 'buyer'/'middleman' instead of blowing up the insert.
 */
async function resolveSenderRole(
  threadId: string,
  user: { id: string; role: string },
): Promise<string> {
  // Non-escrow fallback: clamp to a value the CHECK constraint accepts.
  const accountRole = toSenderRole(user.role);
  try {
    const admin = supabaseAdminClient();
    const { data: thread } = await admin.from("chat_threads")
      .select("type, order_id").eq("id", threadId).maybeSingle();
    if (thread?.type !== "escrow" || !thread.order_id) return accountRole;

    // Escrow threads link WL deals via order_id (see /api/wl/deals/[id]/chat).
    // Regular-order escrow threads won't match wl_deals → fallback below.
    const { data: deal } = await admin.from("wl_deals")
      .select("buyer_id, seller_id").eq("id", thread.order_id).maybeSingle();
    if (!deal) return accountRole;

    return resolveDealSenderRole({
      senderId: user.id,
      buyerId: deal.buyer_id,
      sellerId: deal.seller_id,
      accountRole: user.role,
    });
  } catch {
    // Role resolution is cosmetic (FE aligns by sender_id identity now);
    // never fail the send because of it.
    return accountRole;
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const { id } = await params;
  let body: unknown; try { body = await req.json(); } catch { body = {}; }
  const rawText = ((body ?? {}) as { text?: string }).text;
  const text = sanitizeText(rawText).trim();
  if (!text) return jsonError("text required", 400);
  try {
    const senderRole = await resolveSenderRole(id, user);
    const msg = await sendMessage(id, user.id, text, senderRole);
    return jsonOk(msg, 201);
  } catch (e) { return jsonError(clientErrorMessage(e, "send failed"), 400); }
}
