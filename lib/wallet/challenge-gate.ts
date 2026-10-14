import { canFundOnChain } from "./onchain-funding";

/**
 * Challenge-gate mock bypass (.A1).
 *
 * BUG 1 (BLOCKER): the challenge routes keyed their mock short-circuit on
 * `userToken.startsWith("dev-token-")`. Browser users log in via REAL Circle
 * UCW OTP, so they carry a real userToken and the bypass never fired — the
 * route then asked Circle for a CONTRACT_EXECUTION challenge against a USER
 * wallet id, which Circle's DCW API rejects with "Cannot find target wallet
 * in the system" → 500 on WL proceed, WL buyer challenge, and checkout for
 * EVERY browser session.
 *
 * Fix: key the decision on ENV + wallet shape, not token shape. Mock iff we
 * are in a non-production, non-forced-real environment where there is nothing
 * real to challenge (dev-token session, mock/absent wallet, or explicit
 * CIRCLE_PAYMENTS_MOCK mode). Real browser sessions in mock mode now get the
 * same `dev-bypass` short-circuit as dev-logins.
 *
 * Keep this the SINGLE source of truth for the gate so every challenge route
 * stays consistent.
 */
export function shouldMockChallenge(args: {
  userToken: string;
  circleWalletId: string | null | undefined;
}): boolean {
  if (process.env.NODE_ENV === "production") return false;
  if (process.env.FORCE_REAL_UCW === "true") return false;
  // Dev-token sessions, mock wallet ids, or explicit mock mode all short-circuit.
  if (args.userToken.startsWith("dev-token-")) return true;
  if (!canFundOnChain(args.circleWalletId)) return true;
  if (process.env.CIRCLE_PAYMENTS_MOCK !== "0") return true;
  return false;
}
