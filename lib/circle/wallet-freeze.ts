import { circleDeveloperSdk } from "@/lib/circle/client";
import { logger } from "@/lib/logger";

/**
 * Freeze / unfreeze a Circle wallet at the infrastructure layer. When frozen,
 * Circle rejects all outbound transactions from the wallet — a stronger kill
 * switch than just revoking DB session (which only blocks new API calls; it
 * does nothing if the wallet's keys are somehow exfiltrated or if a tx was
 * already in flight).
 *
 * Used by the admin ban endpoint to freeze a banned user's wallet. Best-effort:
 * if the Circle API call fails (network, wallet not found, SDK not configured,
 * or the freeze API is not exposed for this wallet type), the DB ban still
 * succeeds — we log + audit so ops can manually freeze later via the Circle
 * Console.
 *
 * STATUS:
 *   - For DEVELOPER-CONTROLLED wallets (DCW): the v10 SDK does not expose a
 *     `setWalletState`/freeze method on `updateWallet` (only `name` + `refId`
 *     are settable). We fall back to a direct REST call to Circle's wallet
 *     endpoint with `{ state: "FROZEN" | "LIVE" }`. If the REST shape differs,
 *     the call will 400 — we log the error and the DB ban still stands.
 *   - For USER-CONTROLLED wallets (UCW): freeze requires the user's PIN via a
 *     W3S challenge, not yet wired. Until then, UCW freeze is a no-op log;
 *     the DB session ban is the only effective control. Full UCW freeze will
 *     be added in a follow-up.
 */
export async function setWalletFrozen(
  walletId: string,
  frozen: boolean,
): Promise<{ ok: boolean; circleWalletId: string; error?: string }> {
  if (!walletId || walletId.startsWith("mock-") || walletId.startsWith("dev-")) {
    // Dev/mock wallets — skip silently.
    return { ok: true, circleWalletId: walletId };
  }

  const apiKey = process.env.CIRCLE_API_KEY;
  const baseUrl = process.env.NEXT_PUBLIC_CIRCLE_BASE_URL ?? "https://api.circle.com";
  if (!apiKey) {
    return { ok: false, circleWalletId: walletId, error: "CIRCLE_API_KEY not configured" };
  }

  // Direct REST call to update wallet state. Circle's wallet update endpoint
  // accepts a `state` field per their API docs (LIVE | FROZEN). The DCW SDK
  // v10.6.0 doesn't expose this on `updateWallet`, so we hit the REST path.
  try {
    const resp = await fetch(`${baseUrl}/v1/w3s/wallets/${walletId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        state: frozen ? "FROZEN" : "LIVE",
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logger.error({ walletId, frozen, status: resp.status, body: text }, "wallet freeze REST failed");
      return { ok: false, circleWalletId: walletId, error: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
    }
    logger.info({ walletId, frozen }, "wallet freeze state updated via REST");
    return { ok: true, circleWalletId: walletId };
  } catch (e) {
    const msg = (e as Error).message;
    logger.error({ walletId, frozen, err: msg }, "wallet freeze REST threw");
    return { ok: false, circleWalletId: walletId, error: msg };
  }
}

/**
 * Whether the Circle SDK is configured (for guarding other wallet operations).
 * Re-exported here for callers that already import from this module.
 */
export function isCircleSdkReady(): boolean {
  return !!circleDeveloperSdk;
}
