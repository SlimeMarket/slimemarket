import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError , clientErrorMessage } from "@/lib/utils";
import { createSessionRouteHandler, type SessionRouteHandler } from "@circle-fin/app-kit/server";
import { appServerKit } from "@/lib/circle/app-kit";
import { checkUserRateLimit, FINANCIAL_RATE_LIMIT } from "@/lib/rate-limit";

/**
 * POST /api/wallet/onramp/session — mint a short-lived Circle Onramp session
 * (now backed by Arc App Kit instead of the hand-rolled REST client).
 *
 * Flow:
 *   1. Browser asks this route for a session.
 *   2. The widget (mounted by public/app-kit-helper.jsx) handles KYC + fiat
 *      payment and delivers USDC **directly to the user's wallet on Arc**.
 *   3. Because the money lands on-chain, the DB ledger is only a mirror — no
 *      synchronous credit here. Reconciliation is driven by the deposit-settled
 *      lifecycle event.
 *
 * SECURITY: `createSessionRouteHandler` is UNAUTHENTICATED by default — without
 * the `authorize` hook below, anyone could POST a well-formed body, burn our
 * API-key quota, and drive the onramp with an attacker-chosen
 * `destinationAddress`. The hook is fail-closed: only an explicit `true`
 * proceeds.
 *
 * The response carries the session token only; the API key never leaves the
 * server. `Cache-Control: no-store` is set by the handler.
 */

let cachedHandler: SessionRouteHandler | null = null;

/**
 * Build the handler lazily. `appServerKit()` throws when CIRCLE_API_KEY is
 * missing, so doing this at module load would break the whole route module (and
 * any build that imports it) on a misconfigured deploy — we want the failure at
 * request time, with a clear error, instead.
 */
function handler(): SessionRouteHandler {
  if (cachedHandler) return cachedHandler;

  cachedHandler = createSessionRouteHandler(appServerKit().onramp, {
    authorize: async (request) => {
      const user = await getCurrentUser();
      if (!user || user.banned) return false;
      if (!user.walletAddress) return false;

      // Financial endpoint — rate-limit per user before the wallets-api round-trip.
      const rlErr = await checkUserRateLimit(user.id, "onramp", FINANCIAL_RATE_LIMIT);
      if (rlErr) return false;

      // A client-supplied destinationAddress must match the caller's own
      // wallet; POST below overwrites it anyway. Reject rather than silently
      // rewrite so a buggy client surfaces loudly instead of onramping fiat
      // into an address the caller did not intend.
      const body = (await request.clone().json().catch(() => null)) as
        | { destinationAddress?: unknown }
        | null;
      if (body && typeof body.destinationAddress === "string") {
        if (body.destinationAddress.toLowerCase() !== user.walletAddress.toLowerCase()) {
          return false;
        }
      }
      return true;
    },
  });

  return cachedHandler;
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);
  if (!user.walletAddress) {
    return jsonError("wallet not found. Please set up your wallet first.", 400);
  }

  let h: SessionRouteHandler;
  try {
    h = handler();
  } catch (e) {
    return jsonError(clientErrorMessage(e, "onramp not configured"), 503);
  }

  // Inject the server-authoritative fields the client must not control.
  const incoming = await req.clone().json().catch(() => null);
  const patched = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: JSON.stringify({
      ...(incoming && typeof incoming === "object" ? incoming : {}),
      appUserId: user.id,
      destinationAddress: user.walletAddress,
      destinationChain: "Arc_Testnet",
    }),
  });

  return h(patched);
}
