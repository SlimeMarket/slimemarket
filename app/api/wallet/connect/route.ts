/**
 * POST /api/wallet/connect
 * Link an external wallet address to the authenticated user's account.
 * Body: { address: "0x…", chain?: "arcTestnet" }
 */
import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  let body: { address?: string; chain?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  const address = (body.address || "").trim().toLowerCase();
  const chain = body.chain || "arcTestnet";

  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return jsonError("invalid wallet address", 400);
  }

  try {
    const sb = supabaseAdminClient();
    // Upsert: update last_used_at if already linked
    const { data, error } = await sb
      .from("external_wallets")
      .upsert(
        { user_id: user.id, address, chain, last_used_at: new Date().toISOString() },
        { onConflict: "user_id,address" }
      )
      .select()
      .single();

    if (error) {
      console.error("wallet connect upsert error:", error);
      return jsonError("failed to link wallet", 500);
    }

    return jsonOk({ linked: true, wallet: data });
  } catch (e) {
    console.error("wallet connect error:", e);
    return jsonError("internal error", 500);
  }
}
