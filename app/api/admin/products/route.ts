import { gateRole } from "@/lib/api-gate";
import { jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/** GET — list products for admin */
export async function GET(req: Request) {
  const gate = await gateRole("Admin");
  if (gate.error) return gate.error;
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() || "";
  const frozen = url.searchParams.get("frozen");
  const storeId = url.searchParams.get("store_id") || "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
  const offset = parseInt(url.searchParams.get("offset") || "0");

  const admin = supabaseAdminClient();
  let query = admin
    .from("products")
    .select("id, name, category, price, status, frozen, frozen_reason, frozen_at, stock, sold, views, store_id, stores!inner(name)")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (q) query = query.ilike("name", `%${q}%`);
  if (frozen === "true") query = query.eq("frozen", true);
  else if (frozen === "false") query = query.eq("frozen", false);
  if (storeId) query = query.eq("store_id", storeId);

  const { data, error } = await query;
  if (error) return jsonError(dbErrorMessage("admin/products", error), 500);

  const items = (data ?? []).map((p: Record<string, unknown> & { stores?: { name?: string } | { name?: string }[] }) => ({
    id: p.id, name: p.name, category: p.category, price: p.price,
    status: p.status, frozen: p.frozen, frozen_reason: p.frozen_reason,
    frozen_at: p.frozen_at, stock: p.stock, sold: p.sold, views: p.views,
    store_id: p.store_id,
    store_name: Array.isArray(p.stores) ? p.stores[0]?.name : p.stores?.name,
  }));

  return jsonOk({ items });
}
