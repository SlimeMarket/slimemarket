/**
 * Per-user rate limiting for financial endpoints.
 *
 * Backed by Upstash Ratelimit (Redis) when UPSTASH_REDIS_REST_URL +
 * UPSTASH_REDIS_REST_TOKEN are set — required for multi-instance prod (Vercel)
 * where in-memory buckets are per-instance and trivially bypassable.
 *
 * Falls back to in-memory (single-instance dev) when Upstash env is absent.
 *
 * Separate from middleware (IP-based) because financial operations need tighter
 * per-user limits even from the same IP (e.g. checkout, withdraw, topup).
 */
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

interface RateBucket {
  count: number;
  resetAt: number;
}

const userRateLimits = new Map<string, RateBucket>();

// Cleanup every 5 minutes (in-memory fallback only)
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of userRateLimits) {
      if (now > val.resetAt) userRateLimits.delete(key);
    }
  }, 300_000);
}

export interface RateLimitConfig {
  /** Max requests per window */
  max: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

/** Default: 10 requests per minute for financial endpoints */
export const FINANCIAL_RATE_LIMIT: RateLimitConfig = {
  max: 10,
  windowMs: 60_000,
};

/** Stricter: 3 requests per minute for withdraw */
export const WITHDRAW_RATE_LIMIT: RateLimitConfig = {
  max: 3,
  windowMs: 60_000,
};

/** Checkout: 5 per minute (prepare+challenge+confirm counts as 1 checkout). */
export const CHECKOUT_RATE_LIMIT: RateLimitConfig = {
  max: 5,
  windowMs: 60_000,
};

// --- Upstash client (lazy init; null when env absent) ----------------------

let redisClient: Redis | null = null;
let redisReady = false;
try {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    redisClient = new Redis({ url, token });
    redisReady = true;
  }
} catch (e) {
  console.warn("Upstash Redis init failed; falling back to in-memory:", e);
}

// One Ratelimit instance per RateLimitConfig (cached by max:window).
const ratelimiters = new Map<string, Ratelimit>();
function getRatelimiter(config: RateLimitConfig): Ratelimit {
  if (!redisClient) throw new Error("redis not initialized");
  const key = `${config.max}:${config.windowMs}`;
  let rl = ratelimiters.get(key);
  if (!rl) {
    // Upstash slidingWindow signature: (tokens: number, windowDuration: Duration).
    // Duration is a template-literal type `${number} ${Unit}` (e.g. "60 s",
    // "1 m") — TS can't infer from a dynamic string, so we cast.
    const windowDuration = config.windowMs >= 60_000
      ? `${Math.floor(config.windowMs / 60_000)} m`
      : `${Math.floor(config.windowMs / 1000)} s`;
    rl = new Ratelimit({
      redis: redisClient,
      // Duration is a template literal `${number} ${Unit}` where Unit ∈
      // {"ms","s","m","h","d"} — TS can't verify our dynamic string matches,
      // so cast. Runtime validation: the computed value is always "N s" or
      // "N m" (N integer > 0) which is a valid Duration.
      limiter: Ratelimit.slidingWindow(
        config.max,
        windowDuration as unknown as Parameters<typeof Ratelimit.slidingWindow>[1],
      ),
      analytics: true,
      prefix: "sm:rl",
    });
    ratelimiters.set(key, rl);
  }
  return rl;
}

/**
 * Check per-user rate limit. Returns null if allowed, or an error message if
 * blocked. Idempotent — multiple calls from the same user within the window
 * each consume a token.
 *
 * @param userId - User ID
 * @param endpoint - Endpoint identifier (separate buckets per endpoint)
 * @param config - Rate limit configuration
 */
export async function checkUserRateLimit(
  userId: string,
  endpoint: string,
  config: RateLimitConfig = FINANCIAL_RATE_LIMIT
): Promise<string | null> {
  const env = process.env.NODE_ENV || 'development';

  // CRITICAL FIX: Never fall back to in-memory in production
  if (!redisReady || !redisClient) {
    if (env === 'production') {
      // Throw error instead of bypassing limits
      throw new Error(
        'Redis unavailable - production deployment requires Upstash/Redis for rate limiting. ' +
        'Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN environment variables.'
      );
    }
    
    // Allow in-memory only for development/testing with warning
    console.warn('[RATE_LIMIT] Running without Redis - NOT FOR PRODUCTION');
  }

  // Use Redis-based rate limiting when available
  if (redisReady && redisClient) {
    try {
      const rl = getRatelimiter(config);
      const { success, remaining } = await rl.limit(`${userId}:${endpoint}`);
      
      // Log blocked requests for monitoring
      if (!success) {
        console.warn('[RATE_LIMIT_BLOCKED]', {
          userId,
          endpoint,
          max: config.max,
          windowMs: config.windowMs,
          timestamp: new Date().toISOString()
        });
        return `Rate limit exceeded (max ${config.max} per ${config.windowMs / 1000}s). Try again later.`;
      }
      
      return null;
    } catch (error) {
      // Log Redis errors but DON'T fallback to insecure in-memory
      console.error('[RATE_LIMIT.RedisError]', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userId,
        endpoint,
        timestamp: new Date().toISOString()
      });
      
      // Return 503 Service Unavailable instead of bypassing limits
      throw new Error('Rate limiting service temporarily unavailable');
    }
  }

  // If we reach here, no Redis available
  // In production this should have thrown above, so this is dev-only
  const key = `${userId}:${endpoint}`;
  const now = Date.now();
  const entry = userRateLimits.get(key);
  
  if (!entry || now > entry.resetAt) {
    userRateLimits.set(key, { count: 1, resetAt: now + config.windowMs });
    return null;
  }
  
  entry.count++;
  if (entry.count > config.max) {
    return `Rate limit exceeded (max ${config.max} per ${config.windowMs / 1000}s). Try again later.`;
  }
  
  return null;
}
