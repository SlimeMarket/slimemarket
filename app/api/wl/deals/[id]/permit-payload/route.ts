import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { parseBody, WlDealPermitPayloadBodySchema } from "@/lib/schemas";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { arcPublicClient } from "@/lib/arc";
import { getAddress } from "viem";
import type { Hex } from "viem";
import { readUsdcPermitInfo } from "@/lib/order/permit-checkout";
import { buildWlDealPermitPayload } from "@/lib/wl/eoa";
import { computeEscrowCheckout } from "@/lib/fee";

const ESCROW_CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS ?? "";

/**
 * POST /api/wl/deals/[id]/permit-payload — .D3 EOA deal funding step 2.
 *
 * Returns the COMPLETE EIP-2612 permit typed data for the buyer's external
 * wallet to sign (via window.WalletBridge.signTypedData). Server-authoritative:
 *   - value  = price + baseFee recomputed SERVER-side from the deal row
 *     (createEscrowDealFor pulls price + baseFee from the buyer —
 *     MarketEscrow.sol L176-196);
 *   - nonce  = USDC.nonces(payerAddress), read live from Arc RPC;
 *   - deadline = now + 30 min.
 *
 * Body: { payerAddress }
 *
 * Guards: 401 unauthenticated · 403 not the deal's buyer · 404 deal not found ·
 * 409 already funded on-chain · 503 escrow not configured / RPC unavailable.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  if (!ONCHAIN_FUNDS_ENABLED) {
    return jsonError("non-custodial WL deals require ONCHAIN_WALLET_FUNDS=1", 503);
  }
  if (!ESCROW_CONTRACT_ADDRESS) {
    return jsonError("escrow contract address not configured", 503);
  }

  const rlErr = await checkUserRateLimit(user.id, "wl-permit-payload", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const { id: dealId } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const parsed = parseBody(WlDealPermitPayloadBodySchema, body);
  if (parsed instanceof Response) return parsed;

  const admin = supabaseAdminClient();
  const { data: deal, error: dErr } = await admin.from("wl_deals")
    .select("id, buyer_id, unit, qty, status, on_chain_deal_id")
    .eq("id", dealId)
    .maybeSingle();
  if (dErr || !deal) return jsonError("deal not found", 404);
  if (deal.buyer_id !== user.id) return jsonError("not your deal", 403);
  // Any non-null on_chain_deal_id (including "0" — the first contract deal id)
  // means buyer funds are ALREADY in the escrow; a permit would double-fund.
  if (deal.on_chain_deal_id) return jsonError("deal already funded on-chain", 409);
  if (deal.status !== "WAITING") return jsonError("deal is not awaiting funding", 409);

  // Contract fact: createEscrowDealFor pulls price + computeFee(price) from the
  // buyer, so the permit value MUST be that total. this used the
  // deprecated `baseFee` (always 0n), which both under-funded the permit and
  // made buildWlDealPermitPayload throw on baseFeeMicro <= 0.
  const checkout = computeEscrowCheckout(BigInt(deal.unit as string), deal.qty as number);
  const totalMicro = checkout.itemAmount + checkout.fee;

  const payerAddress = getAddress(parsed.payerAddress) as Hex;

  // Server-authoritative nonce (a wrong nonce makes the permit unspendable).
  let info: { name: string; version: string; nonce: bigint };
  try {
    info = await readUsdcPermitInfo(arcPublicClient(), payerAddress);
  } catch (e) {
    // RPC down / timeout → clean 503 (FE falls back to the approve path).
    return jsonError(
      `permit payload unavailable: ${(e as Error).message}`,
      503,
      { code: "PERMIT_PAYLOAD_UNAVAILABLE" },
    );
  }

  const payload = buildWlDealPermitPayload({
    owner: payerAddress,
    spender: ESCROW_CONTRACT_ADDRESS,
    priceMicro: checkout.itemAmount,
    baseFeeMicro: checkout.fee,
    nonce: info.nonce,
    tokenName: info.name,
    tokenVersion: info.version,
  });

  return jsonOk(payload, 200);
}
