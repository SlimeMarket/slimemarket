import { jsonError } from "@/lib/utils";

/**
 * DEPRECATED (2026-10-14) — PIN reset via email has been removed.
 *
 * WHY: The PIN managed by this endpoint was the Circle UCW PIN, which lives
 * entirely inside Circle's MPC infrastructure. A 6-digit reset code sent by
 * email could never recover the actual Circle PIN or the MPC-split private key.
 * It only created a false sense of security.
 *
 * RECOVERY PATHS:
 *   1. Forgot PIN but still have email → use Circle native restore
 *      (POST /api/my/pin-restore + security questions).
 *   2. Lost email access → use recovery-wallet login
 *      (/recovery/wallet with a linked EOA).
 *   3. Stuck on both → contact support.
 */
export async function POST() {
  return jsonError(
    "This endpoint is deprecated. Use /recovery for account recovery options.",
    410,
  );
}
