import { requireRole } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { ensureDisputeThread } from "@/lib/order/disputes";
import { getThreadMessages } from "@/lib/chat/queries";

/**
 * GET /api/admin/disputes/[id]/chat — Get or create mediasi chat thread for a dispute.
 *
 * Returns the thread ID + messages. Auto-creates thread if not exists
 * (adds buyer + seller + all admins as participants).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireRole("Admin");
  } catch {
    return jsonError("Admin role required", 403);
  }

  const { id: orderId } = await params;

  try {
    const threadId = await ensureDisputeThread(orderId);
    const messages = await getThreadMessages(threadId, user.id, user.role);
    return jsonOk({ threadId, orderId, messages });
  } catch (e) {
    return jsonError(clientErrorMessage(e, "failed"), 500);
  }
}
