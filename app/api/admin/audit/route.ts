import { requireRole } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/**
 * GET /api/admin/audit — Phase 3.6 audit log viewer.
 *
 * Returns recent mm_audit_log entries with optional filters. Closes the gap
 * where platform-triggered release/refund audit rows (Phase 1.1 fix) were
 * silently dropped — now they're written correctly AND visible to ops.
 *
 * Query params (all optional):
 *   - refId      : filter by ref_id (e.g. an orderId or walletTxId)
 *   - action     : filter by action (e.g. RELEASE_ORDER, RECONCILE_DRIFT)
 *   - actorType  : filter by actor_type (user | platform | auto_release | system)
 *   - circleTxId : filter by Circle tx UUID
 *   - limit      : page size (default 50, max 200)
 *   - offset     : pagination offset (default 0)
 *
 * Also includes rows from `mm_audit_log_failed` (dead-letter) so ops can see
 * audit intents that didn't make it to the primary table.
 *
 * Auth: Admin role required.
 */
export async function GET(req: Request) {
  let user;
  try {
    user = await requireRole("Admin");
  } catch {
    return jsonError("Admin role required", 403);
  }
  void user; // admin auth check only

  const url = new URL(req.url);
  const refId = url.searchParams.get("refId");
  const action = url.searchParams.get("action");
  const actorType = url.searchParams.get("actorType");
  const circleTxId = url.searchParams.get("circleTxId");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 200);
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0);

  const admin = supabaseAdminClient();
  let query = admin.from("mm_audit_log")
    .select("id, mm_user_id, mm_wallet_id, actor_type, action, ref_id, tx_hash, circle_tx_id, detail, created_at")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (refId) query = query.eq("ref_id", refId);
  if (action) query = query.eq("action", action);
  if (actorType) query = query.eq("actor_type", actorType);
  if (circleTxId) query = query.eq("circle_tx_id", circleTxId);

  const { data: rows, error } = await query;
  if (error) return jsonError(`audit query failed: ${error.message}`, 500);

  // Also fetch dead-letter rows for the same filters (so ops sees the full
  // picture — anything in mm_audit_log_failed is an audit row that failed to
  // write to the primary and was preserved by the throw-on-failure path).
  let deadLetter: unknown[] = [];
  if (refId || action || actorType || circleTxId) {
    let dlQuery = admin.from("mm_audit_log_failed")
      .select("id, mm_user_id, mm_wallet_id, actor_type, action, ref_id, tx_hash, circle_tx_id, detail, failure_reason, attempted_at")
      .order("attempted_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (refId) dlQuery = dlQuery.eq("ref_id", refId);
    if (action) dlQuery = dlQuery.eq("action", action);
    if (actorType) dlQuery = dlQuery.eq("actor_type", actorType);
    if (circleTxId) dlQuery = dlQuery.eq("circle_tx_id", circleTxId);
    const { data: dlRows } = await dlQuery;
    deadLetter = dlRows ?? [];
  }

  return jsonOk({
    rows: rows ?? [],
    deadLetter,
    pagination: { limit, offset },
    filters: { refId, action, actorType, circleTxId },
  });
}
