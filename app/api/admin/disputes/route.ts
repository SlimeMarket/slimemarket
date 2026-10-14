import { requireRole } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { listDisputes } from "@/lib/order/disputes";

/**
 * GET /api/admin/disputes — List all DISPUTED marketplace orders.
 * Admin role check only (read-only, no PIN needed).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireRole("Admin");
  } catch {
    return jsonError("Admin role required", 403);
  }

  try {
    const disputes = await listDisputes();
    return jsonOk({ items: disputes, total: disputes.length });
  } catch (e) {
    return jsonError(clientErrorMessage(e, "failed to list disputes"), 500);
  }
}
