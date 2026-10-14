import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { getStoreByUid } from "@/lib/catalog/stores";

/**
 * GET /api/stores/:uid
 * Store profile (public).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ uid: string }> }
) {
  const { uid } = await params;
  try {
    const store = await getStoreByUid(uid);
    if (!store) return jsonError("store not found", 404);
    return jsonOk(store);
  } catch (e) {
    return jsonError(clientErrorMessage(e, "failed to get store"), 500);
  }
}
