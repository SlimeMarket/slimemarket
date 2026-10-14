import pino from "pino";

/**
 * Structured logger (pino). Replaces bare `console.log`/`console.error` in
 * money-moving paths so logs are JSON-parseable + filterable by host platforms.
 *
 * Usage:
 *   import { logger } from "@/lib/logger";
 *   logger.info({ orderId, action: "checkout" }, "checkout started");
 *   logger.error({ orderId, err: e.message }, "checkout failed");
 *
 * Request-scoped child loggers (for correlation id):
 *   const reqLog = logger.child({ reqId: crypto.randomUUID() });
 *   reqLog.info(...);  // every line carries reqId
 *
 * In dev, pino uses pino-pretty for readable output. In prod, raw JSON to
 * stdout (Vercel/CloudWatch/Datadog ingest JSON natively). Sentry captures
 * error-level events separately via instrumentation.ts.
 *
 * IMPORTANT (Next.js + pino compatibility):
 *   pino-pretty uses a worker thread for transport by default. On Next.js dev
 *   with webpack, the worker thread fails with `Cannot find module
 *   'vendor-chunks/lib/worker.js'`, which propagates as an uncaughtException
 *   and crashes the route handler (any `logger.info(...)` call throws).
 *   Fix: in dev, use `pino.transport` with `worker.autoEnd: false` OR use the
 *   sync `pino-pretty` directly (no worker). We use the sync path — set
 *   `transport` only when not in Next.js (standalone scripts).
 */

const isDev = process.env.NODE_ENV !== "production";

// Build logger. Avoid worker-thread transport in Next.js — it crashes webpack
// bundles. Use sync pino-pretty in dev, raw JSON in prod.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  base: {
    service: "slimemarket-backend",
    version: process.env.npm_package_version ?? "0.1.0",
  },
  redact: {
    // Never log credentials / PII accidentally.
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "headers.authorization",
      "headers.cookie",
      "userToken",
      "encryptionKey",
      "CIRCLE_API_KEY",
      "CIRCLE_ENTITY_SECRET",
      "SUPABASE_SERVICE_ROLE_KEY",
      "*.userToken",
      "*.encryptionKey",
    ],
    censor: "[REDACTED]",
  },
  // No transport in Next.js — sync stdout/stderr. For pretty dev logs, install
  // `pino-pretty` and pipe: `npm run dev | pnpm exec pino-pretty`. Or set
  // `transport` only when running standalone scripts (not Next.js).
  ...(isDev && !process.env.NEXT_RUNTIME
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
        },
      }
    : {}),
});

/**
 * Create a request-scoped child logger. Use in API route handlers:
 *   const log = reqLogger(req);
 *   log.info({ orderId }, "checkout");
 *
 * Attaches: reqId (UUID per request), method, path, ip.
 */
export function reqLogger(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "unknown";
  const url = new URL(req.url);
  return logger.child({
    reqId: req.headers.get("x-request-id") ?? crypto.randomUUID(),
    method: req.method,
    path: url.pathname,
    ip,
  });
}
