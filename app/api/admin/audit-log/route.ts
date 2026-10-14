/**
 * GET /api/admin/audit-log
 *
 * Enhanced audit log with search, filters, pagination.
 *
 * FIX (2026-09-27): this route used to read columns that do not exist on
 * `audit_log` (`time`, `actor_type`, `wallet_id`). The real shape is
 * (id, actor_id, action, ref, detail, created_at) — `actor_type`/`tx_hash`/
 * `circle_tx_id` live on `mm_audit_log` instead. The wrong names made every
 * call return 500 "Failed to fetch audit log".
 */
import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.role !== "Admin") return jsonError("admin role required", 403);

  const url = new URL(request.url);

  const search = (url.searchParams.get("search") || "").trim();
  const dateFrom = url.searchParams.get("dateFrom");
  const dateTo = url.searchParams.get("dateTo");
  const actionFilter = (url.searchParams.get("action") || "").trim();
  const actorFilter = (url.searchParams.get("actor") || "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1") || 1);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Math.min(parseInt(limitRaw) || 50, 100) : 50;
  const offset = (page - 1) * limit;

  const admin = supabaseAdminClient();

  // Columns that actually exist on `audit_log`.
  let query = admin
    .from("audit_log")
    .select("id, actor_id, action, ref, detail, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (dateFrom) query = query.gte("created_at", dateFrom);
  if (dateTo) query = query.lte("created_at", dateTo);
  if (actionFilter) query = query.ilike("action", `%${actionFilter}%`);
  if (search) query = query.or(`action.ilike.%${search}%,ref.ilike.%${search}%`);

  const { data, error, count } = await query;
  if (error) {
    console.error("Audit log fetch error:", error);
    return jsonError("Failed to fetch audit log", 500);
  }

  const rows = data ?? [];

  // Enrich actor name/role from `users` (best-effort — no FK assumed).
  const actorIds = [...new Set(rows.map((r) => r.actor_id).filter(Boolean))] as string[];
  const actors = new Map<string, { name: string | null; role: string | null }>();
  if (actorIds.length > 0) {
    const { data: users } = await admin.from("users").select("id, name, role").in("id", actorIds);
    for (const u of users ?? []) {
      actors.set(u.id as string, { name: (u.name as string) ?? null, role: (u.role as string) ?? null });
    }
  }

  let logs = rows.map((r) => {
    const a = actors.get(r.actor_id as string);
    return {
      id: r.id,
      time: r.created_at,
      actorType: a?.role ?? "user",
      actorName: a?.name ?? null,
      action: r.action,
      ref: r.ref,
      detail: r.detail ?? {},
    };
  });

  // The `actor` filter targets the joined user, not a column — apply post-query.
  if (actorFilter) {
    const f = actorFilter.toLowerCase();
    logs = logs.filter(
      (l) =>
        (l.actorType ?? "").toLowerCase().includes(f) ||
        (l.actorName ?? "").toLowerCase().includes(f),
    );
  }

  return jsonOk({
    logs,
    pagination: {
      currentPage: page,
      totalItems: count ?? 0,
      itemsPerPage: limit,
      totalPages: Math.ceil((count ?? 0) / limit),
    },
  });
}
