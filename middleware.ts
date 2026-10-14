import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { type NextRequest, NextResponse } from "next/server";
import { isCsrfOriginAllowed } from "@/lib/security/csrf-origin";
// Route classification (public / cron / webhook) lives in a dependency-free
// module so tests can assert it against scripts/scheduler.js.
// it previously lived inline below and had drifted: onchain-ids was
// scheduled but not exempted, so it 401'd on every run.
import { isCronApi, isPublicApi } from "@/lib/security/route-classification";

// Cart cookie helper functions (moved here for shared access)
function getCartCookie() {
  return function(request: NextRequest) {
    const cookieValue = request.cookies.get('slimemarket-cart');
    if (!cookieValue?.value) return null;

    try {
      // The SPA writes `count:encodeURIComponent(JSON.stringify(items))`; the
      // edge cookie jar already percent-decodes the value before we see it,
      // so `raw` here is `count:json`. Split on the FIRST colon only — the
      // JSON payload itself contains colons, so a plain split(':') would
      // truncate it and JSON.parse would fail.
      const raw = cookieValue.value;
      const sep = raw.indexOf(':');
      if (sep === -1) return null;
      const count = parseInt(raw.slice(0, sep), 10);
      const items = JSON.parse(raw.slice(sep + 1) || '[]');

      return { count, items };
    } catch (error) {
      console.error('[CartCookie] Parse error:', error);
      return null;
    }
  };
}

// --- Rate limiting -----------------------------------------------------------

// Two backends:
//  1. Upstash Redis via @upstash/ratelimit — active when both
//     UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set. Both
//     packages are fetch-based REST clients with no node:* imports, so they
//     are EDGE-RUNTIME SAFE. State lives in Redis, shared across every
//     serverless instance, so the limit actually holds on Vercel.
//  2. In-memory Map — fallback for local dev when the Upstash env is absent.
//     Per-instance (useless as real protection on serverless), but keeps
//     local dev working without Redis credentials.

// Failure mode: FAIL-OPEN on Upstash errors, in ALL environments, with
// console.error logging. A transient Redis/network outage must not 429 or 500
// the whole site — rate limiting is an abuse mitigation, not an auth
// boundary. (The per-USER financial limits in lib/rate-limit.ts stay
// fail-closed in production; money movement is a stricter requirement than
// general traffic shaping.)
// ------------------------------------------------------------------------------

const RATE_LIMIT = 100; // requests per minute per IP
const RATE_WINDOW_MS = 60_000;

/**
 * Extract the client IP from an `x-forwarded-for` header value.
 *
 * The header is a comma-separated list `client, proxy1, proxy2` where the
 * LEFTMOST entry is the original client. Handles IPv4/IPv6 (bracketless —
 * raw IPs contain no commas), whitespace, empty segments and the literal
 * "unknown" that Vercel/some proxies emit. Returns null when no usable
 * candidate exists. Pure function — unit tested in
 * __tests__/middleware-rate-limit.test.ts.
 */
export function parseClientIp(headerValue: string | null): string | null {
  if (!headerValue) return null;
  for (const part of headerValue.split(",")) {
    const candidate = part.trim();
    if (candidate && candidate.toLowerCase() !== "unknown") {
      return candidate;
    }
  }
  return null;
}

// Upstash limiter — constructed once at module load (edge cold start) when
// env is present; null otherwise → in-memory fallback path.
let upstashLimiter: Ratelimit | null = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    upstashLimiter = new Ratelimit({
      redis: new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      }),
      // Match the previous in-memory limit: 100 requests per minute per IP,
      // sliding window. Duration literal "1 m" satisfies the Duration type.
      limiter: Ratelimit.slidingWindow(RATE_LIMIT, "1 m"),
      analytics: false,
      prefix: "sm:rl:ip",
    });
  } catch (error) {
    // Bad env shape etc. — degrade to in-memory rather than crash the
    // middleware module (which would break ALL requests).
    console.error("[middleware.rateLimit] Upstash init failed:", error);
    upstashLimiter = null;
  }
}

// In-memory buckets (dev fallback only).
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function memoryRateLimit(ip: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  entry.count++;
  if (entry.count > RATE_LIMIT) {
    return { allowed: false, remaining: 0 };
  }
  return { allowed: true, remaining: RATE_LIMIT - entry.count };
}

async function rateLimit(ip: string): Promise<{ allowed: boolean; remaining: number }> {
  if (upstashLimiter) {
    try {
      const { success, remaining } = await upstashLimiter.limit(ip);
      return { allowed: success, remaining };
    } catch (error) {
      // FAIL-OPEN (see block comment above): never take the site down
      // because Redis is unreachable. Log loudly so ops sees the outage.
      console.error("[middleware.rateLimit] Upstash error — failing open:", error);
      return { allowed: true, remaining: RATE_LIMIT };
    }
  }
  return memoryRateLimit(ip);
}

// Cleanup old entries every 5 minutes (dev fallback only)
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(key);
    }
  }, 300_000);
}

// CSRF protection: state-changing methods must originate from the configured
// app origin. Cookie-only auth (no Authorization header) is vulnerable to CSRF
// because the browser auto-sends cookies on any cross-site POST. We check the
// `Origin` header (preferred, sent on all CORS-relevant requests) and fall back
// to `Referer` for older browsers. Webhooks use signed secrets instead and are
// excluded from the matcher entirely.

// .C — the origin-acceptance decision lives in the pure, unit-tested
// helper `isCsrfOriginAllowed` (lib/security/csrf-origin.ts). Dev-loopback
// hardening: when NEXT_PUBLIC_APP_URL's host is a loopback name
// (localhost / 127.0.0.1 / ::1), requests from ANY loopback Origin/Referer
// on ANY port are accepted (fixes 403s for sessions opened via 127.0.0.1).
// Non-loopback origins stay strictly matched.
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isCsrfSafe(req: NextRequest): boolean {
  const method = req.method.toUpperCase();
  if (!STATE_CHANGING_METHODS.has(method)) return true;
  if (isPublicApi(req.nextUrl.pathname)) return true;
  // .F-fix — Vercel cron POSTs carry no Origin/Referer; cron routes
  // authenticate with INDEXER_CRON_SECRET / Admin session instead.
  if (isCronApi(req.nextUrl.pathname)) return true;

  // Unset NEXT_PUBLIC_APP_URL → allow-all (dev mode); see helper.
  return isCsrfOriginAllowed({
    allowedOrigin: process.env.NEXT_PUBLIC_APP_URL,
    requestOrigin: req.headers.get("origin"),
    requestReferer: req.headers.get("referer"),
    requestHost: req.headers.get("host"),
  });
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const getCart = getCartCookie()(request);

  // Rate limit for API routes
  if (pathname.startsWith("/api/")) {
    const ip =
      parseClientIp(request.headers.get("x-forwarded-for")) ||
      request.headers.get("x-real-ip") ||
      "127.0.0.1";
    const rl = await rateLimit(ip);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Try again later." },
        { status: 429, headers: { "Retry-After": "60" } }
      );
    }

    // CSRF: state-changing methods must come from the configured app origin.
    if (!isCsrfSafe(request)) {
      // Make the rejection self-diagnosing. A 403 here is almost always the
      // local-testing footgun: browsing the app through the cloudflared tunnel
      // URL while NEXT_PUBLIC_APP_URL is http://localhost:3000. The tunnel is
      // ONLY for Circle → /api/webhooks/escrow delivery; every browser POST from
      // it is cross-origin and blocked. Log the origin so it is obvious.
      const allowedOrigin = process.env.NEXT_PUBLIC_APP_URL || "(unset)";
      const seenOrigin =
        request.headers.get("origin") || request.headers.get("referer") || "(none)";
      console.warn(
        `[csrf] blocked ${request.method} ${pathname} — origin=${seenOrigin} allowedOrigin=${allowedOrigin}`,
      );
      return NextResponse.json(
        {
          error: "cross-origin request blocked (CSRF)",
          origin: seenOrigin,
          allowedOrigin,
          hint:
            "Open the app at the configured origin (local testing: http://localhost:3000). " +
            "The cloudflared tunnel is only for Circle webhook delivery — browsing through " +
            "it makes every POST fail here.",
        },
        { status: 403 },
      );
    }

    // UCW session gate: protected API routes require auth cookies.
    // .F-fix — cron routes are exempt: Vercel's scheduler sends no
    // session cookies; each route enforces its own cron secret / Admin
    // session (lib/utils/cron-auth.ts). Without this exemption every
    // scheduled run 401'd here before the route-level auth ran.
    if (!isPublicApi(pathname) && !isCronApi(pathname)) {
      const hasSession =
        request.cookies.get("circle_user_token")?.value &&
        request.cookies.get("circle_email")?.value;
      if (!hasSession) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
    }

    const response = NextResponse.next();
    response.headers.set("X-RateLimit-Remaining", String(rl.remaining));
    response.headers.set("X-RateLimit-Limit", String(RATE_LIMIT));

    // Store cart data in headers for server components if available
    if (getCart) {
      response.headers.set("x-cart-count", getCart.count.toString());
      response.headers.set("x-cart-items", JSON.stringify(getCart.items));
    }

    return response;
  }

  // Guard checkout page if cart is empty (on frontend paths too)
  if (pathname === "/checkout" && getCart && getCart.count === 0) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/webhooks/).*)",
  ],
};
