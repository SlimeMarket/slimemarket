import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { declineOrder } from "@/lib/order/transitions";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const { id } = await params;
  let body: unknown; try { body = await req.json(); } catch { body = {}; }
  const reason = ((body ?? {}) as { reason?: string }).reason || "Declined";
  try { await declineOrder(id, user, reason); return jsonOk({ status: "DECLINED" }); }
  catch (e) { return jsonError(clientErrorMessage(e, "decline failed"), 400); }
}
