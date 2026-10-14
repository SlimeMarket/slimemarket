import { getCurrentUser, getUcwCredentials } from "@/lib/auth-ucw";
import { jsonError, jsonOk, clientErrorMessage } from "@/lib/utils";
import { parseBody, CrossChainBodySchema } from "@/lib/schemas";
import { parseUsdc } from "@/lib/money";
import { checkUserRateLimit, WITHDRAW_RATE_LIMIT } from "@/lib/rate-limit";
import {
  BridgeError,
  confirmBridgeStep,
  getBridgeOverview,
  retryBridge,
  startBridge,
} from "@/lib/cctp/bridge";
import { crossChainPayEnabled } from "@/lib/cctp/wallets";

/**
 * Cross-chain payment: bridge USDC from another chain onto Arc, paid from the
 * user's own wallet.
 *
 * WHY THIS EXISTS ALONGSIDE THE APP KIT BRIDGE
 * `app-kit-bridge/entry.ts` signs through an EIP-1193 provider, so it only works
 * for users who brought an external wallet. Email-login users have no provider —
 * their wallet is a Circle UCW that only exists on Arc. This route gives them a
 * path: CCTP burn signed with their PIN, then a permissionless mint on Arc.
 *
 * TWO ENDPOINTS IN ONE FILE because they are one conversation:
 *   GET  -> what can I bridge from, and where did my last attempts get to?
 *   POST -> prepare (start) or confirm (advance one verified step)
 *
 * Every write is server-side via the service role; the client never touches
 * `cross_chain_bridges` directly (migration 0091 grants it nothing).
 */

export const dynamic = "force-dynamic";

/** Feature flag: the whole surface 404s when off, so it can ship dark. */
function disabled() {
  return !crossChainPayEnabled();
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  // Return the flag rather than 404 so the UI can hide the section cleanly
  // instead of showing a broken widget on every load.
  if (disabled()) {
    return jsonOk({ enabled: false, arcDomain: 26, arcRecipient: null, chains: [], provisionChallenge: null, bridges: [] });
  }

  try {
    const creds = await getUcwCredentials();
    const overview = await getBridgeOverview(user, creds);
    return jsonOk(overview);
  } catch (e) {
    return jsonError(clientErrorMessage(e, "Could not load cross-chain status"), 500);
  }
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);
  if (disabled()) return jsonError("cross-chain payments are not enabled", 404);

  // Same limiter as withdraw: this moves real funds out of the user's wallet and
  // each step costs a PIN prompt plus source-chain gas.
  const rlErr = await checkUserRateLimit(user.id, "cross-chain", WITHDRAW_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  const parsed = parseBody(CrossChainBodySchema, body);
  if (parsed instanceof Response) return parsed;

  const creds = await getUcwCredentials();
  if (!creds?.userToken) {
    return jsonError("Your wallet session expired — sign in again to continue", 401);
  }

  try {
    if (parsed.action === "prepare") {
      const amountMicro = parseUsdc(parsed.amountUsdc);
      const result = await startBridge({
        user,
        userToken: creds.userToken,
        sourceChainKey: parsed.sourceChain,
        amountMicro,
      });
      return jsonOk(result);
    }

    if (parsed.action === "retry") {
      const result = await retryBridge({ userId: user.id, bridgeId: parsed.bridgeId });
      return jsonOk(result);
    }

    const result = await confirmBridgeStep({
      user,
      userToken: creds.userToken,
      bridgeId: parsed.bridgeId,
      step: parsed.step,
      txHash: parsed.txHash,
    });
    return jsonOk(result);
  } catch (e) {
    if (e instanceof BridgeError) {
      return jsonError(e.message, e.httpStatus);
    }
    // BridgeError messages are written for humans; anything else might be a
    // driver/Circle error, so route it through the sanitiser.
    return jsonError(clientErrorMessage(e, "Cross-chain bridge failed"), 500);
  }
}
