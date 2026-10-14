import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { reviewOrder } from "@/lib/order/transitions";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const { id } = await params;
  let body: unknown; try { body = await req.json(); } catch { body = {}; }
  const { rating, comment } = (body ?? {}) as { rating?: number; comment?: string };
  if (!rating) return jsonError("rating required", 400);
  try { await reviewOrder(id, user, rating, comment ?? ""); return jsonOk({ ok: true }); }
  catch (e) { return jsonError(clientErrorMessage(e, "review failed"), 400); }
}
