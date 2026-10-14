import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { listThreads } from "@/lib/chat/queries";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { toSenderRole } from "@/lib/wl/chat";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const threads = await listThreads(user.id);
  return jsonOk({ items: threads });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  const body = await req.json().catch(() => ({}));
  const participantId = String(body.participantId ?? "");
  const type = String(body.type ?? "normal");
  const initialMessage = String(body.initialMessage ?? "");
  const orderId = body.orderId ? String(body.orderId) : null;

  if (!participantId) return jsonError("participantId required", 400);

  const admin = supabaseAdminClient();
  const { data: thread, error } = await admin.from("chat_threads").insert({
    participant_ids: [user.id, participantId],
    type,
    status: "active",
    order_id: orderId,
  }).select("id").single();
  if (error) return jsonError(dbErrorMessage("chats", error), 500);

  if (initialMessage) {
    // `sender_role` used to be hard-coded to "buyer", so a SELLER
    // opening the thread had their own opening message mislabelled as the
    // buyer's. Any UI that aligns bubbles by sender_role then rendered the
    // seller's message as "mine". Map the real account role instead
    // (Member/MM are rejected by the sender_role CHECK, hence toSenderRole).
    const { error: msgErr } = await admin.from("chat_messages").insert({
      thread_id: thread.id,
      sender_id: user.id,
      sender_role: toSenderRole(user.role),
      text: initialMessage,
    });
    // Previously unchecked: a failed insert still returned 201 and the caller
    // believed the thread had an opening message.
    if (msgErr) {
      return jsonError(`thread created but opening message failed: ${msgErr.message}`, 500);
    }
    const { error: updErr } = await admin
      .from("chat_threads")
      .update({ last_text: initialMessage, last_time: new Date().toISOString() })
      .eq("id", thread.id);
    if (updErr) {
      // Non-fatal: the thread + message exist; only the preview is stale.
      console.error("chat thread preview update failed:", updErr.message);
    }
  }
  return jsonOk({ id: thread.id }, 201);
}

