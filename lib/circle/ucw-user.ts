import type { Blockchain } from "@circle-fin/user-controlled-wallets";
import { circleUcwSdk } from "@/lib/circle/ucw-client";
import { CIRCLE_BLOCKCHAIN } from "@/lib/arc";

/**
 * Server-side Circle UCW user service — provisioning, user tokens, and
 * PIN lifecycle challenges (setup / change / restore).
 *
 * Account provisioning flow (one challenge does it all):
 *   createUser(userId=uid) → createUserToken → createUserPinWithWallets
 * The last challenge drives Circle's hosted UI where the user sets their
 * 6-digit PIN + security questions AND the ARC-TESTNET EOA wallet is
 * created in one step.
 *
 * All functions wrap `circleUcwSdk` (null when CIRCLE_API_KEY is unset) and
 * normalize every SDK failure into a typed {@link UcwError} with the Circle
 * business code (`155101`-`155122`), a friendly message, and an HTTP status
 * suitable for API route responses.
 */

export class UcwError extends Error {
  constructor(
    message: string,
    public code?: number,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = "UcwError";
  }
}

/**
 * Circle blockchain identifiers the app is allowed to provision wallets on.
 *
 * Mirrors the SDK's `Blockchain` union (read from
 * `@circle-fin/user-controlled-wallets`). Kept as a runtime set because the
 * values we feed in are env-driven strings: `CIRCLE_BLOCKCHAIN` and the CCTP
 * source-chain config. A typo there would otherwise surface as an opaque Circle
 * API error on a user's signup, or — worse — as a wallet silently provisioned on
 * the wrong chain.
 */
const KNOWN_BLOCKCHAINS = new Set<string>([
  // mainnet
  "ETH", "AVAX", "MATIC", "ARB", "BASE", "OP", "SOL", "ARC",
  // testnet
  "ETH-SEPOLIA", "AVAX-FUJI", "MATIC-AMOY", "ARB-SEPOLIA", "BASE-SEPOLIA",
  "OP-SEPOLIA", "ARC-TESTNET", "EVM-TESTNET",
]);

/**
 * Narrow an env/config string to the SDK's `Blockchain` union, failing loudly.
 *
 * The SDK types `blockchains` as a closed union, so a plain `string` cannot be
 * passed. Validating here means a misconfigured chain name is a clear 500 at the
 * call site rather than a confusing Circle rejection.
 */
export function asCircleBlockchain(value: string): Blockchain {
  const upper = value.trim().toUpperCase();
  if (!KNOWN_BLOCKCHAINS.has(upper)) {
    throw new UcwError(`Unknown Circle blockchain identifier: "${value}"`, undefined, 500);
  }
  return upper as Blockchain;
}

/** Circle PIN/user business codes → { friendly message, http status }. */
const UCW_ERROR_TABLE: Record<number, { message: string; httpStatus: number }> = {
  155101: { message: "Circle user already exists", httpStatus: 409 },
  155102: { message: "Circle user not found", httpStatus: 404 },
  155103: { message: "Circle user token not found", httpStatus: 401 },
  155104: { message: "Circle user token expired", httpStatus: 401 }, // FE should re-login
  155105: { message: "Circle user token invalid", httpStatus: 401 }, // FE should re-login
  155106: { message: "Circle user already initialized", httpStatus: 409 },
  155107: { message: "PIN already set", httpStatus: 409 },
  155108: { message: "Security questions already set", httpStatus: 409 },
  155110: { message: "PIN not set yet", httpStatus: 400 },
  155112: { message: "Incorrect PIN", httpStatus: 400 },
  155115: { message: "Incorrect security answers", httpStatus: 400 },
  155119: { message: "PIN temporarily locked (cooldown)", httpStatus: 423 },
  155120: { message: "Security questions temporarily locked (cooldown)", httpStatus: 423 },
  155121: { message: "Challenge expired", httpStatus: 400 },
  155122: { message: "Challenge invalid", httpStatus: 400 },
};

/** Pull { code, message, status } out of whatever the SDK/axios threw. */
function extractErrorInfo(e: unknown): {
  code?: number;
  message?: string;
  status?: number;
} {
  if (!e || typeof e !== "object") return {};
  const err = e as Record<string, unknown>;

  // Circle TS SDK throws HttpResponseError with `code` (Circle business code
  // from response.data.code), `status` (HTTP status) and `message`.
  let code = err.code;
  let message = typeof err.message === "string" ? err.message : undefined;
  let status = typeof err.status === "number" ? err.status : undefined;

  // Raw axios fallback: { response: { data: { code, message }, status } }.
  const response = err.response as
    | { data?: { code?: unknown; message?: unknown }; status?: number }
    | undefined;
  if (response && typeof response === "object") {
    if (code === undefined && response.data?.code !== undefined) {
      code = response.data.code;
    }
    if (!message && typeof response.data?.message === "string") {
      message = response.data.message;
    }
    if (status === undefined && typeof response.status === "number") {
      status = response.status;
    }
  }

  const codeNum = typeof code === "string" ? Number(code) : code;
  return {
    code: typeof codeNum === "number" && Number.isFinite(codeNum) ? codeNum : undefined,
    message,
    status,
  };
}

/**
 * Map any Circle SDK error to a {@link UcwError}.
 *
 * Known PIN/user business codes (155101-155122) get a friendly message and a
 * semantically correct HTTP status. Unknown errors keep the SDK's HTTP status
 * (or the raw message), defaulting to 502 (upstream failure).
 */
export function mapUcwError(e: unknown): UcwError {
  if (e instanceof UcwError) return e;
  const info = extractErrorInfo(e);
  const mapped = info.code !== undefined ? UCW_ERROR_TABLE[info.code] : undefined;
  if (mapped) return new UcwError(mapped.message, info.code, mapped.httpStatus);
  const fallbackMessage = info.message || "Circle UCW request failed";
  return new UcwError(fallbackMessage, info.code, info.status ?? 502);
}

function requireSdk() {
  if (!circleUcwSdk) throw new UcwError("UCW not configured", undefined, 503);
  return circleUcwSdk;
}

/**
 * Ensure a Circle UCW user exists for our 4-char UID (the uid doubles as the
 * Circle userId). Idempotent: 155101 (existing user) is treated as success.
 */
export async function createOrGetCircleUser(
  uid: string,
): Promise<{ userId: string; status: "created" | "existing" }> {
  try {
    const sdk = requireSdk();
    await sdk.createUser({ userId: uid });
    return { userId: uid, status: "created" };
  } catch (e) {
    const mapped = mapUcwError(e);
    if (mapped.code === 155101) return { userId: uid, status: "existing" };
    throw mapped;
  }
}

/**
 * Issue a fresh user token (JWT, 60-minute expiry) for the user. Store the
 * userToken (+ encryptionKey) in an httpOnly cookie — never localStorage.
 */
export async function issueUserToken(
  userId: string,
): Promise<{ userToken: string; encryptionKey?: string }> {
  try {
    const sdk = requireSdk();
    const res = await sdk.createUserToken({ userId });
    const data = res.data;
    if (!data?.userToken) {
      throw new UcwError("createUserToken: no userToken in response", undefined, 502);
    }
    return { userToken: data.userToken, encryptionKey: data.encryptionKey };
  } catch (e) {
    throw mapUcwError(e);
  }
}

export type UcwPinStatus = "ENABLED" | "LOCKED" | "UNSET";

export interface UcwUserStatus {
  pinStatus: UcwPinStatus;
  status: "ENABLED" | "DISABLED";
  pinDetails?: { failedAttempts?: number; lockedExpiryDate?: string };
  securityQuestionDetails?: { failedAttempts?: number; lockedExpiryDate?: string };
}

/** Read PIN / security-question status for the user (drives FE gating). */
export async function getCircleUserStatus(userToken: string): Promise<UcwUserStatus> {
  try {
    const sdk = requireSdk();
    const res = await sdk.getUserStatus({ userToken });
    const data = res.data;
    if (!data) throw new UcwError("getUserStatus: empty response", undefined, 502);
    return {
      pinStatus: (data.pinStatus ?? "UNSET") as UcwPinStatus,
      status: (data.status ?? "DISABLED") as UcwUserStatus["status"],
      pinDetails: data.pinDetails
        ? {
            failedAttempts: data.pinDetails.failedAttempts,
            lockedExpiryDate: data.pinDetails.lockedExpiryDate,
          }
        : undefined,
      securityQuestionDetails: data.securityQuestionDetails
        ? {
            failedAttempts: data.securityQuestionDetails.failedAttempts,
            lockedExpiryDate: data.securityQuestionDetails.lockedExpiryDate,
          }
        : undefined,
    };
  } catch (e) {
    throw mapUcwError(e);
  }
}

/**
 * ONE challenge that drives the hosted UI: user sets their 6-digit PIN +
 * security questions AND the ARC-TESTNET EOA wallet is created. Pass the
 * returned challengeId to `W3SSdk.execute(challengeId)` in the browser.
 */
export async function createPinSetupChallenge(
  userToken: string,
): Promise<{ challengeId: string }> {
  try {
    const sdk = requireSdk();
    const res = await sdk.createUserPinWithWallets({
      userToken,
      // Network-aware: "ARC-TESTNET" is rejected outright when pointed at
      // mainnet, which would break first-time provisioning on the mainnet build.
      blockchains: [asCircleBlockchain(CIRCLE_BLOCKCHAIN)],
      accountType: "EOA",
    });
    const challengeId = res.data?.challengeId;
    if (!challengeId) {
      throw new UcwError("createUserPinWithWallets: no challengeId in response", undefined, 502);
    }
    return { challengeId };
  } catch (e) {
    throw mapUcwError(e);
  }
}

/**
 * Change-PIN challenge (requires the old PIN in the hosted UI).
 * Requires pinStatus ENABLED.
 */
export async function createPinChangeChallenge(
  userToken: string,
): Promise<{ challengeId: string }> {
  try {
    const sdk = requireSdk();
    const res = await sdk.updateUserPin({ userToken });
    const challengeId = res.data?.challengeId;
    if (!challengeId) {
      throw new UcwError("updateUserPin: no challengeId in response", undefined, 502);
    }
    return { challengeId };
  } catch (e) {
    throw mapUcwError(e);
  }
}

/**
 * Restore-PIN challenge — the security-questions recovery path for users who
 * forgot their PIN. Requires security questions to be ENABLED.
 */
export async function createPinRestoreChallenge(
  userToken: string,
): Promise<{ challengeId: string }> {
  try {
    const sdk = requireSdk();
    const res = await sdk.restoreUserPin({ userToken });
    const challengeId = res.data?.challengeId;
    if (!challengeId) {
      throw new UcwError("restoreUserPin: no challengeId in response", undefined, 502);
    }
    return { challengeId };
  } catch (e) {
    throw mapUcwError(e);
  }
}

/**
 * PIN-ONLY setup challenge for LEGACY users who already have an
 * ARC-TESTNET wallet but never set a PIN (pinStatus UNSET + hasWallet).
 * `createUserPin` drives the hosted UI: Create PIN → Verify PIN (2x) →
 * security questions, WITHOUT creating another wallet. Pass the returned
 * challengeId to `W3SSdk.execute(challengeId)` in the browser.
 */
export async function createPinOnlyChallenge(
  userToken: string,
): Promise<{ challengeId: string }> {
  try {
    const sdk = requireSdk();
    const res = await sdk.createUserPin({ userToken });
    const challengeId = res.data?.challengeId;
    if (!challengeId) {
      throw new UcwError("createUserPin: no challengeId in response", undefined, 502);
    }
    return { challengeId };
  } catch (e) {
    throw mapUcwError(e);
  }
}

/**
 * resolve a provisioning ACTION (from decideProvisioning) into the
 * matching hosted-UI challenge. Shared by /api/auth/me and /api/auth/unified
 * so both entry points offer the same challenge for the same account state.
 * Returns null for actions that have no challenge (done / locked / skip).
 */
export async function challengeForProvisioningAction(
  action:
    | "full-challenge"
    | "pin-only-challenge"
    | "wallet-only-challenge"
    | "done"
    | "locked"
    | "skip",
  userToken: string,
): Promise<{ challengeId: string } | null> {
  switch (action) {
    case "full-challenge":
      return createPinSetupChallenge(userToken); // PIN + wallet in one step
    case "pin-only-challenge":
      return createPinOnlyChallenge(userToken); // legacy: wallet exists, PIN missing
    case "wallet-only-challenge":
      return createWalletOnlyChallenge(userToken); // PIN exists, wallet missing
    default:
      return null; // done / locked / skip → no challenge to run
  }
}

export interface UcwWalletSummary {
  id: string;
  address: string;
  blockchain: string;
  state: string;
}

/** List the user's Arc wallets (mainnet "ARC" or testnet "ARC-TESTNET"). */
export async function listUserWallets(userToken: string): Promise<UcwWalletSummary[]> {
  try {
    const sdk = requireSdk();
    const res = await sdk.listWallets({ userToken });
    const wallets = res.data?.wallets ?? [];
    return wallets
      .filter((w) => w.blockchain === "ARC" || w.blockchain === "ARC-TESTNET")
      .map((w) => ({ id: w.id, address: w.address, blockchain: w.blockchain, state: w.state }));
  } catch (e) {
    throw mapUcwError(e);
  }
}

/**
 * List ALL of the user's wallets, across every chain.
 *
 * Distinct from `listUserWallets`, which is deliberately Arc-only (its callers
 * persist "the" wallet id and must not see other chains). Cross-chain features
 * need the full set to know which source chains the user can already receive on.
 */
export async function listAllUserWallets(userToken: string): Promise<UcwWalletSummary[]> {
  try {
    const sdk = requireSdk();
    const res = await sdk.listWallets({ userToken });
    const wallets = res.data?.wallets ?? [];
    return wallets.map((w) => ({
      id: w.id,
      address: w.address,
      blockchain: w.blockchain,
      state: w.state,
    }));
  } catch (e) {
    throw mapUcwError(e);
  }
}

/**
 * Wallet-only challenge for users who ALREADY have a PIN but need one or more
 * additional wallets (e.g. re-provision after loss, or first-time provisioning
 * of the CCTP source chains).
 *
 * `blockchains` MUST be the diffed set from `missingChains()` — Circle creates a
 * wallet for every chain listed, including duplicates of ones the user already
 * has. Defaults to the single Arc chain so existing callers are unchanged.
 */
export async function createWalletOnlyChallenge(
  userToken: string,
  blockchains: string[] = [CIRCLE_BLOCKCHAIN],
): Promise<{ challengeId: string }> {
  if (blockchains.length === 0) {
    throw new UcwError("createWallet: blockchains must not be empty", undefined, 400);
  }
  try {
    const sdk = requireSdk();
    const res = await sdk.createWallet({
      userToken,
      blockchains: blockchains.map(asCircleBlockchain),
      accountType: "EOA",
    });
    const challengeId = res.data?.challengeId;
    if (!challengeId) {
      throw new UcwError("createWallet: no challengeId in response", undefined, 502);
    }
    return { challengeId };
  } catch (e) {
    throw mapUcwError(e);
  }
}
