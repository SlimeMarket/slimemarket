import { gateRole } from "@/lib/api-gate";
import { jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/** GET — list/search users */
export async function GET(req: Request) {
  const gate = await gateRole("Admin");
  if (gate.error) return gate.error;
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() || "";
  const role = url.searchParams.get("role") || "";
  const banned = url.searchParams.get("banned");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
  const offset = parseInt(url.searchParams.get("offset") || "0");

  const admin = supabaseAdminClient();
  let query = admin
    .from("users")
    .select("id, uid, name, handle, email, role, banned, banned_reason, banned_until, joined_at, tx_count")
    .order("joined_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (q) {
    query = query.or(`name.ilike.%${q}%,handle.ilike.%${q}%,email.ilike.%${q}%,uid.ilike.%${q}%`);
  }
  if (role && role !== "all") query = query.eq("role", role);
  if (banned === "true") query = query.eq("banned", true);
  else if (banned === "false") query = query.eq("banned", false);

  const { data, error } = await query;
  if (error) return jsonError(dbErrorMessage("admin/users", error), 500);
  return jsonOk({ items: data ?? [] });
}
