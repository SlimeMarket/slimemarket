/**
 * GET /api/wallet/external
 * List external wallets linked to the authenticated user.
 */
import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  try {
    const sb = supabaseAdminClient();
    const { data, error } = await sb
      .from("external_wallets")
      .select("id, address, chain, connected_at, last_used_at")
      .eq("user_id", user.id)
      .order("connected_at", { ascending: false });

    if (error) {
      console.error("external wallets fetch error:", error);
      return jsonError("failed to fetch wallets", 500);
    }

    return jsonOk({ wallets: data || [] });
  } catch (e) {
    console.error("external wallets error:", e);
    return jsonError("internal error", 500);
  }
}
