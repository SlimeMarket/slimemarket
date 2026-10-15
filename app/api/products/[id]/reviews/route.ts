import { jsonError, jsonOk, clientErrorMessage } from "@/lib/utils";
import { getProductReviews } from "@/lib/catalog/stores";

/**
 * GET /api/products/:id/reviews
 * Verified-purchase reviews for a single product (public) + rating summary.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const result = await getProductReviews(id);
    return jsonOk(result);
  } catch (e) {
    return jsonError(clientErrorMessage(e, "failed to get product reviews"), 500);
  }
}
