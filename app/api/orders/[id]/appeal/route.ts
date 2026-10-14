import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { appealOrder } from "@/lib/order/transitions";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  const { id } = await params;
  let body: unknown; try { body = await req.json(); } catch { body = {}; }
  const reason = ((body ?? {}) as { reason?: string }).reason || "Sengketa";
  try { await appealOrder(id, user, reason); return jsonOk({ status: "DISPUTED" }); }
  catch (e) {
    const t = e as { httpStatus?: number; code?: string; message?: string };
    if (typeof t.httpStatus === "number") return jsonError(t.message ?? "appeal failed", t.httpStatus, { code: t.code });
    return jsonError(clientErrorMessage(e, "appeal failed"), 400);
  }
}
