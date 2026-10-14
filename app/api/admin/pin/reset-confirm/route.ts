import { requireRole } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { verifyResetCode, hashPin, setAdminPinHash, resetPinAttempts } from "@/lib/admin-auth";

/**
 * POST /api/admin/pin/reset-confirm
 *
 * Confirm PIN reset with the 6-digit code sent to email + set new PIN.
 * Unlocks the account (resets attempts) on success.
 *
 * Body: { code: string, newPin: string }
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireRole("Admin");
  } catch {
    return jsonError("Admin role required", 403);
  }

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const { code, newPin } = (body ?? {}) as { code?: string; newPin?: string };

  if (!code) return jsonError("code required (from email)", 400);
  if (!newPin || !/^\d{6}$/.test(newPin)) return jsonError("newPin must be exactly 6 digits", 400);

  const valid = verifyResetCode(user.id, code);
  if (!valid) {
    return jsonError("Invalid or expired reset code", 403);
  }

  // Set new PIN + unlock
  const hash = await hashPin(newPin);
  await setAdminPinHash(user.id, hash);
  await resetPinAttempts(user.id);

  return jsonOk({ ok: true, message: "PIN reset successful. Account unlocked." });
}
