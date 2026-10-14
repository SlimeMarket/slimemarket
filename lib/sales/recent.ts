import { supabaseAdminClient } from "@/lib/supabase/admin-client";

export interface RecentSale {
  id: string;
  productName: string;
  storeName: string;
  buyerAnon: string;
  amount: number;
  time: string;
}

function censorName(name: string): string {
  if (!name || name.length <= 3) return name + "***";
  return name.slice(0, 4) + "***";
}

export async function getRecentSales(limit = 10): Promise<RecentSale[]> {
  const admin = supabaseAdminClient();

  const { data: orders, error } = await admin
    .from("orders")
    .select("id, product_id, store_id, buyer_id, amount, created_at")
    .eq("status", "DONE")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !orders?.length) return [];

  const productIds = [...new Set(orders.map((o) => o.product_id))];
  const storeIds = [...new Set(orders.map((o) => o.store_id))];
  const buyerIds = [...new Set(orders.map((o) => o.buyer_id))];

  const [{ data: products }, { data: stores }, { data: buyers }] = await Promise.all([
    admin.from("products").select("id, name").in("id", productIds),
    admin.from("stores").select("id, name").in("id", storeIds),
    admin.from("users").select("id, name").in("id", buyerIds),
  ]);

  const productMap = new Map((products ?? []).map((p: { id: string; name: string }) => [p.id, p.name]));
  const storeMap = new Map((stores ?? []).map((s: { id: string; name: string }) => [s.id, s.name]));
  const buyerMap = new Map((buyers ?? []).map((b: { id: string; name: string }) => [b.id, censorName(b.name)]));

  return orders.map((o) => ({
    id: o.id,
    productName: productMap.get(o.product_id) ?? "Unknown",
    storeName: storeMap.get(o.store_id) ?? "Unknown",
    buyerAnon: buyerMap.get(o.buyer_id) ?? "Anon***",
    amount: Number(BigInt(o.amount as string)) / 1_000_000,
    time: new Date(o.created_at).toLocaleString("en-US", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    }),
  }));
}
