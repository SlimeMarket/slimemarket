import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { listProducts } from "@/lib/catalog/products";

/**
 * GET /api/products?cat=&q=&page=
 * Public catalog list. Money returned as decimal USDC.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const cat = url.searchParams.get("cat");
  const q = url.searchParams.get("q");
  const pageParam = url.searchParams.get("page");
  const page = pageParam ? Math.max(1, parseInt(pageParam, 10) || 1) : 1;

  try {
    const result = await listProducts({ cat, q, page });
    return jsonOk(result);
  } catch (e) {
    return jsonError(clientErrorMessage(e, "failed to list products"), 500);
  }
}
