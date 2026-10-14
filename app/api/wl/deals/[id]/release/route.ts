import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { requireStaffAuth } from "@/lib/admin-auth";
import { releaseDeal } from "@/lib/wl/transitions";

// 3 — Admin OR MM (middleman) may release; release execution
// still relays via the platform DCW wallet (unchanged).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireStaffAuth(req);
  if (auth.error) return auth.error;
  const { user } = auth;
  const { id } = await params;
  try { await releaseDeal(id, user.id); return jsonOk({ status: "COMPLETED" }); }
  catch (e) { return jsonError(clientErrorMessage(e, "release failed"), 400); }
}
