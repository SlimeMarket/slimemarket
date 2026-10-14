import { supabaseAdminClient } from "@/lib/supabase/admin-client";

export interface SalesRecap {
  period: string;
  totalSales: number;
  totalTx: number;
  platformFee: number;
  topSeller: { name: string; sales: number } | null;
  topProduct: { name: string; sold: number } | null;
  activeBuyers: number;
  avgOrderValue: number;
}

/**
 * Parse a micro-USDC amount to whole USDC.
 *
 * `ledger_entries.amount` is a `bigint`/numeric column that PostgREST returns
 * as a string, but it can be null or a non-integer string in edge cases.
 * `BigInt("")` / `BigInt(null)` throw a SyntaxError, which used to bubble up
 * as a bare HTTP 500 from `GET /api/sales/stats`. Treat anything unparseable
 * as 0 rather than crashing the whole recap.
 */
function microToUsdc(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  try {
    return Number(BigInt(String(raw).trim())) / 1_000_000;
  } catch {
    const n = Number(raw);
    return Number.isFinite(n) ? n / 1_000_000 : 0;
  }
}

export async function getSalesRecap(period: "weekly" | "monthly"): Promise<SalesRecap> {
  const admin = supabaseAdminClient();
  const now = new Date();
  const since =
    period === "weekly"
      ? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
      : new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  // Total sales + fee
  const { data: ledger } = await admin
    .from("ledger_entries")
    .select("amount, account")
    .gte("created_at", since)
    .in("account", ["seller_payout", "platform_fee"]);

  let totalSales = 0;
  let platformFee = 0;
  (ledger ?? []).forEach((r: { amount: string; account: string }) => {
    const amt = microToUsdc(r.amount);
    if (r.account === "seller_payout") totalSales += amt;
    else if (r.account === "platform_fee") platformFee += amt;
  });

  // Transaction count
  const { count: txCount } = await admin
    .from("orders")
    .select("*", { count: "exact", head: true })
    .eq("status", "DONE")
    .gte("created_at", since);

  // Top seller
  const { data: topSeller } = await admin
    .from("ledger_entries")
    .select("wallet_id, amount")
    .eq("account", "seller_payout")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1);

  let topSellerName: string | null = null;
  let topSellerSales = 0;
  if (topSeller?.length) {
    const { data: wallet } = await admin
      .from("wallets")
      .select("user_id")
      .eq("id", topSeller[0].wallet_id)
      .maybeSingle();
    if (wallet) {
      const { data: user } = await admin
        .from("users")
        .select("name")
        .eq("id", wallet.user_id)
        .maybeSingle();
      topSellerName = user?.name ?? null;
    }
    topSellerSales = microToUsdc(topSeller[0].amount);
  }

  // Top product
  const { data: topProduct } = await admin
    .from("products")
    .select("name, sold")
    .gte("updated_at", since)
    .order("sold", { ascending: false })
    .limit(1);

  // Active buyers
  const { count: buyers } = await admin
    .from("orders")
    .select("buyer_id", { count: "exact", head: true })
    .gte("created_at", since);

  return {
    period:
      period === "weekly"
        ? `${new Date(since).toLocaleDateString("en-US")} - ${now.toLocaleDateString("en-US")}`
        : `${now.toLocaleString("en-US", { month: "long" })} ${now.getFullYear()}`,
    totalSales: Math.round(totalSales * 100) / 100,
    totalTx: txCount ?? 0,
    platformFee: Math.round(platformFee * 100) / 100,
    topSeller: topSellerName ? { name: topSellerName, sales: topSellerSales } : null,
    topProduct: topProduct?.length
      ? { name: topProduct[0].name as string, sold: topProduct[0].sold as number }
      : null,
    activeBuyers: buyers ?? 0,
    avgOrderValue: txCount && totalSales > 0 ? Math.round((totalSales / txCount) * 100) / 100 : 0,
  };
}
