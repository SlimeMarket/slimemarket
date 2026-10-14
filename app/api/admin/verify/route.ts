import { requireUser } from "@/lib/auth-ucw";
import { isWlStaff } from "@/lib/types";
import { jsonError, jsonOk } from "@/lib/utils";
import {
  verifyPin,
  verifyUcwChallenge,
  signAdminToken,
  getAdminPinHash,
  checkPinLockout,
  recordFailedAttempt,
  resetPinAttempts,
} from "@/lib/admin-auth";

/**
 * POST /api/admin/verify — Verify admin PIN + UCW challenge (combo 2FA).
 *
 * Returns a short-lived admin action token (5 min TTL) to be passed as
 * X-Admin-Token header on sensitive endpoints.
 *
 * Body: { pin: string, challengeId: string }
 *
 * PIN lockout: 3 failed attempts → locked 15 min. Reset via email only.
 * Dev mode: challengeId = "dev-bypass" skips UCW device check.
 *
 * 3 — accepts Admin AND MM (middleman). The token only unlocks
 * routes whose role gate includes MM (WL deal release/refund); Admin-only
 * sensitive routes keep re-checking requireRole("Admin") against the session.
 */
export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser();
    if (!isWlStaff(user.role)) {
      const err = new Error("FORBIDDEN");
      (err as Error & { status?: number }).status = 403;
      throw err;
    }
  } catch {
    return jsonError("Admin/MM role required", 403);
  }

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const { pin, challengeId } = (body ?? {}) as { pin?: string; challengeId?: string };

  if (!pin) return jsonError("pin is required", 400);
  if (!challengeId) return jsonError("challengeId is required (UCW device approval)", 400);

  // Check lockout FIRST
  const lockStatus = await checkPinLockout(user.id);
  if (lockStatus.locked) {
    return jsonError("PIN locked (too many attempts). Reset via email: POST /api/admin/pin/reset-request", 423);
  }

  // 1. Verify PIN
  const storedHash = await getAdminPinHash(user.id);
  if (!storedHash) {
    return jsonError("Admin PIN not set. Call POST /api/admin/pin first.", 400);
  }

  const pinValid = await verifyPin(pin, storedHash);
  if (!pinValid) {
    const result = await recordFailedAttempt(user.id);
    if (result.locked) {
      return jsonError("PIN locked (3 failed attempts). Reset via email: POST /api/admin/pin/reset-request", 423);
    }
    return jsonError(`Invalid PIN. ${result.attemptsLeft} attempt(s) remaining.`, 403);
  }

  // PIN correct — reset attempts
  await resetPinAttempts(user.id);

  // 2. Verify UCW challenge (device approval)
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  const userToken = cookieStore.get("circle_user_token")?.value ?? "";

  const challengeValid = await verifyUcwChallenge(challengeId, userToken);
  if (!challengeValid) {
    return jsonError("UCW device approval failed or not completed", 403);
  }

  // 3. Issue short-lived admin action token
  const token = signAdminToken(user.id, user.role);

  return jsonOk({
    adminToken: token,
    expiresIn: 300, // 5 minutes in seconds
    message: "Admin verified. Use X-Admin-Token header for sensitive actions.",
  });
}
