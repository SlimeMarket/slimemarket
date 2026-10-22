import { jsonError, jsonOk, clientErrorMessage } from "@/lib/utils";
import { getPlatformStats } from "@/lib/stats/overview";

/**
 * GET /api/stats — public platform counters for the home page pulse widget.
 *
 * Public on purpose: the widget is the first thing a logged-out visitor sees,
 * and it is the only place that says "this marketplace has people in it". The
 * payload is aggregate counts only — no user identifiers, no per-seller data.
 *
 * Must be listed in PUBLIC_API_PREFIXES (lib/security/route-classification.ts)
 * or the middleware answers 401 before this handler runs.
 */
export async function GET() {
  try {
    const stats = await getPlatformStats();
    return jsonOk(stats);
  } catch (e) {
    return jsonError(clientErrorMessage(e, "failed to load stats"), 500);
  }
}
