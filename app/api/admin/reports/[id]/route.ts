import { requireRole } from "@/lib/auth-ucw";
import { jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/**
 * PATCH /api/admin/reports/[id] — Update report status (admin-only).
 * Body: { status: 'reviewing'|'resolved'|'dismissed' }
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireRole("Admin");
  } catch {
    return jsonError("Admin role required", 403);
  }

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const status = String(body.status ?? "");

  if (!["reviewing", "resolved", "dismissed"].includes(status))
    return jsonError("Invalid status. Use: reviewing, resolved, dismissed", 400);

  const admin = supabaseAdminClient();
  const update: Record<string, unknown> = { status };
  if (status === "resolved" || status === "dismissed") {
    update.resolved_by = user.id;
    update.resolved_at = new Date().toISOString();
  }

  const { data, error } = await admin
    .from("reports")
    .update(update)
    .eq("id", id)
    .select("id, status")
    .single();

  if (error) return jsonError(dbErrorMessage("admin/reports/[id]", error), 500);
  return jsonOk(data);
}
