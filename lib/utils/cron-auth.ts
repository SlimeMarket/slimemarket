import { createHash, timingSafeEqual } from "crypto";

/**
 * .F-fix — cron route auth hardening.
 *
 * Two problems with the old inline pattern (`bearer === secret`):
 *
 *  1. Vercel's cron scheduler sends the configured request with NO auth
 *     header and no session cookie, so `Authorization: Bearer` alone means
 *     scheduled runs always 401'd and auto-settlement never ran on schedule.
 *     Routes must ALSO accept the secret as `?cron_secret=<secret>`.
 *  2. `===` on the raw secret is timing-unsafe (short-circuit string compare
 *     leaks the secret byte-by-byte). Compare SHA-256 digests with
 *     crypto.timingSafeEqual instead (hashing first also normalizes length,
 *     which timingSafeEqual requires).
 *
 * Note on `x-vercel-cron`: Vercel only sets that header on their infra, but
 * it carries no entropy — it is trivially spoofable from anywhere off-Vercel
 * (and on any host that forwards headers). It is therefore NEVER sufficient
 * by itself; the INDEXER_CRON_SECRET is still required regardless.
 */

/**
 * Timing-safe string comparison. Both inputs are SHA-256 hashed first so the
 * compared buffers are always 32 bytes (timingSafeEqual throws on length
 * mismatch). Empty/undefined/null never match — an unset secret fails closed.
 */
export function safeCronSecretMatch(
  expected: string | null | undefined,
  presented: string | null | undefined,
): boolean {
  if (!expected || !presented) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
}

/**
 * Extract the presented cron secret from a request: EITHER
 * `Authorization: Bearer <secret>` OR the `?cron_secret=<secret>` query
 * param (bearer wins when both are present). Returns "" when neither is
 * present. The extraction is secret-agnostic — matching happens in
 * `isCronSecretAuthorized`.
 */
export function cronSecretFromRequest(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  try {
    const url = new URL(req.url);
    return url.searchParams.get("cron_secret") ?? "";
  } catch {
    return "";
  }
}

/**
 * Route decision: is this request authorized by the cron secret? True iff the
 * environment secret is configured AND the presented secret (bearer or query)
 * matches it timing-safely. Admin-session fallback is handled by the route
 * itself (requireRole) — that path stays independent of this check.
 *
 * .B — Vercel's Cron scheduler auto-sends `Authorization: Bearer
 * $CRON_SECRET` (env var literally named CRON_SECRET on Vercel). Callers pass
 * INDEXER_CRON_SECRET; if that is unset, fall back to CRON_SECRET so a Vercel
 * deployment works with its native secret name, and self-hosted (VPS) deploys
 * keep using INDEXER_CRON_SECRET. Still fail-closed when neither is set.
 */
export function isCronSecretAuthorized(req: Request, secret: string | undefined): boolean {
  const expected = secret || process.env.CRON_SECRET;
  if (!expected) return false; // fail closed when no cron secret is configured
  return safeCronSecretMatch(expected, cronSecretFromRequest(req));
}
