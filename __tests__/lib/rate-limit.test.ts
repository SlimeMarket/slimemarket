/**
 * Canonical rate-limit suite (consolidation).
 *
 * Merges the former `__tests__/rate-limiting.test.ts` (strict-mode / prod
 * behavior + config values) and `__tests__/lib/rate-limit.test.ts`
 * (in-memory bucket behavior). The old lib/ suite mocked @upstash/ratelimit
 * and @upstash/redis — that tested the mock, not the code. This suite runs
 * the REAL lib/rate-limit code: in the test env UPSTASH_REDIS_REST_URL /
 * _TOKEN are unset, so the module takes its in-memory dev path, which is
 * exactly what we exercise here (plus the production fail-closed path).
 *
 * Covered behaviors:
 *  - in-memory limiter: first request allowed; blocked after max; separate
 *    buckets per endpoint and per user; window reset → allowed again
 *  - strict mode: production without Redis THROWS (no silent bypass);
 *    development without Redis falls back to in-memory
 *  - exported rate-limit configurations (financial / withdraw / checkout)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  checkUserRateLimit,
  FINANCIAL_RATE_LIMIT,
  WITHDRAW_RATE_LIMIT,
  CHECKOUT_RATE_LIMIT,
} from "@/lib/rate-limit";

// Unique-ish keys so the module-level in-memory Map never collides across
// tests (it persists for the whole file).
let seq = 0;
const uid = (name: string) => `${name}-${++seq}-${Date.now()}`;

// Node's typings declare process.env.NODE_ENV as readonly; the strict-mode
// tests below need to overwrite it, so go through a mutable view. Runtime
// behavior is identical (process.env is not frozen).
const env = process.env as Record<string, string | undefined>;

afterEach(() => {
  vi.useRealTimers();
});

describe("lib/rate-limit — in-memory limiter (dev path)", () => {
  it("allows the first request", async () => {
    const r = await checkUserRateLimit(uid("user"), "checkout", FINANCIAL_RATE_LIMIT);
    expect(r).toBeNull();
  });

  it("blocks once max is exceeded", async () => {
    const user = uid("user");
    const config = { max: 2, windowMs: 60_000 };

    expect(await checkUserRateLimit(user, "/api/test", config)).toBeNull();
    expect(await checkUserRateLimit(user, "/api/test", config)).toBeNull();
    const blocked = await checkUserRateLimit(user, "/api/test", config);
    expect(blocked).toMatch(/Rate limit exceeded/);
  });

  it("respects the default financial limit (10/min)", async () => {
    const user = uid("user");
    for (let i = 0; i < FINANCIAL_RATE_LIMIT.max; i++) {
      expect(await checkUserRateLimit(user, "checkout", FINANCIAL_RATE_LIMIT)).toBeNull();
    }
    const blocked = await checkUserRateLimit(user, "checkout", FINANCIAL_RATE_LIMIT);
    expect(blocked).toMatch(/Rate limit exceeded \(max 10 per 60s\)/);
  });

  it("keeps separate buckets per endpoint", async () => {
    const user = uid("user");
    const config = { max: 2, windowMs: 60_000 };

    // Exhaust endpoint A.
    await checkUserRateLimit(user, "/api/endpoint-a", config);
    await checkUserRateLimit(user, "/api/endpoint-a", config);
    expect(await checkUserRateLimit(user, "/api/endpoint-a", config)).toMatch(
      /Rate limit exceeded/
    );

    // Endpoint B is a fresh bucket.
    expect(await checkUserRateLimit(user, "/api/endpoint-b", config)).toBeNull();
  });

  it("keeps separate buckets per user", async () => {
    const config = { max: 1, windowMs: 60_000 };
    const userA = uid("userA");
    const userB = uid("userB");

    expect(await checkUserRateLimit(userA, "checkout", config)).toBeNull();
    expect(await checkUserRateLimit(userA, "checkout", config)).toMatch(/exceeded/);
    // userB is unaffected by userA's exhausted bucket.
    expect(await checkUserRateLimit(userB, "checkout", config)).toBeNull();
  });

  it("allows requests again after the window resets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const user = uid("user");
    const config = { max: 1, windowMs: 1_000 };

    expect(await checkUserRateLimit(user, "checkout", config)).toBeNull();
    expect(await checkUserRateLimit(user, "checkout", config)).toMatch(/Rate limit exceeded/);

    // Past resetAt → bucket starts fresh.
    vi.setSystemTime(new Date("2026-01-01T00:00:02Z"));
    expect(await checkUserRateLimit(user, "checkout", config)).toBeNull();
  });
});

describe("lib/rate-limit — strict mode (production fail-closed)", () => {
  const savedNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (savedNodeEnv === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = savedNodeEnv;
  });

  it("throws when Redis is unavailable in production (no silent bypass)", async () => {
    env.NODE_ENV = "production";
    process.env.UPSTASH_REDIS_REST_URL = ""; // force Redis unavailable

    await expect(checkUserRateLimit(uid("user"), "/api/orders")).rejects.toThrow(
      /Redis unavailable.*production/i
    );
  });

  it("allows in-memory fallback in development", async () => {
    env.NODE_ENV = "development";
    process.env.UPSTASH_REDIS_REST_URL = "";

    // Must NOT throw; first request passes.
    const result = await checkUserRateLimit(uid("user"), "/api/orders");
    expect(result).toBeNull();
  });
});

describe("lib/rate-limit — configuration", () => {
  it("financial endpoints: 10 req/min", () => {
    expect(FINANCIAL_RATE_LIMIT.max).toBe(10);
    expect(FINANCIAL_RATE_LIMIT.windowMs).toBe(60_000);
  });

  it("withdraw endpoints: 3 req/min (stricter)", () => {
    expect(WITHDRAW_RATE_LIMIT.max).toBe(3);
    expect(WITHDRAW_RATE_LIMIT.windowMs).toBe(60_000);
  });

  it("checkout endpoints: 5 req/min", () => {
    expect(CHECKOUT_RATE_LIMIT.max).toBe(5);
    expect(CHECKOUT_RATE_LIMIT.windowMs).toBe(60_000);
  });

  it("exports all rate limit configurations", async () => {
    const rl = await import("@/lib/rate-limit");
    expect(rl).toHaveProperty("FINANCIAL_RATE_LIMIT");
    expect(rl).toHaveProperty("WITHDRAW_RATE_LIMIT");
    expect(rl).toHaveProperty("CHECKOUT_RATE_LIMIT");
    expect(rl).toHaveProperty("checkUserRateLimit");
  });
});
