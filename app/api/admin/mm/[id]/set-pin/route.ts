import { jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { requireAdminAuth, hashPin } from "@/lib/admin-auth";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { createMmAuditLog } from "@/lib/mm";

const PLATFORM_WALLET_ID = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "system";

/**
 * POST /api/admin/mm/[id]/set-pin
 *
 * Admin sets/resets a middleman's PIN. MM cannot set their own PIN —
 * only main admin can, from the admin dashboard.
 *
 * this is the ONLY way a promoted middleman gets a PIN, and without a
 * PIN they cannot pass /api/admin/verify, so they cannot use the MM console at
 * all. The route existed with no UI caller; the admin Middlemen tab now calls it.
 *
 * Requires admin auth token (PIN + UCW verified).
 * Body: { pin: string }  (6-digit numeric)
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if (auth.error) return auth.error;
  const actor = auth.user;

  const { id: mmUserId } = await params;

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const { pin } = (body ?? {}) as { pin?: string };

  if (!pin || !/^\d{6}$/.test(pin)) return jsonError("pin must be exactly 6 digits", 400);

  // Verify target user exists and is staff (MM role — 3 — or Admin)
  const admin = supabaseAdminClient();
  const { data: mmUser } = await admin
    .from("users")
    .select("id, name, role")
    .eq("id", mmUserId)
    .maybeSingle();

  if (!mmUser) return jsonError("user not found", 404);
  if (mmUser.role !== "Admin" && mmUser.role !== "MM") return jsonError("target user must be Admin/MM role", 400);

  const hash = await hashPin(pin);
  const { error } = await admin
    .from("users")
    .update({ admin_pin_hash: hash, pin_attempts: 0, pin_locked_until: null })
    .eq("id", mmUserId);

  if (error) return jsonError(dbErrorMessage("admin/mm/[id]/set-pin", error), 500);

  // Resetting someone's credential is a privileged action — record who did it.
  // The PIN itself is never logged, only the fact that it changed.
  await createMmAuditLog({
    mmUserId: actor?.id ?? null,
    mmWalletId: PLATFORM_WALLET_ID,
    actorType: actor ? "user" : "system",
    action: "MM_PIN_SET",
    refId: mmUserId,
    detail: { targetRole: mmUser.role, targetName: mmUser.name, resetLockout: true },
  }).catch(() => { /* best-effort */ });

  return jsonOk({ ok: true, message: `PIN set for ${mmUser.name}` });
}
