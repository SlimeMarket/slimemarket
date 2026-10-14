import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { getStoreReviews } from "@/lib/catalog/stores";

/**
 * GET /api/stores/:uid/reviews
 * Verified-purchase reviews for a store (public).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ uid: string }> }
) {
  const { uid } = await params;
  try {
    const reviews = await getStoreReviews(uid);
    return jsonOk({ items: reviews });
  } catch (e) {
    return jsonError(clientErrorMessage(e, "failed to get reviews"), 500);
  }
}
