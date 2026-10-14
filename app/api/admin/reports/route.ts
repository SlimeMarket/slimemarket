import { requireRole } from "@/lib/auth-ucw";
import { jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/**
 * GET /api/admin/reports — List all reports (admin-only).
 */
export async function GET() {
  try {
    await requireRole("Admin");
  } catch {
    return jsonError("Admin role required", 403);
  }

  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("reports")
    .select(`
      id, target_type, target_id, reason, detail, status, created_at, resolved_at,
      reporter:users!reports_reporter_id_fkey ( name ),
      resolver:users!reports_resolved_by_fkey ( name )
    `)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return jsonError(dbErrorMessage("admin/reports", error), 500);

  const items = (data ?? []).map((r: Record<string, unknown>) => ({
    id: r.id,
    targetType: r.target_type,
    targetId: r.target_id,
    reason: r.reason,
    detail: r.detail,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    reporterName: (r.reporter as { name: string } | null)?.name ?? "Unknown",
    resolverName: (r.resolver as { name: string } | null)?.name ?? null,
  }));

  return jsonOk({ items, total: items.length });
}
