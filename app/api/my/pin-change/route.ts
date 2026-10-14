import { getCurrentUser, getUcwCredentials, isDevTokenSession } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { checkUserRateLimit, FINANCIAL_RATE_LIMIT } from "@/lib/rate-limit";
import { createPinChangeChallenge, UcwError } from "@/lib/circle/ucw-user";

/**
 * POST /api/my/pin-change — .C2 PIN management.
 *
 * Creates a Circle UCW change-PIN challenge (hosted UI: old PIN → new PIN).
 * Returns `{ challengeId }` for `window.executeUcwChallenge(challengeId)`.
 *
 * Dev-login sessions are mocked and have no real Circle account — return 409
 * with an explanatory message instead of calling Circle (which would 401).
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  const rlErr = await checkUserRateLimit(user.id, "pin-change", FINANCIAL_RATE_LIMIT);
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
    const { challengeId } = await createPinChangeChallenge(creds.userToken);
    return jsonOk({ challengeId });
  } catch (e) {
    if (e instanceof UcwError) {
      return jsonError(e.message, e.httpStatus ?? 502);
    }
    return jsonError("failed to start PIN change", 500);
  }
}
