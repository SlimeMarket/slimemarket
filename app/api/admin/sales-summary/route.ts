import { requireRole } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/** Convert micro-USDC bigint to decimal USDC number */
function microToDecimal(micro: bigint): number {
  return Number(micro) / 1_000_000;
}

/**
 * GET /api/admin/sales-summary — Aggregate sales data (admin-only).
 * Returns marketplace (standard) + WL escrow revenue, separated.
 */
export async function GET() {
  try {
    await requireRole("Admin");
  } catch {
    return jsonError("Admin role required", 403);
  }

  const admin = supabaseAdminClient();

  // ============ MARKETPLACE (Standard) ============
  const { data: orders, error: ordersErr } = await admin
    .from("orders")
    .select(`
      id, amount, qty, status, product_id, circle_fee, gas_fee,
      products!inner ( id, name, store_id ),
      stores!inner ( id, name, owner_user_id )
    `)
    .eq("status", "DONE")
    .order("created_at", { ascending: false });

  if (ordersErr) return jsonError(ordersErr.message, 500);

  const rows = orders ?? [];
  let mkVolumeMicro = 0n;
  let mkOrders = 0;
  let mkCircleGasMicro = 0n;
  const sellerMap = new Map<string, { name: string; volumeMicro: bigint; orderCount: number }>();
  const productMap = new Map<string, { name: string; sold: number; revenueMicro: bigint }>();

  for (const r of rows as Record<string, unknown>[]) {
    const amount = BigInt(r.amount as string);
    mkVolumeMicro += amount;
    mkCircleGasMicro += BigInt(r.circle_fee as string) + BigInt(r.gas_fee as string);
    mkOrders++;

    const store = r.stores as { name: string; owner_user_id: string } | null;
    const product = r.products as { id: string; name: string; store_id: string } | null;

    if (store) {
      const key = store.owner_user_id;
      const cur = sellerMap.get(key) ?? { name: store.name, volumeMicro: 0n, orderCount: 0 };
      cur.volumeMicro += amount;
      cur.orderCount++;
      sellerMap.set(key, cur);
    }

    if (product) {
      const cur = productMap.get(product.id) ?? { name: product.name, sold: 0, revenueMicro: 0n };
      cur.sold += r.qty as number;
      cur.revenueMicro += amount;
      productMap.set(product.id, cur);
    }
  }

  // Marketplace platform fee the buyer pays 2% at creation AND the
  // seller has 2% deducted at release, so the platform take is 4% of volume.
  const mkPlatformFeesMicro = (mkVolumeMicro * (200n + 200n)) / 10000n;
  // Total marketplace revenue = platform fee + circle/gas
  const mkRevenueMicro = mkPlatformFeesMicro + mkCircleGasMicro;

  const topSellers = [...sellerMap.entries()]
    .sort((a, b) => Number(b[1].volumeMicro - a[1].volumeMicro))
    .slice(0, 5)
    .map(([, v]) => ({
      name: v.name,
      volume: microToDecimal(v.volumeMicro),
      orderCount: v.orderCount,
    }));

  const topProducts = [...productMap.entries()]
    .sort((a, b) => b[1].sold - a[1].sold)
    .slice(0, 5)
    .map(([, v]) => ({
      name: v.name,
      sold: v.sold,
      revenue: microToDecimal(v.revenueMicro),
    }));

  // ============ WL ESCROW ============
  const { data: deals, error: dealsErr } = await admin
    .from("wl_deals")
    .select(`
      id, price, base_fee, total, qty, status,
      seller:users!wl_deals_seller_id_fkey ( id, name ),
      listing:wl_listings ( project )
    `)
    .eq("status", "COMPLETED")
    .order("created_at", { ascending: false });

  if (dealsErr) return jsonError(dealsErr.message, 500);

  const dealRows = deals ?? [];
  let wlVolumeMicro = 0n;
  let wlBaseFeeMicro = 0n;
  let wlCircleGasMicro = 0n;
  let wlDeals = 0;
  const wlSellerMap = new Map<string, { name: string; volumeMicro: bigint; dealCount: number }>();

  for (const d of dealRows as Record<string, unknown>[]) {
    const price = BigInt(d.price as string);
    const base = BigInt(d.base_fee as string);
    const total = BigInt(d.total as string);
    wlVolumeMicro += price;
    // derive the WL buyer fee from `price` (2%) instead of trusting the
    // stored `base_fee`, which was persisted as 0 while the contract charged
    // computeFee(price). The chain is the source of truth, so mirror the chain.
    wlBaseFeeMicro += (price * 200n) / 10000n;
    // total = price + base + circle + gas (set in proceed_wl_deal_atomic)
    wlCircleGasMicro += (total - price - base);
    wlDeals++;

    const seller = d.seller as { id: string; name: string } | null;
    if (seller) {
      const cur = wlSellerMap.get(seller.id) ?? { name: seller.name, volumeMicro: 0n, dealCount: 0 };
      cur.volumeMicro += price;
      cur.dealCount++;
      wlSellerMap.set(seller.id, cur);
    }
  }

  // WL revenue = buyer fee (2%) + circle/gas. No seller-side fee on WL, so the
  // platform take here is 2% of deal volume (half the marketplace rate).
  const wlRevenueMicro = wlBaseFeeMicro + wlCircleGasMicro;

  const topEscrowSellers = [...wlSellerMap.entries()]
    .sort((a, b) => Number(b[1].volumeMicro - a[1].volumeMicro))
    .slice(0, 5)
    .map(([, v]) => ({
      name: v.name,
      volume: microToDecimal(v.volumeMicro),
      dealCount: v.dealCount,
    }));

  // ============ COMBINED ============
  return jsonOk({
    // Marketplace
    marketplace: {
      totalVolume: microToDecimal(mkVolumeMicro),
      platformFees: microToDecimal(mkPlatformFeesMicro),
      circleGasRevenue: microToDecimal(mkCircleGasMicro),
      totalRevenue: microToDecimal(mkRevenueMicro),
      totalOrders: mkOrders,
      topSellers,
      topProducts,
    },
    // WL Escrow
    escrow: {
      totalVolume: microToDecimal(wlVolumeMicro),
      baseFeeRevenue: microToDecimal(wlBaseFeeMicro),
      circleGasRevenue: microToDecimal(wlCircleGasMicro),
      totalRevenue: microToDecimal(wlRevenueMicro),
      totalDeals: wlDeals,
      topSellers: topEscrowSellers,
    },
    // Combined totals
    combined: {
      totalVolume: microToDecimal(mkVolumeMicro + wlVolumeMicro),
      totalRevenue: microToDecimal(mkRevenueMicro + wlRevenueMicro),
      totalOrders: mkOrders + wlDeals,
    },
  });
}
