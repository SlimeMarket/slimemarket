import { getCurrentUser, getUcwCredentials, isDevTokenSession } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { checkUserRateLimit, FINANCIAL_RATE_LIMIT } from "@/lib/rate-limit";
import {
  createPinSetupChallenge,
  createWalletOnlyChallenge,
  getCircleUserStatus,
  UcwError,
} from "@/lib/circle/ucw-user";

/**
 * POST /api/my/pin-setup — .C PIN setup (wires the /wallet "Set up PIN" CTA).
 *
 * Creates the Circle UCW one-shot PIN-setup challenge (hosted UI: 6-digit PIN
 * + security questions AND ARC-TESTNET EOA wallet creation in one step —
 * `createUserPinWithWallets`). Returns `{ challengeId }` for
 * `window.executeUcwChallenge(challengeId, { isPinSetup: true })`.
 *
 * Flow:
 *   - dev-login session → 409 (mocked, no Circle account) — same message as
 *     /api/my/pin-change for FE consistency.
 *   - missing UCW credentials → 401 (refresh-session hint).
 *   - getCircleUserStatus: pinStatus ENABLED → 409 (already set; use Change PIN).
 *   - otherwise createPinSetupChallenge → `{ challengeId }`.
 *   - UcwError 155106 (user already initialized): the PIN exists but the
 *     wallet is missing (legacy / re-provision) → fall back to the
 *     wallet-only challenge and return `{ challengeId, walletOnly: true }`.
 *   - other UcwError → pass through mapped httpStatus.
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  const rlErr = await checkUserRateLimit(user.id, "pin-setup", FINANCIAL_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  if (await isDevTokenSession()) {
    return jsonError("PIN management requires a Circle account (dev sessions are mocked)", 409);
  }

  const creds = await getUcwCredentials();
  if (!creds) {
    return jsonError(
      "UCW credentials missing — refresh your wallet session (redirect to /refresh-session)",
      401,
    );
  }

  try {
    const status = await getCircleUserStatus(creds.userToken);
    if (status.pinStatus === "ENABLED") {
      return jsonError("PIN already set — use Change PIN", 409);
    }
  } catch (e) {
    if (e instanceof UcwError) {
      return jsonError(e.message, e.httpStatus ?? 502);
    }
    return jsonError("failed to read PIN status", 500);
  }

  try {
    const { challengeId } = await createPinSetupChallenge(creds.userToken);
    return jsonOk({ challengeId });
  } catch (e) {
    if (e instanceof UcwError) {
      if (e.code === 155106) {
        // Circle user already initialized: PIN exists but wallet is missing —
        // fall back to the wallet-only challenge (re-provision path).
        try {
          const { challengeId } = await createWalletOnlyChallenge(creds.userToken);
          return jsonOk({ challengeId, walletOnly: true });
        } catch (e2) {
          if (e2 instanceof UcwError) {
            return jsonError(e2.message, e2.httpStatus ?? 502);
          }
          return jsonError("failed to start wallet provisioning", 500);
        }
      }
      return jsonError(e.message, e.httpStatus ?? 502);
    }
    return jsonError("failed to start PIN setup", 500);
  }
}
