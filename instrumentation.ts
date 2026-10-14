/**
 * Sentry instrumentation. Initializes on server boot if SENTRY_DSN is set;
 * otherwise no-op (zero overhead). Captures unhandled exceptions + rejects.
 *
 * Vercel auto-wires this file (Next.js instrumentation hook convention).
 */
export async function register() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // No Sentry configured — skip. Local dev / staging without Sentry.
    return;
  }

  if (process.env.NEXT_RUNTIME === "nodejs") {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV ?? "development",
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.05"),
      // Don't send PII. Scrub authorization + cookies at the edge.
      sendDefaultPii: false,
      ignoreErrors: [
        // Common client-side noise that leaks to server logs via Next:
        "NEXT_NOT_FOUND",
        "NEXT_REDIRECT",
        // ResizeObserver loops are harmless browser-only:
        "ResizeObserver loop limit exceeded",
      ],
    });
  }
}
