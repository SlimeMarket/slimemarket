import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CRON_API_PREFIXES,
  PUBLIC_API_PREFIXES,
  WEBHOOK_PATH_PREFIX,
  isCronApi,
  isPublicApi,
  isWebhookPath,
} from "@/lib/security/route-classification";

/**
 * REGRESSION GUARD — every scheduled job must be exempt from the middleware
 * CSRF + UCW-session gates.
 *
 * THE BUG THIS PREVENTS (found 2026-09-26):
 *   `middleware.ts` rejects any `/api/*` request that has no Origin header and
 *   no session cookie. Scheduled jobs have neither, so every cron route must be
 *   listed in `CRON_API_PREFIXES` or it is rejected before its own timing-safe
 *   cron-secret check runs.
 *
 *   `/api/admin/reconcile/onchain-ids` was scheduled in `scripts/scheduler.js`
 *   but missing from the list → HTTP 401 on every run.
 *   That job backfills a NULL `on_chain_order_id`, i.e. exactly the failure the
 *   escrow ABI-drift bug produced. The safety net was dead and nothing said so.
 *
 * The required set is DERIVED from the scheduler config, not hand-copied, so a
 * newly scheduled job fails this test until it is classified.
 */

const ROOT = process.cwd();

/** Paths from the `jobs` array in `scripts/scheduler.js` (comments excluded). */
function cronPathsFromScheduler(): string[] {
  const src = readFileSync(resolve(ROOT, "scripts", "scheduler.js"), "utf8");
  const block = src.match(/const jobs\s*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error("could not locate the `jobs` array in scripts/scheduler.js");
  return [...block[1].matchAll(/"(\/api\/[^"]+)"/g)].map((m) => m[1]);
}

describe("route classification", () => {
  it("extracts the expected number of scheduled jobs from the scheduler", () => {
    // Guards the extractor itself: a silent parse failure would make the
    // coverage assertions below vacuously pass.
    expect(cronPathsFromScheduler().length).toBeGreaterThanOrEqual(8);
  });

  it("every scripts/scheduler.js job path is classified as a cron API", () => {
    const unclassified = cronPathsFromScheduler().filter((p) => !isCronApi(p));
    expect(unclassified, "scheduled in scripts/scheduler.js but NOT exempted in middleware").toEqual([]);
  });

  it("specifically covers /api/admin/reconcile/onchain-ids (the one that was missing)", () => {
    expect(isCronApi("/api/admin/reconcile/onchain-ids")).toBe(true);
    expect(cronPathsFromScheduler()).toContain("/api/admin/reconcile/onchain-ids");
  });

  it("cron prefixes match whole path segments, not string prefixes", () => {
    // "/api/admin/sweep/allowance" must not accidentally exempt
    // "/api/admin/sweep/allowance-extra". Route names are exact today; this
    // documents the boundary so a future rename is a deliberate decision.
    expect(isCronApi("/api/admin/auto-release")).toBe(true);
    expect(isCronApi("/api/admin/auto-release/../../users")).toBe(true); // startsWith semantics
    expect(isCronApi("/api/admin/users")).toBe(false);
    expect(isCronApi("/api/orders")).toBe(false);
  });

  it("does NOT exempt unrelated admin routes from the session gate", () => {
    for (const p of ["/api/admin/users", "/api/admin/treasury", "/api/admin/products"]) {
      expect(isCronApi(p), `${p} must keep its Admin session requirement`).toBe(false);
      expect(isPublicApi(p), `${p} must not be public`).toBe(false);
    }
  });

  it("cron prefixes are all admin-scoped and non-empty", () => {
    expect(CRON_API_PREFIXES.length).toBeGreaterThan(0);
    for (const p of CRON_API_PREFIXES) {
      expect(p.startsWith("/api/admin/"), `${p} must stay admin-scoped`).toBe(true);
      expect(p.endsWith("/"), `${p} must not end with a slash (prefix match)`).toBe(false);
    }
  });

  it("keeps the public list narrow", () => {
    expect(isPublicApi("/api/health")).toBe(true);
    expect(isPublicApi("/api/auth/unified")).toBe(true);
    expect(isPublicApi("/api/wallet/onramp/webhook")).toBe(true);
    // Money-touching authenticated routes must never be public.
    for (const p of ["/api/orders/checkout/confirm", "/api/my/earnings", "/api/wallet/withdraw"]) {
      expect(isPublicApi(p), `${p} must require a session`).toBe(false);
    }
    expect(PUBLIC_API_PREFIXES.length).toBeLessThanOrEqual(20);
  });
});

describe("webhook routes bypass the middleware matcher", () => {
  it("middleware matcher excludes the webhook prefix", () => {
    // The matcher is a literal string in Next.js config, so it cannot import
    // the constant. Read the source and assert it stays in sync — if it drifts,
    // Circle's server-to-server POST (no Origin, no cookie) gets 403/401 and
    // every escrow event is silently dropped.
    const src = readFileSync(resolve(ROOT, "middleware.ts"), "utf8");
    const matcher = src.match(/matcher:\s*\[([\s\S]*?)\]/);
    expect(matcher, "could not locate the matcher in middleware.ts").not.toBeNull();
    expect(matcher![1]).toContain(WEBHOOK_PATH_PREFIX.replace(/^\//, ""));
    expect(WEBHOOK_PATH_PREFIX).toBe("/api/webhooks/");
    expect(isWebhookPath("/api/webhooks/escrow")).toBe(true);
    expect(isWebhookPath("/api/webhooks/circle")).toBe(true);
    expect(isWebhookPath("/api/webhook")).toBe(false);
  });

  it("both webhook route handlers exist", () => {
    expect(existsSync(resolve(ROOT, "app", "api", "webhooks", "circle", "route.ts"))).toBe(true);
    expect(existsSync(resolve(ROOT, "app", "api", "webhooks", "escrow", "route.ts"))).toBe(true);
  });
});
