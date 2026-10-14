import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { parseBody, CheckoutPermitPayloadBodySchema } from "@/lib/schemas";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { arcPublicClient } from "@/lib/arc";
import { getAddress } from "viem";
import type { Hex } from "viem";
import {
  buildEoaPermitPayload,
  readUsdcPermitInfo,
} from "@/lib/order/permit-checkout";

const ESCROW_CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS ?? "";

/**
 * POST /api/orders/checkout/permit-payload — .D EOA checkout step 2.
 *
 * Returns the COMPLETE EIP-2612 permit typed data for the buyer's external
 * wallet to sign (via window.WalletBridge.signTypedData). The server is
 * authoritative for:
 *   - value  = the SERVER-held draft's itemAmount + buyerFee (contract fact:
 *     createOrderFor pulls amount + buyerFee from the buyer — MarketEscrow.sol
 *     L115-134);
 *   - nonce  = USDC.nonces(payerAddress), read live from Arc RPC;
 *   - deadline = now + 30 min.
 *
 * Body: { orderDraftId, payerAddress }
 *
 * Errors: 404 draft not found · 403 not owner · 409 already confirmed ·
 * 503 escrow not configured / RPC unavailable (nonce read failed).
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  if (!ONCHAIN_FUNDS_ENABLED) {
    return jsonError("non-custodial checkout requires ONCHAIN_WALLET_FUNDS=1", 503);
  }
  if (!ESCROW_CONTRACT_ADDRESS) {
    return jsonError("escrow contract address not configured", 503);
  }

  const rlErr = await checkUserRateLimit(user.id, "checkout-permit-payload", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const parsed = parseBody(CheckoutPermitPayloadBodySchema, body);
  if (parsed instanceof Response) return parsed;

  const admin = supabaseAdminClient();
  const { data: order, error: oErr } = await admin.from("orders")
    .select("id, buyer_id, amount, buyer_fee, status, on_chain_order_id")
    .eq("id", parsed.orderDraftId)
    .maybeSingle();
  if (oErr || !order) return jsonError("order draft not found", 404);
  if (order.buyer_id !== user.id) return jsonError("not your order", 403);
  if (order.on_chain_order_id) return jsonError("order already confirmed", 409);
  if (order.status !== "PENDING") return jsonError("order draft is not pending", 409);

  // Contract fact (MarketEscrow.sol L126-128): createOrderFor pulls
  // amount + buyerFee from the buyer — the permit value MUST be the total.
  const itemAmountMicro = BigInt(order.amount as string);
  const buyerFeeMicro = BigInt((order.buyer_fee as string) ?? "0");
  const totalMicro = itemAmountMicro + buyerFeeMicro;

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

  const payload = buildEoaPermitPayload({
    owner: payerAddress,
    spender: ESCROW_CONTRACT_ADDRESS,
    valueMicro: totalMicro,
    nonce: info.nonce,
    tokenName: info.name,
    tokenVersion: info.version,
  });

  return jsonOk(payload, 200);
}
