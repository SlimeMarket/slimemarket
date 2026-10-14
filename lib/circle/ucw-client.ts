import { initiateUserControlledWalletsClient } from "@circle-fin/user-controlled-wallets";

/**
 * Circle User-Controlled Wallets (UCW) SDK client — server-side only.
 *
 * Separate from the DCW client (`lib/circle/client.ts:circleDeveloperSdk`)
 * because UCW operations require the end user's `userToken` (via X-User-Token
 * header) instead of `entitySecretCiphertext`. UCW operations go through the
 * challenge-response model: the backend creates a challenge, the user approves
 * via W3SSdk in the browser.
 *
 * Per Circle skill `use-user-controlled-wallets`:
 *   - ALWAYS keep CIRCLE_API_KEY server-side
 *   - ALWAYS store userToken + encryptionKey in httpOnly cookies (not localStorage)
 *   - The SDK method `createUserTransactionContractExecutionChallenge` returns
 *     `{ challengeId }` — pass to `W3SSdk.execute(challengeId)` in the browser.
 */
/**
 * True only while `next build` is collecting page data.
 *
 * `next build` imports every route module to decide static vs dynamic. This file
 * runs its guard at MODULE LOAD (`circleUcwSdk` below), so without this the build
 * itself fails with:
 *
 *   SECURITY: Production environment detected with CIRCLE_PAYMENTS_MOCK!=0
 *   → Failed to collect page data for /api/admin/treasury/withdraw
 *
 * That is a false positive: the build stage has no runtime env (`.env.production`
 * is dockerignored, and only NEXT_PUBLIC_* are passed as build args), and a build
 * is not a running server. The guard below is a RUNTIME check and still fires
 * when the server actually starts — which is where it matters.
 */
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

function buildUcwClient() {
  const apiKey = process.env.CIRCLE_API_KEY;
  
  // Production security check: reject silent mock mode to prevent accidental production deployment with dev tokens
  if (process.env.NODE_ENV === "production" && !isBuildPhase) {
    if (process.env.CIRCLE_PAYMENTS_MOCK !== "0") {
      throw new Error(
        "SECURITY: Production environment detected with CIRCLE_PAYMENTS_MOCK!=0. " +
        "This is unsafe — set CIRCLE_PAYMENTS_MOCK=0 or remove the .env override."
      );
    }
    if (process.env.FORCE_REAL_UCW !== "true") {
      console.warn(
        "WARNING: NODE_ENV=production but FORCE_REAL_UCW not set to true. " +
        "Consider setting FORCE_REAL_UCW=true for explicit production safety."
      );
    }
  }
  
  if (!apiKey) return null;
  return initiateUserControlledWalletsClient({ apiKey });
}

export const circleUcwSdk = buildUcwClient();
