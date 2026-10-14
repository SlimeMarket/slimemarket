/**
 * 3 — Middleman (MM) role management from the admin dashboard.
 *
 *   GET    /api/admin/middlemen — list every user with role='MM'
 *          (id, name, email, handle, joined_at + their wallets.address).
 *   POST   /api/admin/middlemen { email } — promote Member/Buyer/Seller → MM.
 *          404 if no such user, 409 if already MM (or Admin). Audited as
 *          MM_PROMOTE.
 *   DELETE /api/admin/middlemen { email | userId } — demote MM → Member.
 *          404 if the target is not an MM. Audited as MM_DEMOTE (the existing
 *          mm_audit_log action for role revocation — see lib/mm.ts enum).
 *
 * Auth: admin session only (audit-log route pattern: getCurrentUser +
 * explicit role check → 401/403). MM holders deliberately cannot manage
 * other MMs. Release-execution is unchanged — MM only adds DB authorization
 * for WL deal release/refund (requireStaffAuth).
 */
import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { createMmAuditLog } from "@/lib/mm";

export const dynamic = "force-dynamic";

/** Canonical admin-session gate (audit-log pattern). */
async function requireAdminSession() {
  const user = await getCurrentUser();
  if (!user) return { user: null, error: jsonError("unauthorized", 401) as Response };
  if (user.role !== "Admin") return { user: null, error: jsonError("admin role required", 403) as Response };
  return { user, error: null };
}

/** GET — list current middlemen with their wallet addresses. */
export async function GET() {
  const { user, error } = await requireAdminSession();
  if (error || !user) return error ?? jsonError("unauthorized", 401);

  const admin = supabaseAdminClient();
  const { data, error: err } = await admin
    .from("users")
    .select("id, name, email, handle, joined_at")
    .eq("role", "MM")
    .order("joined_at", { ascending: false });
  if (err) return jsonError(dbErrorMessage("admin/middlemen", err), 500);

  // Follow-up wallets query (same join approach as lib/auth-ucw getCurrentUser).
  const ids = (data ?? []).map((u) => u.id as string);
  let addressByUser = new Map<string, string>();
  if (ids.length > 0) {
    const { data: wallets } = await admin
      .from("wallets")
      .select("user_id, address")
      .in("user_id", ids);
    addressByUser = new Map((wallets ?? []).map((w) => [w.user_id as string, w.address as string]));
  }

  return jsonOk({
    middlemen: (data ?? []).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      handle: u.handle ?? null,
      joinedAt: u.joined_at,
      address: addressByUser.get(u.id as string) ?? null,
    })),
  });
}

/** POST { email } — promote Member/Buyer/Seller to MM. */
export async function POST(req: Request) {
  const { user, error } = await requireAdminSession();
  if (error || !user) return error ?? jsonError("unauthorized", 401);

  const body = await req.json().catch(() => ({}));
  const email = String((body as { email?: unknown }).email ?? "").trim();
  if (!email) return jsonError("email required", 400);

  const admin = supabaseAdminClient();
  const { data: target } = await admin
    .from("users")
    .select("id, name, email, role")
    .eq("email", email)
    .maybeSingle();

  if (!target) return jsonError("no user with that email", 404);
  if (target.role === "MM") return jsonError("user is already a middleman (MM)", 409);
  if (target.role === "Admin") return jsonError("cannot promote an Admin to MM", 409);

  const { error: upErr } = await admin
    .from("users")
    .update({ role: "MM" })
    .eq("id", target.id);
  if (upErr) return jsonError(upErr.message, 500);

  await createMmAuditLog({
    mmUserId: user.id, mmWalletId: "system", actorType: "user",
    action: "MM_PROMOTE", refId: target.id as string,
    detail: { email: target.email, oldRole: target.role, newRole: "MM" },
  });

  return jsonOk({ ok: true, message: `${target.name} promoted to MM` });
}

/** DELETE { email | userId } — demote MM back to Member. */
export async function DELETE(req: Request) {
  const { user, error } = await requireAdminSession();
  if (error || !user) return error ?? jsonError("unauthorized", 401);

  const body = await req.json().catch(() => ({}));
  const email = String((body as { email?: unknown }).email ?? "").trim();
  const userId = String((body as { userId?: unknown }).userId ?? "").trim();
  if (!email && !userId) return jsonError("email or userId required", 400);

  const admin = supabaseAdminClient();
  let query = admin.from("users").select("id, name, email, role");
  query = userId ? query.eq("id", userId) : query.eq("email", email);
  const { data: target } = await query.maybeSingle();

  if (!target || target.role !== "MM") {
    return jsonError(userId ? "no MM with that id" : "no MM with that email", 404);
  }

  const { error: upErr } = await admin
    .from("users")
    .update({ role: "Member" })
    .eq("id", target.id);
  if (upErr) return jsonError(upErr.message, 500);

  await createMmAuditLog({
    mmUserId: user.id, mmWalletId: "system", actorType: "user",
    action: "MM_DEMOTE", refId: target.id as string,
    detail: { email: target.email, oldRole: "MM", newRole: "Member" },
  });

  return jsonOk({ ok: true, message: `${target.name} revoked (MM → Member)` });
}
