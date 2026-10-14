import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { sendOrder } from "@/lib/order/transitions";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const { id } = await params;
  let body: unknown; try { body = await req.json(); } catch { body = {}; }
  const { credentials, notes } = (body ?? {}) as { credentials?: Record<string, string>; notes?: string };
  try { await sendOrder(id, user, credentials ?? {}, notes ?? ""); return jsonOk({ status: "SENT" }); }
  catch (e) { return jsonError(clientErrorMessage(e, "send failed"), 400); }
}
