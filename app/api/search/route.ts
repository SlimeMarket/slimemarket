import { jsonError, jsonOk, clientErrorMessage } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth-ucw";
import { searchCatalog } from "@/lib/catalog/search";

/**
 * GET /api/search?q=&cat=
 *
 * The single search endpoint behind the topbar: products, sellers/stores and
 * (for the signed-in owner) an order by id or short id.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  const cat = url.searchParams.get("cat");

  if (!q) return jsonOk({ q, products: [], stores: [], order: null });

  // Orders are scoped to the caller; search itself is public, so a missing
  // session just means "no order result".
  const user = await getCurrentUser().catch(() => null);

  try {
    const result = await searchCatalog({ q, cat, userId: user?.id ?? null });
    return jsonOk({ q, ...result });
  } catch (e) {
    return jsonError(clientErrorMessage(e, "search failed"), 500);
  }
}
