/**
 * Map an error message thrown by a Circle UCW call to the HTTP status the route
 * should return.
 *
 * WHY THIS EXISTS: the checkout challenge route used to answer every Circle
 * failure with 500. Observed live, a stale session produced
 *
 *     500 {"error":"The userToken is invalid."}
 *
 * but an invalid/expired userToken is a CLIENT problem — the browser must
 * re-authenticate, and retrying the same request will never succeed. A 500 makes
 * it look like a server bug, and gives the UI no way to say "log in again".
 *
 * 401 → the Circle session is gone; re-authenticate.
 * 503 → the server is not configured for this (a deployment problem).
 * 500 → anything else: a genuine unexpected failure.
 */
export function circleErrorStatus(msg: string): number {
  if (/userToken is invalid|invalid token|unauthor|401/i.test(msg)) return 401;
  if (/not configured|required/i.test(msg)) return 503;
  return 500;
}

/** Extra JSON fields to attach for a given status (e.g. a machine-readable code). */
export function circleErrorExtra(status: number): Record<string, unknown> | undefined {
  return status === 401 ? { code: "UCW_SESSION_INVALID" } : undefined;
}
