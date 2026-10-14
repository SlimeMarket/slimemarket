import { jsonError } from "@/lib/utils";

/**
 * DEPRECATED (2026-10-14) — PIN reset via email has been removed.
 *
 * See /api/my/pin-reset-request for the rationale and recommended recovery paths.
 */
export async function POST() {
  return jsonError(
    "This endpoint is deprecated. Use /recovery for account recovery options.",
    410,
  );
}
