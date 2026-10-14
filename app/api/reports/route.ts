import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/**
 * POST /api/reports — Create a report (user-facing).
 * Body: { targetType: 'product'|'store'|'user', targetId: string, reason: string, detail?: string }
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("Login required", 401);

  const body = await req.json().catch(() => ({}));
  const targetType = String(body.targetType ?? "");
  const targetId = String(body.targetId ?? "");
  const reason = String(body.reason ?? "").trim();
  const detail = body.detail ? String(body.detail).trim() : null;

  if (!["product", "store", "user"].includes(targetType))
    return jsonError("Invalid targetType", 400);
  if (!targetId) return jsonError("targetId required", 400);
  if (!reason) return jsonError("reason required", 400);

  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("reports")
    .insert({
      reporter_id: user.id,
      target_type: targetType,
      target_id: targetId,
      reason,
      detail,
      status: "pending",
    })
    .select("id, status, created_at")
    .single();

  if (error) return jsonError(dbErrorMessage("reports", error), 500);
  return jsonOk(data, 201);
}
