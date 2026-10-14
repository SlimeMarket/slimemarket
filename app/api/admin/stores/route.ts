import { gateRole } from "@/lib/api-gate";
import { jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/** GET — list stores for admin */
export async function GET(req: Request) {
  const gate = await gateRole("Admin");
  if (gate.error) return gate.error;
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() || "";
  const frozen = url.searchParams.get("frozen");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
  const offset = parseInt(url.searchParams.get("offset") || "0");

  const admin = supabaseAdminClient();
  let query = admin
    .from("stores")
    .select("id, name, handle, uid, frozen, frozen_reason, frozen_at, rating, rating_count, owner_user_id, users!stores_owner_user_id_fkey(name, email)")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (q) query = query.or(`name.ilike.%${q}%,handle.ilike.%${q}%,uid.ilike.%${q}%`);
  if (frozen === "true") query = query.eq("frozen", true);
  else if (frozen === "false") query = query.eq("frozen", false);

  const { data, error } = await query;
  if (error) return jsonError(dbErrorMessage("admin/stores", error), 500);

  const items = (data ?? []).map((s: Record<string, unknown> & { users?: { name?: string; email?: string } | { name?: string; email?: string }[] }) => ({
    id: s.id, name: s.name, handle: s.handle, uid: s.uid,
    frozen: s.frozen, frozen_reason: s.frozen_reason, frozen_at: s.frozen_at,
    rating: s.rating, rating_count: s.rating_count,
    owner_name: Array.isArray(s.users) ? s.users[0]?.name : s.users?.name,
    owner_email: Array.isArray(s.users) ? s.users[0]?.email : s.users?.email,
  }));

  return jsonOk({ items });
}
