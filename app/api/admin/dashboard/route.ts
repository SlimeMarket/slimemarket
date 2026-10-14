/**
 * GET /api/admin/dashboard
 *
 * Quick overview data for admin dashboard.
 * Returns today's revenue, pending sellers, active disputes, fee summary.
 */
import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { arcPublicClient } from "@/lib/arc";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.role !== "Admin") return jsonError("admin role required", 403);

  const admin = supabaseAdminClient();

  // Today's revenue (marketplace + escrow fees)
  const todayRevenueQuery = `
    SELECT COALESCE(SUM(amount), 0) as total_revenue,
           COUNT(*) as order_count
    FROM orders o
    WHERE created_at >= CURRENT_DATE - INTERVAL '1 day'
      AND delivery = 'instant'
  `;

  const { data: todayData } = await admin.rpc("sql_simple_query", { query: todayRevenueQuery });
  const todayRevenue = todayData?.[0]?.total_revenue ? Number(todayData[0].total_revenue) / 1_000_000 : 0;
  const todayOrders = todayData?.[0]?.order_count || 0;

  // Pending seller applications count
  const pendingAppsResult = await admin.from("seller_applications").select("id").eq("status", "pending");
  const pendingSellerCount = pendingAppsResult.data?.length || 0;

  // Active disputes count
  const disputesResult = await admin.from("orders").select("id").eq("status", "DISPUTED");
  const activeDisputes = disputesResult.data?.length || 0;

  // Fee pool breakdown (pending vs collected).

  // this query was INVALID SQL and every call failed, leaving the
  // admin console's fee pool permanently at $0.00:
  //   1. `manual_pending` applied TWO `FILTER (WHERE …)` clauses to a single
  //      aggregate. Postgres allows only one → syntax error → the whole
  //      `sql_simple_query` RPC failed.
  //   2. `instant_pending` had NO `delivery = 'instant'` predicate, so it
  //      actually summed pending orders of BOTH delivery types, double-counting
  //      them against `manual_pending`.
  // Rewritten with CASE so each column carries its own complete predicate and
  // there is exactly one filter per aggregate.
  const feesQuery = `
    SELECT
      SUM(CASE WHEN delivery = 'instant' AND status IN ('DONE', 'RELEASED') THEN amount ELSE 0 END) AS instant_collected,
      SUM(CASE WHEN delivery = 'instant' AND status IN ('PENDING', 'PROCESS', 'SENT') THEN amount ELSE 0 END) AS instant_pending,
      SUM(CASE WHEN delivery <> 'instant' AND status IN ('DONE', 'RELEASED') THEN amount ELSE 0 END) AS manual_collected,
      SUM(CASE WHEN delivery <> 'instant' AND status IN ('PENDING', 'PROCESS', 'SENT') THEN amount ELSE 0 END) AS manual_pending
    FROM orders
    WHERE delivery IN ('instant', 'manual')
  `;

  const { data: feesData } = await admin.rpc("sql_simple_query", { query: feesQuery });
  const feePool = {
    instant: {
      collected: feesData?.[0]?.instant_collected ? Number(feesData[0].instant_collected) / 1_000_000 : 0,
      pending: feesData?.[0]?.instant_pending ? Number(feesData[0].instant_pending) / 1_000_000 : 0,
    },
    manual: {
      collected: feesData?.[0]?.manual_collected ? Number(feesData[0].manual_collected) / 1_000_000 : 0,
      pending: feesData?.[0]?.manual_pending ? Number(feesData[0].manual_pending) / 1_000_000 : 0,
    },
  };

  // Platform DCW balance (real-time from Arc RPC)
  let platformBalance = 0;
  try {
    const walletId = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";
    if (walletId) {
      const balanceResponse = await fetch(
        `https://api.circle.com/v1/w3s/wallets/${walletId}/balances`,
        {
          headers: {
            "Authorization": `Bearer ${process.env.CIRCLE_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );
      if (balanceResponse.ok) {
        const balanceData = await balanceResponse.json();
        const usdcBalance = balanceData.data?.tokenBalances?.find((b: any) => b.token?.symbol === "USDC");
        platformBalance = usdcBalance?.amount ? parseFloat(usdcBalance.amount) : 0;
      }
    }
  } catch (e) {
    console.warn("Failed to fetch platform balance:", e);
  }

  // Recent audit log entries (last 10)
  // FIX (2026-09-27): `audit_log` has no `time`/`actor_type` columns (those are
  // on `mm_audit_log`). The wrong names made this query error out silently, so
  // the dashboard's audit panel was always empty.
  const auditResult = await admin.from("audit_log").select("id, actor_id, action, ref, detail, created_at").order("created_at", { ascending: false }).limit(10);
  const recentAuditLog = auditResult.data || [];

  // Quick actions (pending approvals, stuck orders)
  // `stuckOrders` used to be `Math.floor(Math.random() * 2) + 1`: an
  // invented number in the ops console. It is now the real count of orders that
  // are mid-flight with a failed/pending on-chain leg, which is exactly what an
  // operator needs to see. `reconcileQueue` is gone: it read a table nothing
  // ever wrote (`add_to_reconciliation_queue` has no callers).
  const { count: stuckOrders } = await admin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .in("on_chain_status", ["release_failed", "refund_failed", "create_pending"]);

  const quickActions = {
    pendingApprovers: pendingSellerCount,
    stuckOrders: stuckOrders ?? 0,
  };

  return jsonOk({
    today: {
      revenue: todayRevenue,
      orders: todayOrders,
    },
    pendingSellerCount,
    activeDisputes,
    feePool,
    platformBalance,
    recentAuditLog,
    quickActions,
  });
}
