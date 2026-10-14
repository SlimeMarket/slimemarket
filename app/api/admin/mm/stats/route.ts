import { gateRole } from "@/lib/api-gate";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/** GET — MM deal count stats per middleman */
export async function GET() {
  const gate = await gateRole("Admin");
  if (gate.error) return gate.error;
  const admin = supabaseAdminClient();

  // get all admin users (potential middlemen)
  const { data: admins, error: adminErr } = await admin
    .from("users")
    .select("id, name, email, role")
    .eq("role", "Admin")
    .order("name");
  if (adminErr) return jsonError(adminErr.message, 500);

  // get all mm_audit_log entries
  const { data: logs, error: logErr } = await admin
    .from("mm_audit_log")
    .select("mm_user_id, action, created_at");
  if (logErr) return jsonError(logErr.message, 500);

  // aggregate
  const stats = new Map<string, { deal_count: number; release_count: number; refund_count: number; last_action_at: string | null }>();

  for (const log of logs ?? []) {
    const uid = log.mm_user_id as string;
    if (!stats.has(uid)) stats.set(uid, { deal_count: 0, release_count: 0, refund_count: 0, last_action_at: null });
    const s = stats.get(uid)!;
    const action = log.action as string;
    const createdAt = log.created_at as string;

    if (action.startsWith("RELEASE_") || action.startsWith("REFUND_")) {
      s.deal_count++;
      if (action.startsWith("RELEASE_")) s.release_count++;
      if (action.startsWith("REFUND_")) s.refund_count++;
    }

    if (!s.last_action_at || createdAt > s.last_action_at) s.last_action_at = createdAt;
  }

  const items = (admins ?? []).map((a: Record<string, unknown>) => {
    const s = stats.get(a.id as string) || { deal_count: 0, release_count: 0, refund_count: 0, last_action_at: null };
    return {
      user_id: a.id,
      name: a.name,
      email: a.email,
      role: a.role,
      deal_count: s.deal_count,
      release_count: s.release_count,
      refund_count: s.refund_count,
      last_action_at: s.last_action_at,
    };
  }).sort((a, b) => b.deal_count - a.deal_count);

  return jsonOk({ items });
}
