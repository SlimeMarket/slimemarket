/**
 * Resolve the Circle W3S token id for USDC on the active chain.
 *
 * Why this exists: `CIRCLE_USDC_TOKEN_ID` is per-entity and per-chain, and on
 * Arc there are TWO USDC tokens in the same entity — the native gas token
 * (18 decimals) and the ERC-20 interface at 0x3600…0000 (6 decimals). Sending a
 * placeholder (the all-zero UUID) or the wrong one makes Circle answer
 * `400 API parameter invalid`, which is all the user ever sees:
 *
 *   Send failed: API parameter invalid
 *
 * The wallet's OWN balance list is the authoritative answer, so it is asked
 * first; the env var is only a fallback. Result is cached per wallet for a few
 * minutes so a send does not pay for an extra round-trip every time.
 */
import { ARC_USDC_CONTRACT, CIRCLE_BLOCKCHAIN, CIRCLE_USDC_TOKEN_ID } from "@/lib/arc";

const ZERO_UUID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;

/** True when the value is missing or the all-zero placeholder UUID. */
export function isPlaceholderTokenId(id: string | null | undefined): boolean {
  return !id || ZERO_UUID.test(id.trim());
}

interface CircleToken {
  id?: string;
  symbol?: string;
  blockchain?: string;
  tokenAddress?: string;
  decimals?: number;
  isNative?: boolean;
}

interface CacheEntry { ids: string[]; at: number }
const cache = new Map<string, CacheEntry>();
const TTL_MS = 10 * 60_000;

function pickUsdcOrdered(tokens: CircleToken[]): CircleToken[] {
  const usdc = tokens.filter(
    (t) =>
      t?.id &&
      (t.symbol || "").toUpperCase() === "USDC" &&
      (!t.blockchain || t.blockchain === CIRCLE_BLOCKCHAIN),
  );
  if (!usdc.length) return [];
  // Prefer the ERC-20 interface the app (and the escrow contract) actually
  // uses — it is the 6-decimal view that our micro-USDC math assumes.
  const erc20 = usdc.find(
    (t) => (t.tokenAddress || "").toLowerCase() === ARC_USDC_CONTRACT.toLowerCase(),
  );
  const sixDecimals = usdc.find((t) => t.decimals === 6 && !t.isNative);
  const ordered = [erc20, sixDecimals, ...usdc].filter((t): t is CircleToken => !!t?.id);
  // de-dupe, keep order
  const seen = new Set<string>();
  return ordered.filter((t) => (seen.has(t.id!) ? false : (seen.add(t.id!), true)));
}

async function fetchWalletUsdcTokens(walletId: string): Promise<string[]> {
  const key = process.env.CIRCLE_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch(`https://api.circle.com/v1/w3s/wallets/${walletId}/balances`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[usdc-token] balances lookup failed: HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as { data?: { tokenBalances?: { token?: CircleToken }[] } };
    const tokens = (body?.data?.tokenBalances || [])
      .map((b) => b?.token)
      .filter((t): t is CircleToken => !!t);
    return pickUsdcOrdered(tokens).map((t) => t.id!);
  } catch (e) {
    console.warn("[usdc-token] balances lookup error:", e instanceof Error ? e.message : e);
    return [];
  }
}

/**
 * All acceptable token ids for a transfer out of `circleWalletId`, best first.
 *
 * On Arc the same funds are exposed twice (native USDC with 18 decimals and the
 * ERC-20 interface at 0x3600… with 6). If Circle rejects one variant, the caller
 * can retry with the next instead of failing the send.
 */
export async function resolveUsdcTokenIds(circleWalletId?: string): Promise<string[]> {
  const ids: string[] = [];

  if (circleWalletId) {
    const hit = cache.get(circleWalletId);
    if (hit && Date.now() - hit.at < TTL_MS) {
      ids.push(...hit.ids);
    } else {
      const fromWallet = await fetchWalletUsdcTokens(circleWalletId);
      if (fromWallet.length) {
        cache.set(circleWalletId, { ids: fromWallet, at: Date.now() });
        ids.push(...fromWallet);
      }
    }
  }

  if (!isPlaceholderTokenId(CIRCLE_USDC_TOKEN_ID) && !ids.includes(CIRCLE_USDC_TOKEN_ID)) {
    ids.push(CIRCLE_USDC_TOKEN_ID);
  }

  if (!ids.length) {
    throw new Error(
      `USDC token id is not configured for ${CIRCLE_BLOCKCHAIN} — set CIRCLE_USDC_TOKEN_ID ` +
        `(it is currently the placeholder UUID)`,
    );
  }
  return ids;
}

/**
 * Token id to use for a transfer out of `circleWalletId`.
 * Throws a human-readable error when nothing valid can be resolved, instead of
 * forwarding a placeholder to Circle (which answers with an opaque 400).
 */
export async function resolveUsdcTokenId(circleWalletId?: string): Promise<string> {
  const ids = await resolveUsdcTokenIds(circleWalletId);
  return ids[0];
}
