import { jsonError, jsonOk } from "@/lib/utils";
import { isCronSecretAuthorized } from "@/lib/utils/cron-auth";
import { requireRole } from "@/lib/auth-ucw";
import { relayPendingBridges } from "@/lib/cctp/bridge";

/**
 * Completes pending CCTP bridges by submitting the attested message on Arc.
 *
 * WHY THIS IS A JOB AND NOT PART OF THE CONFIRM REQUEST
 * Between the burn and the mint, Circle's validators have to attest the message.
 * On every chain we support that is a Standard transfer — roughly 15 minutes. No
 * request handler can hold a connection that long, so the burn is recorded and
 * this job finishes the job later.
 *
 * WHY THE DELAY IS NOT A RISK
 * `receiveMessage` on Arc is permissionless and the mint can only ever deliver
 * to the `mintRecipient` inside the signed message — the user's own Arc address.
 * If this job never ran, the user (or anyone) could still submit the same
 * attestation directly. So a missed tick costs latency, never funds.
 *
 * Auth (either):
 *   - Cron secret via `Authorization: Bearer <INDEXER_CRON_SECRET>` OR
 *     `?cron_secret=<INDEXER_CRON_SECRET>`, compared timing-safely, OR
 *   - Admin session, for manual runs from the dashboard.
 *
 * Intended to run every 5 minutes.
 */
export async function POST(req: Request) {
  if (!isCronSecretAuthorized(req, process.env.INDEXER_CRON_SECRET)) {
    try {
      await requireRole("Admin");
    } catch {
      return jsonError("Unauthorized: admin session or cron secret required", 401);
    }
  }

  try {
    const result = await relayPendingBridges();
    return jsonOk(result);
  } catch (e) {
    return jsonError(`cross-chain relay failed: ${(e as Error).message}`, 500);
  }
}

// Vercel Cron issues GET; expose the POST handler under GET too.
export { POST as GET };
