import { getCircleUserStatus } from "@/lib/circle/ucw-user";

/**
 * defense-in-depth PIN gate for money/signature routes.
 *
 * Before creating ANY real UCW challenge (checkout approve, WL collateral,
 * transfer), verify the user actually HAS a PIN to enter. Legacy accounts
 * (wallet exists, pinStatus UNSET) used to get a challenge that dead-ended
 * at "Contract Interaction → Confirm" with no PIN prompt. Now they get a
 * clean, FE-actionable error instead.
 *
 * Returns:
 *   { ok: true }                                   → PIN ENABLED, proceed
 *   { ok: false, httpStatus: 422, code: PIN_SETUP_REQUIRED } → no PIN yet
 *   { ok: false, httpStatus: 423, code: PIN_LOCKED }         → PIN locked
 *
 * Never throws: upstream failures (network, expired token) fall back to
 * { ok: true } so we don't brick checkout on a transient Circle outage —
 * the challenge itself will still fail with the real error downstream.
 */
export type PinGateResult =
  | { ok: true }
  | { ok: false; httpStatus: number; code: "PIN_SETUP_REQUIRED" | "PIN_LOCKED"; message: string };

export async function checkPinGate(userToken: string): Promise<PinGateResult> {
  try {
    const status = await getCircleUserStatus(userToken);
    if (status.pinStatus === "UNSET") {
      return {
        ok: false,
        httpStatus: 422,
        code: "PIN_SETUP_REQUIRED",
        message: "Set up your wallet PIN before this action",
      };
    }
    if (status.pinStatus === "LOCKED") {
      return {
        ok: false,
        httpStatus: 423,
        code: "PIN_LOCKED",
        message: "Your wallet PIN is locked — try again later or restore it",
      };
    }
    return { ok: true };
  } catch (e) {
    // Fail-open: don't turn a Circle outage into a blocked checkout. The
    // challenge creation itself will surface the real error.
    console.error("[pin-gate] status check failed (allowing through):", e);
    return { ok: true };
  }
}
