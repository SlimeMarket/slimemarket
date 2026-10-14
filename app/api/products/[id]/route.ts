import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { getProduct } from "@/lib/catalog/products";

/**
 * GET /api/products/:id
 * Single product detail (public). Money as decimal USDC.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const product = await getProduct(id);
    if (!product) return jsonError("product not found", 404);
    return jsonOk(product);
  } catch (e) {
    return jsonError(clientErrorMessage(e, "failed to get product"), 500);
  }
}
