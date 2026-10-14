import { getCurrentUser, getUcwCredentials } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { checkUserRateLimit, FINANCIAL_RATE_LIMIT } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * GET /api/my/ucw-credentials — Phase 6.4 security fix.
 *
 * Returns the caller's Circle UCW `userToken` + `encryptionKey` so the FE
 * can call `W3SSdk.setAuthentication({ userToken, encryptionKey })` before
 * `sdk.execute(challengeId)`.
 *
 * SECURITY: per Circle skill `use-user-controlled-wallets` Security Rule,
 * credentials MUST live in httpOnly cookies (set at signup via
 * `app/api/auth/unified/route.ts`) — NOT localStorage. This endpoint is the
 * single surface that exposes them to JS: it requires an authenticated
 * session, is rate-limited (10/min, same as financial endpoints), and logs
 * each fetch for audit. The FE MUST treat the response as ephemeral — pass
 * to `sdk.setAuthentication` immediately and let it go out of scope. Do NOT
 * persist in localStorage / sessionStorage / global variable.
 *
 * The credentials are scoped to UCW challenge approval only (cannot move
 * funds without the user's PIN via Circle's hosted UI). If the session
 * cookie is stolen via XSS, the attacker already has the same access this
 * endpoint would give them — so this endpoint doesn't increase the attack
 * surface beyond the existing session-cookie XSS risk.
 *
 * Why not just keep localStorage? The Circle skill's Security Rule
 * explicitly says "ALWAYS store userToken and encryptionKey in httpOnly
 * cookies (not localStorage) in production to mitigate XSS token theft".
 * localStorage is persistent + readable by any XSS payload indefinitely;
 * this endpoint is fetched on-demand and the response is not persisted.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  // Per-user rate limit — same as financial endpoints (10/min).
  const rlErr = await checkUserRateLimit(user.id, "ucw-credentials", FINANCIAL_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const creds = await getUcwCredentials();
  if (!creds) {
    // Either the session is missing the encryption_key cookie (legacy user
    // who signed up before that cookie was added) or the wallet lookup
    // failed. FE should redirect to /refresh-session to re-establish.
    return jsonError(
      "UCW credentials missing — refresh your wallet session (redirect to /refresh-session)",
      401,
    );
  }

  // Best-effort audit log so ops can monitor who's fetching credentials
  // (abnormal volume = possible XSS attack exfiltrating tokens).
  logger.info({ userId: user.id, ip: req.headers.get("x-forwarded-for") }, "ucw-credentials fetched");

  return jsonOk({
    userToken: creds.userToken,
    encryptionKey: creds.encryptionKey,
    circleWalletId: creds.circleWalletId,
    // Explicit ephemeral-use hint for FE consumers.
    ephemeral: true,
  });
}
