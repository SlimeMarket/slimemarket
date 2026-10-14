/**
 * GET /api/admin/wallet-txs
 * 
 * Returns recent wallet transactions for admin treasury view.
 */
import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.role !== "Admin") return jsonError("admin role required", 403);

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);

  const admin = supabaseAdminClient();

  const { data: txs, error } = await admin
    .from("wallet_txs")
    .select("id, type, label, sub, amount, status, method, circle_tx_id, arc_tx_hash, created_at, wallet_id")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("wallet-txs fetch error:", error);
    return jsonError("Failed to fetch wallet transactions", 500);
  }

  return jsonOk({
    items: (txs || []).map((t) => ({
      ...t,
      amount: Number(t.amount) / 1_000_000, // micro-USDC to display
    })),
  });
}
