/**
 * API route classification for the middleware gates — .
 *
 * Extracted from `middleware.ts` so the lists are importable by tests. Keep this
 * file COMPLETELY dependency-free: middleware runs on the edge runtime, and the
 * unit test imports it directly.
 *
 * WHY THIS EXISTS
 * ---------------
 * `middleware.ts` enforces two gates on every `/api/*` request:
 *   1. CSRF — state-changing methods must come from the configured app origin.
 *   2. UCW session — a valid `circle_user_token` + `circle_email` cookie pair.
 *
 * Scheduled jobs have neither an Origin header nor a session cookie, so every
 * cron route MUST be exempted from both gates or it is rejected before its own
 * auth (a timing-safe cron secret) ever runs.
 *
 * That exemption list was hand-maintained and had already drifted:
 * `/api/admin/reconcile/onchain-ids` was scheduled in `scripts/scheduler.js`
 * `scripts/scheduler.js` but was missing from the list, so it returned 401 on
 * every run. It is the backstop for orders whose `on_chain_order_id` never got
 * written — i.e. the exact job that would have masked the escrow ABI-drift bug.
 * `__tests__/lib/route-classification.test.ts` now derives the required set from
 * the scheduler configs, so this cannot silently drift again.
 */

/** Webhook receivers are excluded from the middleware matcher entirely. */
export const WEBHOOK_PATH_PREFIX = "/api/webhooks/";

/**
 * API routes reachable WITHOUT a UCW session: auth, public catalog, health, and
 * server-to-server callbacks that verify their own signature.
 */
export const PUBLIC_API_PREFIXES = [
  "/api/auth/email-otp",
  "/api/auth/logout",
  "/api/auth/unified",
  "/api/auth/recovery/challenge", // account recovery (nonce issue)
  "/api/auth/recovery/verify", // account recovery (signature login)
  "/api/auth/check-username",
  "/api/auth/dev-login",
  "/api/health",
  "/api/products",
  // Public search: products + sellers, and (for the caller only) an order by id.
  // Logged-out visitors must be able to search the catalog; the order lookup is
  // scoped to the session inside the route, so no one can read someone else's
  // order through it.
  "/api/search",
  "/api/stores",
  // The landing page renders a "recent sales" ticker and calls this on every
  // load, including for logged-out visitors. It was missing here, so the request
  // 401'd and the ticker silently fell back to a static list — the real data
  // could never reach a logged-out user. Safe to expose: getRecentSales already
  // anonymises the buyer (`buyerAnon` via censorName → "John***") and returns
  // only product/store names, amount and time.
  "/api/sales/recent",
  "/api/users/", // Public profile lookup by UID
  "/api/wallet/gateway/constants",
  // .B — Circle on-ramp callback: server-to-server POST with no cookie,
  // no Origin/Referer. The route verifies the Circle signature itself
  // (verifyOnRampWebhook). Without this exemption every callback 401'd here
  // before the route could run — on-ramp purchases never completed.
  "/api/wallet/onramp/webhook",
] as const;

/**
 * Scheduled maintenance routes. Exempt from CSRF + the session gate; each one
 * enforces its own timing-safe `INDEXER_CRON_SECRET` (Bearer OR ?cron_secret=)
 * or an Admin session — see `lib/utils/cron-auth.ts`.
 *
 * Listed explicitly (not a broad `/api/admin` prefix) so every other admin route
 * keeps its session requirement. MUST stay in sync with `scripts/scheduler.js`
 * and the job list in `scripts/scheduler.js` — enforced by the test.
 */
export const CRON_API_PREFIXES = [
  "/api/admin/auto-release",
  // Completes CCTP bridges whose attestation has arrived: submits
  // `receiveMessage` on Arc so the user's burned USDC is minted. Scheduled but
  // easily missed — a burn is permissionless to complete, so a skipped tick
  // costs latency, never funds.
  "/api/admin/cross-chain/relay",
  "/api/admin/indexer/run",
  "/api/admin/reconcile/balance",
  "/api/admin/reconcile/failed-withdrawals",
  // was scheduled but missing from this list, so it 401'd on every
  // run: the job that backfills a NULL on_chain_order_id was itself dead.
  "/api/admin/reconcile/onchain-ids",
  "/api/admin/reconcile/onchain-releases",
  "/api/admin/sweep/allowance",
  "/api/admin/sweep/drafts",
] as const;

export function isPublicApi(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p));
}

export function isCronApi(pathname: string): boolean {
  return CRON_API_PREFIXES.some((p) => pathname.startsWith(p));
}

export function isWebhookPath(pathname: string): boolean {
  return pathname.startsWith(WEBHOOK_PATH_PREFIX);
}
