/**
 * CSRF origin-acceptance decision — .C.
 *
 * Pure helper extracted from middleware.ts (edge runtime; keep this file
 * dependency-free so it stays edge-safe and unit-testable in vitest).
 *
 * Semantics:
 *  - No configured allowed origin (NEXT_PUBLIC_APP_URL unset) → allow-all
 *    (existing dev behavior; prod must set the env).
 *  - Dev-loopback mode: when the CONFIGURED origin's host is a loopback
 *    name (localhost / 127.0.0.1 / ::1), accept any request whose Origin /
 *    Referer (or, when both are absent, Host header) resolves to a loopback
 *    host on ANY port. This fixes the bug where a session opened via
 *    http://127.0.0.1:PORT was 403-blocked while NEXT_PUBLIC_APP_URL was
 *    http://localhost:3000 (and vice versa).
 *  - Non-loopback configured origins stay STRICT: exact origin match only,
 *    no wildcard / no loopback relaxation.
 */

/** Canonical loopback host names (after URL parse + lowercasing). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** WHATWG URL keeps IPv6 literals bracketed (`[::1]`) — normalize that away. */
function normalizeHostname(host: string): string {
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

/**
 * True when the URL string parses and its hostname is a loopback name.
 * `[::1]` bracket notation is handled by the URL parser and normalized here.
 */
function isLoopbackUrl(value: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(normalizeHostname(new URL(value).hostname));
  } catch {
    return false;
  }
}

/** Host header (no port) lowercased; IPv6 literal `[::1]:port` → `::1`. */
function hostHeaderName(hostHeader: string | null | undefined): string | null {
  if (!hostHeader) return null;
  const name = hostHeader.startsWith("[")
    ? hostHeader.slice(1).split("]")[0] ?? ""
    : hostHeader.split(":")[0] ?? "";
  return name ? name.toLowerCase() : null;
}

export interface CsrfOriginCheckArgs {
  /** NEXT_PUBLIC_APP_URL — the single configured allowed origin. */
  allowedOrigin: string | undefined;
  /** `Origin` request header, if present. */
  requestOrigin?: string | null;
  /** `Referer` request header — fallback when Origin is absent. */
  requestReferer?: string | null;
  /** `Host` request header — last-resort fallback when neither is present. */
  requestHost?: string | null;
}

export function isCsrfOriginAllowed(args: CsrfOriginCheckArgs): boolean {
  const { allowedOrigin, requestOrigin, requestReferer, requestHost } = args;

  // Unset → dev mode allows (localhost); production MUST fail-closed (security)
  if (!allowedOrigin) {
    return process.env.NODE_ENV !== "production";
  }

  // Prefer Origin, fall back to Referer's origin (older browsers).
  let candidate: string | null = requestOrigin ?? null;
  if (!candidate && requestReferer) {
    try {
      candidate = new URL(requestReferer).origin;
    } catch {
      candidate = null; // malformed Referer → treated as absent
    }
  }

  // Last-resort fallback when neither Origin nor Referer is present: compare
  // the request's Host-header hostname against the configured origin's
  // hostname (preserves the original middleware behavior). In dev-loopback
  // mode ANY loopback host name matches (127.0.0.1 / ::1 / localhost).
  if (!candidate) {
    let allowedHost: string | null = null;
    try {
      allowedHost = normalizeHostname(new URL(allowedOrigin).hostname);
    } catch {
      allowedHost = null; // unparseable configured origin → fail closed
    }
    const hostName = hostHeaderName(requestHost);
    if (!hostName || !allowedHost) return false;
    if (LOOPBACK_HOSTS.has(allowedHost)) return LOOPBACK_HOSTS.has(hostName);
    return hostName === allowedHost;
  }

  // Dev-loopback mode: configured origin host is loopback → accept any
  // loopback candidate on ANY port (localhost ↔ 127.0.0.1 ↔ ::1).
  if (isLoopbackUrl(allowedOrigin)) return isLoopbackUrl(candidate);

  // Production / non-loopback: strict exact match only.
  return candidate === allowedOrigin;
}
