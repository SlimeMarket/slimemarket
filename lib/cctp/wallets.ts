import {
  createWalletOnlyChallenge,
  listAllUserWallets,
  type UcwWalletSummary,
} from "@/lib/circle/ucw-user";
import { missingChains, pickWalletForChain } from "@/lib/circle/ucw-provisioning";
import { CCTP_SOURCE_CHAINS, cctpSourceChain } from "./chains";

/**
 * Provisioning of the CCTP source-chain wallets an email-login (UCW) buyer
 * needs in order to hold — and then bridge — USDC on a non-Arc chain.
 *
 * WHY THIS IS NEEDED AT ALL: a UCW wallet only exists on the chain(s) it was
 * created for, and this app creates them on Arc alone. An email-login user
 * therefore has NO address on Base Sepolia / Avalanche Fuji / etc., so they
 * cannot even receive USDC there — let alone bridge it. (The in-app App Kit
 * bridge is no help either: it is EIP-1193 based and needs an external wallet.)
 *
 * Provisioning is ADDITIVE and DIFF-BASED. See `missingChains()` for why passing
 * the full desired set would hand existing users a duplicate Arc wallet.
 */

/** Source-chain wallets are only offered when the feature is switched on. */
export function crossChainPayEnabled(): boolean {
  return process.env.CROSS_CHAIN_PAY === "1";
}

/**
 * Circle blockchain identifiers to provision.
 *
 * Overridable with `CROSS_CHAIN_SOURCE_CHAINS=baseSepolia,avalancheFuji` so a
 * deployment can offer fewer chains without a code change. An unknown key is a
 * hard error rather than a silent skip: quietly provisioning a different set
 * than ops configured is how "I sent USDC to the address the UI showed me"
 * turns into a support ticket.
 */
export function desiredSourceBlockchains(): string[] {
  const raw = process.env.CROSS_CHAIN_SOURCE_CHAINS?.trim();
  if (!raw) return Object.values(CCTP_SOURCE_CHAINS).map((c) => c.circleBlockchain);

  const out: string[] = [];
  for (const key of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const chain = cctpSourceChain(key);
    if (!chain) {
      throw new Error(
        `CROSS_CHAIN_SOURCE_CHAINS lists "${key}", which is not a CCTP source chain on this network`,
      );
    }
    out.push(chain.circleBlockchain);
  }
  return out;
}

export interface SourceChainWallet {
  /** CCTP source-chain key (e.g. "baseSepolia"). */
  key: string;
  label: string;
  blockchain: string;
  address: string;
  /** True when the wallet has reached the LIVE state and can be used. */
  live: boolean;
}

/** Map the user's wallets onto the configured source chains (missing → null). */
export function sourceChainWallets(wallets: UcwWalletSummary[]): SourceChainWallet[] {
  const out: SourceChainWallet[] = [];
  for (const chain of Object.values(CCTP_SOURCE_CHAINS)) {
    const w = pickWalletForChain(wallets, chain.circleBlockchain);
    if (!w) continue;
    out.push({
      key: chain.key,
      label: chain.label,
      blockchain: chain.circleBlockchain,
      address: w.address,
      live: w.state === "LIVE",
    });
  }
  return out;
}

export interface EnsureResult {
  /** Blockchains that still need a wallet (empty → nothing to do). */
  missing: string[];
  /** Challenge id to run in the browser, or null when no challenge is needed. */
  challengeId: string | null;
  /** All of the user's wallets, as returned by Circle. */
  wallets: UcwWalletSummary[];
}

/**
 * Make sure the user has a wallet on every configured source chain.
 *
 * Returns a challenge id only when something is actually missing, so callers can
 * treat "no challenge" as the happy path and skip the PIN prompt entirely.
 */
export async function ensureSourceChainWallets(userToken: string): Promise<EnsureResult> {
  const wallets = await listAllUserWallets(userToken);
  const missing = missingChains(
    wallets.map((w) => w.blockchain),
    desiredSourceBlockchains(),
  );
  if (missing.length === 0) return { missing, challengeId: null, wallets };

  const { challengeId } = await createWalletOnlyChallenge(userToken, missing);
  return { missing, challengeId, wallets };
}
