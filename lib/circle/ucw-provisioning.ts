/**
 * .B2 — Pure helpers for UCW wallet provisioning decisions.
 *
 * Extracted so they can be unit-tested without Next.js/Supabase/Circle mocks.
 */

export interface ArcWalletCandidate {
  id?: string;
  address?: string;
  blockchain: string;
  state?: string;
}

/**
 * Pick the ARC-TESTNET wallet to persist locally from a Circle wallet list.
 *
 * Preference order:
 *   1. an ARC-TESTNET wallet in state LIVE
 *   2. the first ARC-TESTNET wallet in any other state
 *   3. null when there is no ARC-TESTNET wallet at all
 */
export function pickArcWallet<T extends ArcWalletCandidate>(wallets: T[]): T | null {
  const arc = wallets.filter((w) => w && w.blockchain === "ARC-TESTNET");
  if (arc.length === 0) return null;
  const live = arc.find((w) => w.state === "LIVE");
  return live ?? arc[0];
}

/** Pick the wallet for a specific blockchain (LIVE preferred), or null. */
export function pickWalletForChain<T extends ArcWalletCandidate>(
  wallets: T[],
  blockchain: string,
): T | null {
  const want = blockchain.toUpperCase();
  const matching = wallets.filter((w) => w && w.blockchain?.toUpperCase() === want);
  if (matching.length === 0) return null;
  const live = matching.find((w) => w.state === "LIVE");
  return live ?? matching[0];
}

/**
 * Which chains still need a wallet.
 *
 * WHY THIS EXISTS: Circle's `createWallet({ blockchains })` creates a wallet for
 * EVERY chain in the list — it does not skip chains that already have one. So
 * passing the full desired set for a user who already holds an Arc wallet would
 * hand them a SECOND Arc wallet, and the local `circleWalletId` (picked by
 * `pickArcWallet`) could then resolve to either one. Funds sent to the other
 * address would look lost.
 *
 * Diffing first makes provisioning additive and safe to re-run: an existing user
 * only ever gets the chains they are genuinely missing, and a user who has
 * everything gets an empty list (caller skips the challenge entirely).
 *
 * Matching is case-insensitive because Circle returns upper-case identifiers
 * ("BASE-SEPOLIA") while callers may hold lower-case ones. Order follows
 * `desired` so the provisioning challenge is deterministic.
 */
export function missingChains(
  existing: Array<string | null | undefined>,
  desired: Array<string | null | undefined>,
): string[] {
  const have = new Set(
    existing
      .filter((c): c is string => typeof c === "string" && c.length > 0)
      .map((c) => c.toUpperCase()),
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of desired) {
    if (typeof c !== "string" || c.length === 0) continue;
    const key = c.toUpperCase();
    if (have.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export type PinStatusLike = "ENABLED" | "LOCKED" | "UNSET" | string | undefined;

/**
 * richer provisioning decision. Every REAL session is evaluated
 * (the old `walletProvisioned === false` gate was removed — it skipped legacy
 * accounts that had a wallet but never set a PIN, e.g. Rimuru).
 *
 *   'full-challenge'        → PIN UNSET + no wallet: createUserPinWithWallets
 *                             (one hosted-UI step sets PIN + creates wallet).
 *   'pin-only-challenge'    → PIN UNSET + wallet EXISTS (legacy account):
 *                             createUserPin — sets PIN without touching the
 *                             existing wallet.
 *   'wallet-only-challenge' → PIN ENABLED + no wallet: createWallet.
 *   'done'                  → PIN ENABLED + wallet exists: just flip the
 *                             wallet_provisioned flag (wallet row handled by
 *                             the caller).
 *   'locked'                → PIN LOCKED: nothing to auto-run here; the
 *                             restore (security questions) flow is separate.
 *   'skip'                  → unknown status → never block login.
 */
export type ProvisioningAction =
  | "full-challenge"
  | "pin-only-challenge"
  | "wallet-only-challenge"
  | "done"
  | "locked"
  | "skip";

export function decideProvisioning(input: {
  pinStatus: PinStatusLike;
  hasWallet: boolean;
}): ProvisioningAction {
  const { pinStatus, hasWallet } = input;
  if (pinStatus === "ENABLED") return hasWallet ? "done" : "wallet-only-challenge";
  if (pinStatus === "UNSET") return hasWallet ? "pin-only-challenge" : "full-challenge";
  if (pinStatus === "LOCKED") return "locked";
  return "skip";
}

