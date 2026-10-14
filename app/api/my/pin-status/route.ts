import { getCurrentUser, getUcwCredentials, isDevTokenSession } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { checkUserRateLimit, FINANCIAL_RATE_LIMIT } from "@/lib/rate-limit";
import { getCircleUserStatus, UcwError } from "@/lib/circle/ucw-user";

/**
 * GET /api/my/pin-status — .C2 PIN management.
 *
 * Returns the user's Circle UCW PIN status so the /wallet page can gate the
 * Change-PIN / Forgot-PIN actions and surface lock cooldowns.
 *
 * Dev-login sessions are mocked: they have no real Circle user, so return
 * `{ devMode: true, pinStatus: 'MOCK', provisioned: true }` and skip all
 * Circle calls (dev tokens are rejected by Circle with 401).
 *
 * UcwError mapping: the mapped httpStatus is passed through (155104 token
 * expired → 401 so the FE shows the re-login / refresh-session hint).
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  const rlErr = await checkUserRateLimit(user.id, "pin-status", FINANCIAL_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  if (await isDevTokenSession()) {
    return jsonOk({ devMode: true, pinStatus: "MOCK", provisioned: true });
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
    return jsonOk({
      pinStatus: status.pinStatus,
      provisioned: user.walletProvisioned,
      failedAttempts: status.pinDetails?.failedAttempts ?? null,
      lockedUntil: status.pinDetails?.lockedExpiryDate ?? null,
    });
  } catch (e) {
    if (e instanceof UcwError) {
      // .C — 155102 (Circle user not found): legacy account whose
      // Circle user row is gone (empty circle_user_id). Instead of a 404
      // "session expired" dead-end, surface UNSET + needsReprovision so the
      // FE shows the Set-up-PIN CTA and /api/my/pin-setup re-provisions.
      // Guarded to 155102 only — other codes keep their mapped statuses.
      if (e.code === 155102) {
        return jsonOk({
          pinStatus: "UNSET",
          provisioned: user.walletProvisioned,
          needsReprovision: true,
        });
      }
      return jsonError(e.message, e.httpStatus ?? 502);
    }
    return jsonError("failed to read PIN status", 500);
  }
}
