/**
 * POST /api/my/sales-summary
 *
 * Seller income analytics for the current authenticated user: monthly
 * breakdown, top products, order stats.
 *
 * the seller now pays a 2% platform fee on marketplace orders (deducted
 * at release), so every revenue figure here reports BOTH sides:
 *   - gross  = SUM(orders.amount)              (item subtotal)
 *   - net    = gross - 2% seller fee           (what the seller actually receives)
 *   - fees   = gross * 4%                      (buyer 2% + seller 2%)
 */
import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/** Buyer fee (200 bps) + seller fee (200 bps) = 400 bps platform take. */
const PLATFORM_TAKE_BPS = 400n;
/** Seller receives 100% - 200 bps = 9800 bps. */
const SELLER_NET_BPS = 9800n;

const BPS_DENOMINATOR = 10000n;

/** `(SUM(amount) * bps) / 10000` as an integer, in micro-USDC. */
function applyBps(micro: unknown, bps: bigint): bigint {
  if (micro == null) return 0n;
  return (BigInt(String(micro)) * bps) / BPS_DENOMINATOR;
}

function toUsdc(micro: unknown): number {
  return micro == null ? 0 : Number(BigInt(String(micro))) / 1_000_000;
}

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.role !== "Seller" && user.role !== "Admin") {
    return jsonError("seller or admin role required", 403);
  }

  const admin = supabaseAdminClient();

  // Get user's store (to filter orders/products by store_id)
  const { data: store } = user.role === "Seller"
    ? await admin.from("stores").select("id").eq("owner_user_id", user.id).maybeSingle()
    : { data: null };

  // Store scoping.

  // two problems here:
  //   1. Admin was treated as a seller with no store, so `storeFilter` became
  //      `store_id IS NULL` and the platform-wide view returned almost nothing.
  //      Admins now see every order.
  //   2. The expression is aliased because the top-products query joins
  //      `orders o LEFT JOIN products p` and an unqualified `store_id` would be
  //      ambiguous (products has its own store_id).

  // The clause must be parenthesised at the call site: without it, SQL
  // precedence turns `A OR B AND C` into `A OR (B AND C)`, silently dropping the
  // date filter and returning every month ever.
  const storeClause = (alias: string): string => {
    const p = alias ? `${alias}.` : "";
    if (user.role === "Admin") return "TRUE"; // platform-wide
    // A seller with no store yet must see zero rows — `store_id IS NULL`
    // matches nothing real rather than leaking other sellers' orders.
    return store?.id ? `${p}store_id = '${store.id}'` : `${p}store_id IS NULL`;
  };

  // 1. Monthly revenue (last 12 months).

  // the `delivery = 'instant'` filter is GONE. It was applied to
  // every query in this file, so a seller whose products use MANUAL delivery
  // (the core flow for physical goods) saw $0 revenue across the whole
  // dashboard. Delivery type says nothing about whether money was earned.
  const monthlyRevenueQuery = `
    SELECT
      DATE_TRUNC('month', created_at) as month_start,
      COUNT(*) FILTER (WHERE status IN ('DONE', 'RELEASED')) as completed_orders,
      COALESCE(SUM(amount) FILTER (WHERE status IN ('DONE', 'RELEASED')), 0) as total_gross
    FROM orders
    WHERE (${storeClause("")})
      AND created_at >= NOW() - INTERVAL '12 months'
    GROUP BY month_start
    ORDER BY month_start ASC
  `;

  const { data: monthlyData, error: monthlyErr } = await admin.rpc(
    "sql_simple_query",
    { query: monthlyRevenueQuery }
  );
  if (monthlyErr) return jsonError(monthlyErr.message, 500);

  // Fill empty months so the chart has a continuous 12-month axis.
  const months: Array<{ month: string; revenue: number; net: number; orders: number; fees: number }> = [];
  const currentDate = new Date();

  for (let i = 11; i >= 0; i--) {
    const monthDate = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
    const monthLabel = monthDate.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    const monthKey = monthDate.toISOString().slice(0, 7); // YYYY-MM

    const existingMonth = monthlyData?.find((m: { month_start: string }) =>
      String(m.month_start).slice(0, 7) === monthKey,
    );

    const grossMicro = existingMonth?.total_gross ?? 0n;
    months.push({
      month: monthLabel,
      revenue: toUsdc(grossMicro), // gross (item subtotal)
      net: toUsdc(applyBps(grossMicro, SELLER_NET_BPS)), // what the seller receives
      orders: Number(existingMonth?.completed_orders || 0),
      fees: toUsdc(applyBps(grossMicro, PLATFORM_TAKE_BPS)),
    });
  }

  // 2. Current vs previous month
  const currentMonthData = months[months.length - 1];
  const previousMonthData = months[months.length - 2];

  let growthPercentage = 0;
  if (previousMonthData && previousMonthData.net > 0) {
    growthPercentage = ((currentMonthData.net - previousMonthData.net) / previousMonthData.net) * 100;
  }

  // 3. All-time totals.

  // `SUM(amount)` used to include EVERY status (PENDING, CANCELLED,
  // REFUNDED…), so all-time revenue was systematically overstated versus the
  // DONE-filtered monthly figures. Gross is now restricted to settled statuses,
  // and a separate `completed_orders` is returned so the average is computed
  // against orders that actually produced revenue.
  const allTimeQuery = `
    SELECT
      COUNT(*) as total_orders,
      COUNT(*) FILTER (WHERE status IN ('DONE', 'RELEASED')) as completed_orders,
      COALESCE(SUM(amount) FILTER (WHERE status IN ('DONE', 'RELEASED')), 0) as total_gross
    FROM orders
    WHERE (${storeClause("")})
  `;

  const { data: allTimeData } = await admin.rpc("sql_simple_query", { query: allTimeQuery });

  const allTimeGrossMicro = allTimeData?.[0]?.total_gross ?? 0n;
  const allTimeRevenue = toUsdc(allTimeGrossMicro); // gross (settled only)
  const allTimeNet = toUsdc(applyBps(allTimeGrossMicro, SELLER_NET_BPS));
  const allTimeFees = toUsdc(applyBps(allTimeGrossMicro, PLATFORM_TAKE_BPS));

  const allTimeOrders = allTimeData?.[0]?.total_orders || 0;
  const allTimeCompletedOrders = allTimeData?.[0]?.completed_orders || 0;
  const avgOrderValue = allTimeCompletedOrders > 0 ? allTimeNet / allTimeCompletedOrders : 0;

  // 4. Top 5 products by revenue
  const topProductsQuery = `
    SELECT
      p.name as product_name,
      COALESCE(SUM(o.amount), 0) as total_gross,
      COALESCE(COUNT(*), 0) as order_count
    FROM orders o
    LEFT JOIN products p ON o.product_id = p.id
    WHERE (${storeClause("o")})
      AND o.status IN ('DONE', 'RELEASED')
      AND p.name IS NOT NULL
    GROUP BY p.name
    ORDER BY total_gross DESC
    LIMIT 5
  `;

  const { data: topProducts, error: productsErr } = await admin.rpc("sql_simple_query", {
    query: topProductsQuery
  });
  if (productsErr) return jsonError(productsErr.message, 500);

  // 5. Order status breakdown
  const statusBreakdownQuery = `
    SELECT
      status,
      COUNT(*) as count
    FROM orders
    WHERE (${storeClause("")})
    GROUP BY status
    ORDER BY
      CASE status
        WHEN 'DONE' THEN 1
        WHEN 'PENDING' THEN 2
        WHEN 'PROCESS' THEN 3
        WHEN 'SENT' THEN 4
        WHEN 'DISPUTED' THEN 5
        ELSE 6
      END
  `;

  const { data: statusData } = await admin.rpc("sql_simple_query", {
    query: statusBreakdownQuery
  });

  const statusBreakdown: Record<string, number> = {};
  statusData?.forEach((item: { status: string; count: number }) => {
    statusBreakdown[item.status] = item.count;
  });

  return jsonOk({
    monthlyRevenue: months,
    currentMonth: {
      revenue: currentMonthData.revenue,
      net: currentMonthData.net,
      fees: currentMonthData.fees,
      orders: currentMonthData.orders,
      growth: Math.round(growthPercentage * 100) / 100,
    },
    // Gross (item subtotal) and net (after the 2% seller fee) are both returned
    // so the UI can show "omzet" and "net margin" without recomputing the fee.
    allTimeRevenue,
    allTimeNet,
    allTimeFees,
    allTimeOrders,
    /** Subset of allTimeOrders that actually produced revenue (DONE/RELEASED). */
    allTimeCompletedOrders,
    avgOrderValue,
    topProducts: (topProducts || []).map((p: { product_name: string; total_gross: unknown; order_count: number }) => ({
      name: p.product_name,
      revenue: toUsdc(p.total_gross),
      net: toUsdc(applyBps(p.total_gross, SELLER_NET_BPS)),
      orders: p.order_count,
    })),
    statusBreakdown,
  });
}
