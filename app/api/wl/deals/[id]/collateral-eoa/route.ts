import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { proceedWlDealNonCustodial } from "@/lib/wl/transitions";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { parseBody, WlDealCollateralEoaBodySchema } from "@/lib/schemas";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { arcPublicClient } from "@/lib/arc";
import { validateDepositCollateralTx } from "@/lib/wl/eoa";
import { parseUsdc } from "@/lib/money";
import { createMmAuditLog } from "@/lib/mm";
import type { Hex } from "viem";

const ESCROW_CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS ?? "";
const PLATFORM_WALLET_ID = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";

/**
 * Sane upper bound for client-supplied collateral (mirrors
 * proceed-non-custodial): the RPC/contract accept any uint256, so cap it
 * before it can overflow downstream arithmetic or drain the seller's wallet.
 */
const MAX_COLLATERAL_MICRO = 1_000_000n * 1_000_000n;

/**
 * POST /api/wl/deals/[id]/collateral-eoa — .D3 seller EOA collateral.
 *
 * The seller's EOA already sent two WalletBridge transactions client-side:
 *   1. USDC.approve(escrow, collateral)
 *   2. depositEscrowCollateral(onChainDealId, collateral) — msg.sender ==
 *      d.seller satisfies the contract, seller pays gas in USDC.
 *
 * This route STRICTLY verifies tx #2 on Arc (status success, to = escrow,
 * from = the deal's on-chain seller, selector depositEscrowCollateral, arg
 * dealId == on_chain_deal_id, arg amount == server-held collateral), then
 * runs the DB transition (proceed_wl_deal_atomic) and logs the tx hash.
 *
 * Body: { depositTxHash, collateralUsdc, sellerAddress?, approveTxHash? }
 *
 * Zero-collateral deals don't use this route (nothing to deposit — the UCW
 * flow's zero-collateral short-circuit covers them).
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

  const rlErr = await checkUserRateLimit(user.id, "wl-collateral-eoa", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const { id: dealId } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const parsed = parseBody(WlDealCollateralEoaBodySchema, body);
  if (parsed instanceof Response) return parsed;

  const collateralMicro = parseUsdc(parsed.collateralUsdc);
  if (collateralMicro <= 0n) {
    return jsonError("EOA collateral deposit requires collateralUsdc > 0 (zero-collateral deals use the challenge flow)", 400);
  }
  // This route already rejects 0, so a collateral-required listing can never
  // proceed with no skin in the game here — only the upper bound is missing.
  if (collateralMicro > MAX_COLLATERAL_MICRO) {
    return jsonError(
      `collateral exceeds maximum ${MAX_COLLATERAL_MICRO / 1_000_000n} USDC`,
      400,
      { code: "COLLATERAL_TOO_LARGE" },
    );
  }

  const admin = supabaseAdminClient();
  const { data: deal, error: dErr } = await admin.from("wl_deals")
    .select("id, listing_id, seller_id, on_chain_deal_id, status, seller_collateral, seller_collateral_tx_hash")
    .eq("id", dealId)
    .maybeSingle();
  if (dErr || !deal) return jsonError("deal not found", 404);
  if (deal.seller_id !== user.id) return jsonError("not the seller", 403);
  if (deal.status !== "WAITING") {
    // ESCROW/COMPLETED/CANCELLED — already proceeded (idempotency: report success
    // when the recorded tx matches, so FE retries don't error out).
    if (deal.status === "ESCROW" && deal.seller_collateral_tx_hash === parsed.depositTxHash) {
      return jsonOk({ dealId, ok: true, idempotent: true }, 200);
    }
    return jsonError("deal is not awaiting collateral", 409);
  }
  const onChainDealId = deal.on_chain_deal_id as string | null;
  // "0" IS a valid created deal id — only null/empty means not yet created.
  if (onChainDealId == null || onChainDealId === "") {
    return jsonError("deal not confirmed on-chain yet", 409);
  }

  // The seller's on-chain identity: their UCW wallet row (d.seller in the
  // contract) OR any external wallet they linked to their account
  // (external_wallets — how an EOA registers itself server-side). The deposit
  // MUST come from one of these; anything else is rejected.
  const { data: sellerWallet } = await admin.from("wallets")
    .select("address").eq("user_id", deal.seller_id).maybeSingle();
  const { data: extWallets } = await admin.from("external_wallets")
    .select("address").eq("user_id", deal.seller_id);
  const candidateAddresses = [
    sellerWallet?.address,
    ...((extWallets ?? []) as { address: string }[]).map((w) => w.address),
  ].filter((a): a is string => !!a).map((a) => a.toLowerCase());
  if (candidateAddresses.length === 0) return jsonError("seller has no on-chain wallet", 400);

  // Strict on-chain verification of the deposit tx (lib/wl/eoa.ts).
  const client = arcPublicClient();
  let receipt: { status: string; to: string; from: string };
  let tx: { to: string | null; from: string; input: string };
  try {
    [receipt, tx] = await Promise.all([
      client.waitForTransactionReceipt({ hash: parsed.depositTxHash as Hex, timeout: 60_000 }) as Promise<{ status: string; to: string; from: string }>,
      client.getTransaction({ hash: parsed.depositTxHash as Hex }) as Promise<{ to: string | null; from: string; input: string }>,
    ]);
  } catch (e) {
    return jsonError(`deposit tx not found on Arc: ${(e as Error).message}`, 400);
  }

  const txSender = (tx.from ?? receipt.from ?? "").toLowerCase();
  const matchedAddress = candidateAddresses.find((a) => a === txSender);
  if (!matchedAddress) {
    return jsonError(
      `deposit tx sender ${txSender} is not the seller's registered wallet (expected one of: ${candidateAddresses.join(", ")})`,
      400,
    );
  }

  try {
    validateDepositCollateralTx(
      { to: tx.to ?? receipt.to ?? "", status: receipt.status, sender: matchedAddress, input: tx.input ?? "0x" },
      {
        escrowAddress: ESCROW_CONTRACT_ADDRESS,
        sellerAddress: matchedAddress,
        onChainDealId,
        collateralMicro,
      },
    );
  } catch (e) {
    return jsonError((e as Error).message, 400);
  }

  // Verify the approve tx too when provided (same check proceedWlDealNonCustodial
  // performs for the UCW path) + run the WAITING→ESCROW DB transition.
  const approveTxHash = (body as { approveTxHash?: unknown }).approveTxHash;
  try {
    await proceedWlDealNonCustodial({
      dealId,
      sellerId: user.id,
      collateralMicro,
      approveTxHash: typeof approveTxHash === "string" ? approveTxHash : undefined,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "proceed failed";
    return jsonError(msg, /not confirmed|timeout|not found|not your/i.test(msg) ? 400 : 500);
  }

  // Log the seller's EOA deposit (migration 0051 columns).
  await admin.from("wl_deals")
    .update({
      seller_collateral_tx_hash: parsed.depositTxHash,
      seller_collateral_wallet_type: "eoa",
    })
    .eq("id", dealId);

  await createMmAuditLog({
    mmUserId: user.id,
    mmWalletId: PLATFORM_WALLET_ID,
    actorType: "user",
    action: "RELEASE_ESCROW", // closest existing action for collateral events
    refId: dealId,
    detail: {
      type: "non-custodial-wl-deal-collateral-eoa",
      depositTxHash: parsed.depositTxHash,
      approveTxHash: typeof approveTxHash === "string" ? approveTxHash : null,
      onChainDealId,
      collateralMicro: collateralMicro.toString(),
      sellerAddress: matchedAddress,
    },
  }).catch(() => {});

  return jsonOk({ dealId, ok: true, onChainDealId, depositTxHash: parsed.depositTxHash }, 201);
}
