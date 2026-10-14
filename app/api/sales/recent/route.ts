import { getRecentSales } from "@/lib/sales/recent";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "10"), 1), 50);
  try {
    const sales = await getRecentSales(limit);
    return jsonOk({ items: sales });
  } catch (e) {
    return jsonError(clientErrorMessage(e, "error"), 500);
  }
}
