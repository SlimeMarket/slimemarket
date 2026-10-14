import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { computeEscrowCheckout } from "@/lib/fee";
import {
  createEscrowDealOnChain,
  createEscrowDealForOnChain,
  depositEscrowCollateralOnChain,
  releaseEscrowOnChain,
  refundEscrowOnChain,
  refundEscrowWithSlashOnChain,
  isContractReady,
  readOnChainDealCollateral,
  DEFAULT_OTC_DELIVERY_WINDOW_SECONDS,
  MIN_DELIVERY_WINDOW_SECONDS,
  MAX_DELIVERY_WINDOW_SECONDS,
  type PermitSig,
} from "@/lib/contracts/escrow-client";
import { evaluateCollateralGate } from "@/lib/wl/collateral-gate";
import { buildDisputeBrief, type DisputeEvidenceItem } from "@/lib/disputes/brief";
import { resolveDealIdFromCircleTx } from "@/lib/contracts/resolver";
import { arcPublicClient } from "@/lib/arc";
import { getOnChainBalanceMicro, ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { ARC_USDC_CONTRACT } from "@/lib/arc";
import { createMmAuditLog } from "@/lib/mm";
import { logger } from "@/lib/logger";
import { notifyUser } from "@/lib/notif";
import {
  readUsdcPermitInfo,
  resolveConfirmPayer,
  verifyUsdcPermitSignature,
} from "@/lib/order/permit-checkout";
import type { Hex } from "viem";

const PLATFORM_WALLET_ID = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";
const ESCROW_CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS ?? "";

/** Buffer for the buyer's/seller's approve gas (Arc native USDC). */
const APPROVE_GAS_BUFFER_MICRO = 50_000n; // 0.05 USDC

/**
 * Mirror the contract's `_clampDeliveryWindow` so the DB `delivery_deadline`
 * lands on the SAME instant the chain will use. The contract clamps whatever we
 * pass into [MIN_DELIVERY_WINDOW, MAX_DELIVERY_WINDOW]; if we stored the raw
 * listing value instead, a listing outside the range would produce a DB deadline
 * that drifts from the on-chain one — and the escape-hatch guard (which trusts
 * the DB value) would green-light a relay the contract then reverts.
 */
function clampDeliveryWindow(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_OTC_DELIVERY_WINDOW_SECONDS;
  return Math.min(Math.max(Math.floor(seconds), MIN_DELIVERY_WINDOW_SECONDS), MAX_DELIVERY_WINDOW_SECONDS);
}

/**
 * True when `wl_deals.on_chain_deal_id` indicates an ALREADY-CREATED on-chain
 * deal. ANY non-null/non-empty value counts — including `"0"`, which is the
 * valid uint id of the first deal the contract ever created (live evidence:
 * stuck deal b9dbcae6 was created as contract deal id 0). Treating `"0"` as
 * falsy/not-created caused duplicate create-relay attempts; treat only
 * null/empty string as "not yet created".
 */
export function hasOnChainDeal(onChainDealId: string | null | undefined): boolean {
  return onChainDealId != null && onChainDealId !== "";
}

/**
 * WL deal transitions. Fee FINAL (escrow mode): 0% platform seller, $4 base
 * buyer, collateral full refund. Release/refund staff-only — Admin OR MM
 * (enforced in RPC + requireStaffAuth). 3.
 *
 * On-chain contract calls are non-blocking — DB ledger is source of truth.
 * Contract provides verifiable trust layer for users.
 */

export interface CreateDealInput {
  listingId: string;
  unit?: number;   // decimal USDC, default = listing unit_price
  qty?: number;
  isOffer?: boolean;
}

/** Buyer quick-buy/offer → WAITING (no fund lock). */
export async function createDeal(buyerId: string, input: CreateDealInput): Promise<string> {
  const admin = supabaseAdminClient();
  // fetch listing for default unit price + seller + the seller's delivery window
  const { data: listing, error: lErr } = await admin
    .from("wl_listings")
    .select("unit_price, seller_id, delivery_window_seconds")
    .eq("id", input.listingId)
    .maybeSingle();
  if (lErr || !listing) throw new Error("listing not found");

  const qty = Math.max(1, input.qty ?? 1);
  const unitMicro = input.unit != null
    ? BigInt(Math.round(input.unit * 1_000_000))
    : BigInt(listing.unit_price as string);
  const checkout = computeEscrowCheckout(unitMicro, qty);

  const { data: dealId, error: rpcErr } = await admin.rpc("create_wl_deal", {
    p_buyer_id: buyerId,
    p_listing_id: input.listingId,
    p_unit: unitMicro.toString(),
    p_qty: qty,
    p_is_offer: input.isOffer ?? false,
    p_base_fee: checkout.fee.toString(),
  });
  if (rpcErr || !dealId) throw new Error(`create_wl_deal: ${rpcErr?.message}`);

  // Notify seller about new escrow deal
  await notifyUser(listing.seller_id as string, {
    icon: "shield-check",
    tone: "amber",
    title: "New Escrow Deal",
    text: `A buyer started an escrow deal (qty: ${qty}) for your listing.`,
    link: "escrow",
  }).catch(() => {});

  // On-chain: create escrow deal in contract (non-blocking)
  if (isContractReady()) {
    try {
      // Get seller wallet address
      const { data: sellerWallet } = await admin.from("wallets")
        .select("address").eq("user_id", listing.seller_id).maybeSingle();

      if (sellerWallet?.address) {
        // The delivery window is the SELLER's choice, stored on the listing: a WL
        // spot ships in minutes, while an airdrop-eligible wallet may only pay out
        // months later. The contract clamps whatever we send into
        // [MIN_DELIVERY_WINDOW, MAX_DELIVERY_WINDOW] — clamp here too so the DB
        // mirror lands on the exact instant the chain will use (bug #35).
        const deliveryWindowSeconds = clampDeliveryWindow(
          Number(
            (listing as { delivery_window_seconds?: number }).delivery_window_seconds
              ?? DEFAULT_OTC_DELIVERY_WINDOW_SECONDS,
          ),
        );
        const result = await createEscrowDealOnChain(
          sellerWallet.address,
          checkout.itemAmount,
          deliveryWindowSeconds,
        );
        if (result) {
          // Resolve the REAL contract dealId from the DealCreated event (not the
          // Circle tx id) so release/refund + the reconciliation indexer target
          // the correct uint. Null if not mined in budget (indexer backfills).
          const { dealId: onChainDealId, txHash } = await resolveDealIdFromCircleTx(
            result.id,
            { timeoutMs: 30_000 }
          );
          // bug #35 — the contract sets `deliveryDeadline` at creation, so mirror
          // it here (same anchor) rather than leaving it for proceed. `resolve…`
          // returns after the funding tx mined, so `Date.now()` is >= the block
          // timestamp → the DB deadline is >= the chain's (never early).
          await admin.from("wl_deals")
            .update({
              on_chain_deal_id: onChainDealId,
              on_chain_tx_hash: txHash,
              ...(onChainDealId
                ? { delivery_deadline: new Date(Date.now() + deliveryWindowSeconds * 1000).toISOString() }
                : {}),
            })
            .eq("id", dealId);
        }
      }
    } catch (e) {
      console.error("createEscrowDealOnChain failed (non-fatal):", e);
    }
  }

  return dealId as string;
}

/** Seller proceed: set collateral + lock. WAITING→ESCROW. */
export async function proceedDeal(
  dealId: string,
  sellerId: string,
  collateralMicro: bigint
): Promise<void> {
  const admin = supabaseAdminClient();
  // recompute fees from deal (circle+gas)
  const { data: deal } = await admin
    .from("wl_deals")
    .select("unit, qty, price, status, on_chain_deal_id")
    .eq("id", dealId)
    .maybeSingle();
  if (!deal) throw new Error("deal not found");
  // Idempotent retry: WAITING→ESCROW already happened (e.g. previous proceed
  // transitioned the DB but the response/challenge failed afterwards). Do NOT
  // re-run proceed_wl_deal_atomic (it would double-lock funds and raise
  // "status must be WAITING") and do NOT re-deposit collateral on-chain.
  if (deal.status === "ESCROW") return;
  const checkout = computeEscrowCheckout(BigInt(deal.price as string), deal.qty as number);
  // circle+gas = buyerPaysTotal - price - base
  const circleGas = checkout.circleFee + checkout.gasFee;

  const { error } = await admin.rpc("proceed_wl_deal_atomic", {
    p_deal_id: dealId,
    p_actor_id: sellerId,
    p_circle_fee: circleGas.toString(),
    p_gas_fee: 0n.toString(),
    p_collateral: collateralMicro.toString(),
  });
  if (error) throw new Error(error.message);

  // On-chain: deposit collateral (non-blocking). Only when the on-chain deal was
  // ALREADY created (any non-null id, including "0") — never re-create it here.
  if (isContractReady() && collateralMicro > 0n) {
    try {
      const onChainDealId = deal.on_chain_deal_id as string | null;
      if (hasOnChainDeal(onChainDealId)) {
        await depositEscrowCollateralOnChain(onChainDealId as string, collateralMicro, PLATFORM_WALLET_ID);
        // .D3 — platform-relayed deposit (custodial mode).
        await admin.from("wl_deals")
          .update({ seller_collateral_wallet_type: "platform" })
          .eq("id", dealId);
      }
    } catch (e) {
      console.error("depositEscrowCollateralOnChain failed (non-fatal):", e);
    }
  }
}

/** Staff (Admin/MM) release: ESCROW→COMPLETED. Seller gets full price, collateral back. */
export async function releaseDeal(dealId: string, adminId: string): Promise<void> {
  const admin = supabaseAdminClient();

  // Get on_chain_deal_id + status before any state change
  const { data: dealRow } = await admin.from("wl_deals")
    .select("status, on_chain_deal_id").eq("id", dealId).maybeSingle();

  // NON-CUSTODIAL: FUNDS FIRST. The DB must never flip to COMPLETED
  // before the on-chain release is accepted, otherwise the deal reads settled
  // while the USDC is still locked in MarketEscrow with no recovery path.
  // Also: the custodial RPC credits wallets.usdc_balance, which double-books
  // money the platform does not hold (see migration 0066), so the
  // no-ledger variant is used here.
  if (ONCHAIN_FUNDS_ENABLED) {
    if (!dealRow) throw new Error("deal not found");
    // DISPUTED must be allowed here: a disputed deal still has to be resolvable
    // in the seller's favour once the middleman has arbitrated. The non-custodial
    // RPC below accepts ('ESCROW', 'DISPUTED') and says so in its own comment —
    // but this guard only allowed ESCROW, so an arbitrated release was rejected
    // and a dispute became a permanent dead end for both the admin and the MM.
    if (dealRow.status !== "ESCROW" && dealRow.status !== "DISPUTED") {
      throw new Error(`release: status must be ESCROW or DISPUTED (got ${dealRow.status})`);
    }
    const onChainId = dealRow.on_chain_deal_id as string | null;
    if (!isContractReady()) {
      throw new Error(
        "escrow relay not configured (ESCROW_CONTRACT_ADDRESS / PLATFORM_CIRCLE_WALLET_ID / Circle SDK) — cannot release, refusing to touch the DB",
      );
    }
    if (!onChainId) {
      throw new Error("deal has no on_chain_deal_id — nothing to release on chain (recovery required)");
    }

    // Throws on relay failure → the caller returns 502 and the deal stays ESCROW.
    const result = await releaseEscrowOnChain(onChainId, PLATFORM_WALLET_ID);

    const { error: rpcErr } = await admin.rpc("release_wl_deal_noncustodial", {
      p_deal_id: dealId, p_actor_id: adminId,
    });
    if (rpcErr) {
      // Funds already moved on-chain but the DB did not settle: leave an
      // explicit marker for the reconcile job instead of silently diverging.
      await admin.from("wl_deals").update({
        on_chain_status: "release_pending",
        on_chain_circle_tx_id: result?.id ?? null,
        on_chain_error: `db transition failed after on-chain release: ${rpcErr.message}`,
        on_chain_last_attempt_at: new Date().toISOString(),
      }).eq("id", dealId);
      throw new Error(`on-chain release accepted but DB transition failed: ${rpcErr.message}`);
    }

    await admin.from("wl_deals").update({
      on_chain_status: "release_pending",
      on_chain_circle_tx_id: result?.id ?? null,
      on_chain_last_attempt_at: new Date().toISOString(),
    }).eq("id", dealId);
    await createMmAuditLog({
      mmUserId: adminId, mmWalletId: PLATFORM_WALLET_ID,
      actorType: "user",
      action: "RELEASE_ESCROW", refId: dealId,
      circleTxId: result?.id,
      detail: { onChainDealId: onChainId, type: "escrow-release", mode: "non-custodial" },
    });
    return;
  }

  // Legacy custodial path (ONCHAIN_WALLET_FUNDS != 1): the DB ledger IS the
  // money source, so the ledger RPC runs first and the on-chain call is a
  // best-effort mirror.
  const { error } = await admin.rpc("release_wl_deal_atomic", {
    p_deal_id: dealId, p_actor_id: adminId,
  });
  if (error) throw new Error(error.message);

  // On-chain: release escrow via platform DCW (non-blocking)
  if (isContractReady()) {
    const onChainDealId = dealRow?.on_chain_deal_id as string | null;
    if (onChainDealId) {
      try {
        const result = await releaseEscrowOnChain(onChainDealId, PLATFORM_WALLET_ID);
        // Optimistic marker; indexer sets terminal RELEASED on DealReleased event.
        await admin.from("wl_deals").update({
          on_chain_status: "release_pending",
          on_chain_circle_tx_id: result?.id ?? null,
          on_chain_last_attempt_at: new Date().toISOString(),
        }).eq("id", dealId);
        await createMmAuditLog({
          mmUserId: adminId, mmWalletId: PLATFORM_WALLET_ID,
          actorType: "user",
          action: "RELEASE_ESCROW", refId: dealId,
          circleTxId: result?.id,
          detail: { onChainDealId, type: "escrow-release" },
        });
      } catch (e) {
        const errMsg = (e as Error).message;
        console.error("on-chain releaseEscrow failed:", e);
        await admin.from("wl_deals").update({
          on_chain_status: "release_failed",
          on_chain_error: errMsg,
          on_chain_retry_count: 0,
          on_chain_last_attempt_at: new Date().toISOString(),
        }).eq("id", dealId);
        await createMmAuditLog({
          mmUserId: null, mmWalletId: PLATFORM_WALLET_ID,
          actorType: "platform",
          action: "RELEASE_ESCROW", refId: dealId,
          detail: { type: "on-chain-release-failed", error: errMsg, onChainDealId, triggeredBy: adminId },
        }).catch(() => {});
      }
    } else {
      // No on-chain deal id — still audit the release intent.
      await createMmAuditLog({
        mmUserId: adminId, mmWalletId: PLATFORM_WALLET_ID,
        actorType: "user",
        action: "RELEASE_ESCROW", refId: dealId,
        detail: { onChainDealId: "none" },
      });
    }
  }
}

/** Staff (Admin/MM) refund: ESCROW→CANCELLED. Buyer refund full, collateral back to seller. */
export async function refundDeal(dealId: string, adminId: string): Promise<void> {
  const admin = supabaseAdminClient();

  // Get on_chain_deal_id + status before any state change
  const { data: dealRow } = await admin.from("wl_deals")
    .select("status, on_chain_deal_id").eq("id", dealId).maybeSingle();

  // NON-CUSTODIAL: FUNDS FIRST + no-ledger RPC (see migration 0066
  // and the releaseDeal note above for the full rationale).
  if (ONCHAIN_FUNDS_ENABLED) {
    if (!dealRow) throw new Error("deal not found");
    // Same as releaseDeal: an arbitrated DISPUTED deal must be refundable. The
    // non-custodial RPC accepts ('ESCROW', 'DISPUTED'); this guard did not.
    if (dealRow.status !== "ESCROW" && dealRow.status !== "DISPUTED") {
      throw new Error(`refund: status must be ESCROW or DISPUTED (got ${dealRow.status})`);
    }
    const onChainId = dealRow.on_chain_deal_id as string | null;
    if (!isContractReady()) {
      throw new Error(
        "escrow relay not configured (ESCROW_CONTRACT_ADDRESS / PLATFORM_CIRCLE_WALLET_ID / Circle SDK) — cannot refund, refusing to touch the DB",
      );
    }
    if (!onChainId) {
      throw new Error("deal has no on_chain_deal_id — nothing to refund on chain (recovery required)");
    }

    const result = await refundEscrowOnChain(onChainId, PLATFORM_WALLET_ID);

    const { error: rpcErr } = await admin.rpc("refund_wl_deal_noncustodial", {
      p_deal_id: dealId, p_actor_id: adminId,
    });
    if (rpcErr) {
      await admin.from("wl_deals").update({
        on_chain_status: "refund_pending",
        on_chain_circle_tx_id: result?.id ?? null,
        on_chain_error: `db transition failed after on-chain refund: ${rpcErr.message}`,
        on_chain_last_attempt_at: new Date().toISOString(),
      }).eq("id", dealId);
      throw new Error(`on-chain refund accepted but DB transition failed: ${rpcErr.message}`);
    }

    await admin.from("wl_deals").update({
      on_chain_status: "refund_pending",
      on_chain_circle_tx_id: result?.id ?? null,
      on_chain_last_attempt_at: new Date().toISOString(),
    }).eq("id", dealId);
    await createMmAuditLog({
      mmUserId: adminId, mmWalletId: PLATFORM_WALLET_ID,
      actorType: "user",
      action: "REFUND_ESCROW", refId: dealId,
      circleTxId: result?.id,
      detail: { onChainDealId: onChainId, type: "escrow-refund", mode: "non-custodial" },
    });
    return;
  }

  // Legacy custodial path: ledger RPC first (money source), chain mirror after.
  const { error } = await admin.rpc("refund_wl_deal_atomic", {
    p_deal_id: dealId, p_actor_id: adminId,
  });
  if (error) throw new Error(error.message);

  // On-chain: refund escrow via platform DCW (non-blocking)
  if (isContractReady()) {
    const onChainDealId = dealRow?.on_chain_deal_id as string | null;
    if (onChainDealId) {
      try {
        const result = await refundEscrowOnChain(onChainDealId, PLATFORM_WALLET_ID);
        // Optimistic marker; indexer sets terminal REFUNDED on DealRefunded event.
        await admin.from("wl_deals").update({
          on_chain_status: "refund_pending",
          on_chain_circle_tx_id: result?.id ?? null,
          on_chain_last_attempt_at: new Date().toISOString(),
        }).eq("id", dealId);
        await createMmAuditLog({
          mmUserId: adminId, mmWalletId: PLATFORM_WALLET_ID,
          actorType: "user",
          action: "REFUND_ESCROW", refId: dealId,
          circleTxId: result?.id,
          detail: { onChainDealId, type: "escrow-refund" },
        });
      } catch (e) {
        const errMsg = (e as Error).message;
        console.error("on-chain refundEscrow failed:", e);
        await admin.from("wl_deals").update({
          on_chain_status: "refund_failed",
          on_chain_error: errMsg,
          on_chain_retry_count: 0,
          on_chain_last_attempt_at: new Date().toISOString(),
        }).eq("id", dealId);
        await createMmAuditLog({
          mmUserId: null, mmWalletId: PLATFORM_WALLET_ID,
          actorType: "platform",
          action: "REFUND_ESCROW", refId: dealId,
          detail: { type: "on-chain-release-failed", error: errMsg, onChainDealId, triggeredBy: adminId },
        }).catch(() => {});
      }
    } else {
      // No on-chain deal id — still audit the refund intent.
      await createMmAuditLog({
        mmUserId: adminId, mmWalletId: PLATFORM_WALLET_ID,
        actorType: "user",
        action: "REFUND_ESCROW", refId: dealId,
        detail: { onChainDealId: "none" },
      });
    }
  }
}

/**
 * bookkeeping for the permissionless 7-day escape hatch.
 *
 * `releaseEscrowAfterTimeout` / `refundEscrowAfterTimeout` are callable by
 * ANYONE once ESCROW_TIMEOUT has elapsed (anti-censorship), so the money can
 * already have moved on-chain before this runs. The staff-gated
 * *_wl_deal_noncustodial RPCs cannot be used here (the caller is an ordinary
 * user), hence `settle_wl_deal_after_timeout` — which mirrors the on-chain rule
 * (status must be ESCROW, no role gate) and performs NO ledger movement.
 */
export async function settleDealAfterTimeout(
  dealId: string,
  decision: "release" | "refund",
  actorId: string | null,
): Promise<void> {
  const admin = supabaseAdminClient();

  const { error } = await admin.rpc("settle_wl_deal_after_timeout", {
    p_deal_id: dealId,
    p_decision: decision,
  });
  if (error) throw new Error(error.message);

  await admin.from("wl_deals").update({
    on_chain_status: decision === "release" ? "release_pending" : "refund_pending",
    on_chain_last_attempt_at: new Date().toISOString(),
  }).eq("id", dealId);

  await createMmAuditLog({
    mmUserId: actorId,
    mmWalletId: PLATFORM_WALLET_ID,
    actorType: actorId ? "user" : "system",
    action: decision === "release" ? "RELEASE_ESCROW" : "REFUND_ESCROW",
    refId: dealId,
    detail: { type: "escape-hatch-timeout", decision, actorId },
  }).catch(() => { /* audit is best-effort on the permissionless path */ });
}

// ===========================================================================
// Phase 2 (F5) — Non-custodial WL escrow (Opsi B: pre-approve + relayer pull).
// Active when ONCHAIN_FUNDS_ENABLED=true. Splits WL deal creation + collateral
// into prepare/confirm phases mirroring the marketplace F2-FE checkout.

// Buyer flow (createDeal):
//   1. prepareWlDeal — validate listing + balance gate + draft deal (WAITING)
//   2. UCW challenge — buyer signs approve(escrow, price+baseFee)
//   3. confirmWlDeal — verify approve CONFIRMED → relay createEscrowDealFor
//      with dummy permit → resolve dealId

// Seller flow (proceedDeal):
//   1. UCW challenge — seller signs approve(escrow, collateral)
//   2. proceedWlDealNonCustodial — verify approve CONFIRMED → seller's UCW
//      calls depositEscrowCollateral directly (msg.sender == seller)
// ===========================================================================

export interface PrepareWlDealResult {
  dealDraftId: string;
  itemAmountMicro: string;
  baseFeeMicro: string;
  totalApproveAmountMicro: string; // price + baseFee
  escrowAddress: string;
  usdcAddress: string;
  approveCallData: { signature: string; parameters: string[] };
}

/**
 * Phase 2 (F5) — Prepare a non-custodial WL escrow deal. Validates listing +
 * buyer, gates the buyer's UCW on-chain balance (must cover price+baseFee +
 * gas buffer), inserts a draft deal row (WAITING), returns the approve call
 * data for `USDC.approve(escrow, price+baseFee)`.
 *
 * .D3 — `payerAddress` (EOA permit funding): the balance gate is skipped
 * the buyer's external wallet pays (Arc gas is USDC, so the buyer never
 * needs the platform-native gas token; the platform DCW relays and pays gas).
 *
 * Does NOT touch the buyer's wallet — the actual approve is signed by the
 * buyer via a Circle CONTRACT_EXECUTION challenge in the next step.
 */
export async function prepareWlDeal(
  buyerId: string,
  input: CreateDealInput & { payerAddress?: string },
): Promise<PrepareWlDealResult> {
  if (!ONCHAIN_FUNDS_ENABLED) {
    throw new Error("prepareWlDeal requires ONCHAIN_WALLET_FUNDS=1");
  }
  if (!ESCROW_CONTRACT_ADDRESS) {
    throw new Error("ESCROW_CONTRACT_ADDRESS not configured");
  }

  const admin = supabaseAdminClient();
  const { data: listing, error: lErr } = await admin
    .from("wl_listings")
    .select("unit_price, seller_id")
    .eq("id", input.listingId)
    .maybeSingle();
  if (lErr || !listing) throw new Error("listing not found");

  const qty = Math.max(1, input.qty ?? 1);
  const unitMicro = input.unit != null
    ? BigInt(Math.round(input.unit * 1_000_000))
    : BigInt(listing.unit_price as string);
  const checkout = computeEscrowCheckout(unitMicro, qty);
  // Fee model: buyer approves price + 2% fee (= buyerPaysTotal). Seller receives 100%.
  const totalApproveAmount = checkout.buyerPaysTotal;

  if (input.payerAddress) {
    // .D3 — EOA pays: no UCW balance gate (the external wallet is the
    // funding source). Still require the buyer's session wallet row to exist
    // so confirmWlDeal's seller/buyer lookups don't fail downstream.
    const { data: buyerWallet } = await admin.from("wallets")
      .select("address").eq("user_id", buyerId).maybeSingle();
    if (!buyerWallet?.address) throw new Error("buyer has no on-chain wallet address");
  } else {
    // Look up buyer's wallet + balance gate.
    const { data: buyerWallet } = await admin.from("wallets")
      .select("address").eq("user_id", buyerId).maybeSingle();
    if (!buyerWallet?.address) throw new Error("buyer has no on-chain wallet address");

    const balanceMicro = await getOnChainBalanceMicro(buyerWallet.address);
    if (balanceMicro < totalApproveAmount + APPROVE_GAS_BUFFER_MICRO) {
      throw new Error(
        `insufficient on-chain balance: have ${balanceMicro.toString()} micro, need ${(totalApproveAmount + APPROVE_GAS_BUFFER_MICRO).toString()} micro (price+fee+gas)`,
      );
    }
  }

  const { data: dealId, error: rpcErr } = await admin.rpc("create_wl_deal", {
    p_buyer_id: buyerId,
    p_listing_id: input.listingId,
    p_unit: unitMicro.toString(),
    p_qty: qty,
    p_is_offer: input.isOffer ?? false,
    p_base_fee: checkout.fee.toString(),
  });
  if (rpcErr || !dealId) throw new Error(`create_wl_deal: ${rpcErr?.message}`);

  return {
    dealDraftId: dealId as string,
    itemAmountMicro: checkout.itemAmount.toString(),
    baseFeeMicro: checkout.fee.toString(),
    totalApproveAmountMicro: totalApproveAmount.toString(),
    escrowAddress: ESCROW_CONTRACT_ADDRESS,
    usdcAddress: process.env.CIRCLE_USDC_CONTRACT ?? "",
    approveCallData: {
      signature: "approve(address,uint256)",
      parameters: [ESCROW_CONTRACT_ADDRESS, totalApproveAmount.toString()],
    },
  };
}

export interface ConfirmWlDealInput {
  dealDraftId: string;
  /** On-chain tx hash of the buyer's approve() call (from W3SSdk execute callback). */
  approveTxHash?: string;
  /** Legacy: Circle tx id (deprecated — UCW challenges don't return a tx id). */
  approveTxId?: string;
  /**
   * .D3 — EOA gasless permit path: buyer-signed EIP-2612 permit parts
   * over (owner=payerAddress, spender=escrow, value=price+baseFee). Present →
   * no approve tx is required; the platform DCW relays createEscrowDealFor
   * with these parts and pulls funds from the buyer's EOA.
   */
  permit?: { v: number; r: string; s: string; deadline: string; nonce?: string };
  /** The EOA paying the deal (permit owner / approve sender). 0x + 40 hex. */
  payerAddress?: string;
}

/**
 * Phase 2 (F5) — Confirm a non-custodial WL deal. Verifies the buyer's approve
 * tx reached CONFIRMED, then relays `createEscrowDealFor` via the DCW with a
 * DUMMY permit (v=0, r=0x0, s=0x0). The contract's `_applyPermit` try/catch
 * catches the failed ecrecover and falls back to checking
 * `usdc.allowance(buyer, escrow) >= price+baseFee`.
 *
 * Resolves the contract dealId via `resolveDealIdFromCircleTx` and updates
 * the draft: `on_chain_deal_id`, `on_chain_tx_hash`, `on_chain_status='CREATED'`.
 */
export async function confirmWlDeal(
  buyerId: string,
  input: ConfirmWlDealInput,
): Promise<{ dealId: string; onChainDealId: string | null; onChainTxHash: string | null }> {
  if (!ONCHAIN_FUNDS_ENABLED) {
    throw new Error("confirmWlDeal requires ONCHAIN_WALLET_FUNDS=1");
  }
  if (!isContractReady()) {
    throw new Error("escrow contract not ready");
  }

  const admin = supabaseAdminClient();

  const { data: deal, error: dErr } = await admin.from("wl_deals")
    .select("id, buyer_id, unit, qty, price, on_chain_deal_id")
    .eq("id", input.dealDraftId)
    .maybeSingle();
  if (dErr || !deal) throw new Error("deal draft not found");
  const dealId = deal.id as string;
  const buyerIdFromDeal = deal.buyer_id as string;
  const existingOnChainId = deal.on_chain_deal_id as string | null;

  if (buyerIdFromDeal !== buyerId) throw new Error("not your deal");
  // Idempotency: if the on-chain deal is ALREADY created (any non-null value —
  // including "0", a valid contract deal id), skip re-relaying createEscrowDealFor
  // and return the existing id. Re-creating would mint a duplicate on-chain deal.
  if (hasOnChainDeal(existingOnChainId)) {
    return { dealId, onChainDealId: existingOnChainId, onChainTxHash: null };
  }

  // .D3 — resolve which wallet pays + how to label it (wl_deals columns
  // buyer_payer_address / buyer_payer_wallet_type, migration 0051). Permit
  // present → 'eoa' + payerAddress required; payerAddress only (approve
  // fallback from the EOA) → 'eoa'; neither → 'ucw' (Circle challenge path).
  const { data: buyerWalletRow } = await admin.from("wallets")
    .select("address").eq("user_id", buyerId).maybeSingle();
  // Verify the buyer's approve tx reached CONFIRMED on-chain AND that it was
  // actually SENT by the claimed payer (P0).
  // The FE passes the on-chain txHash from the W3SSdk execute callback.
  // .D3: the EOA PERMIT path (gasless) skips approve verification
  // entirely — the buyer signs EIP-2612 typed data off-chain; no approve tx.
  // Deal amount is needed to VERIFY the permit, so compute it before the proof
  // block (it only depends on the already-loaded deal row).
  const qty = deal.qty as number;
  const unitMicro = BigInt(deal.unit as string);
  const checkout = computeEscrowCheckout(unitMicro, qty);
  // Fee model: buyer pays price + 2% fee (= buyerPaysTotal). Seller receives 100%.
  const totalApproveAmount = checkout.buyerPaysTotal;

  const approveTxHash = input.approveTxHash ?? input.approveTxId;
  let payerProof: "permit" | "approve-tx" | null = null;
  /** — address PROVEN by the permit signature (see below). */
  let permitVerifiedOwner: string | null = null;

  if (input.permit) {
    // Gasless permit path — the signature itself must prove the payer's control.

    // FIX — mirrors confirmCheckoutOrder. This used to set
    // payerProof = "permit" without any recovery, so `resolveConfirmPayer`
    // trusted a client-named `payerAddress`; that address becomes the on-chain
    // buyer of createEscrowDealFor, and a forged permit falls through
    // `_applyPermit` to `allowance(payer, escrow)` — draining a VICTIM's
    // standing allowance into an attacker's deal.
    if (!input.payerAddress) {
      const err = new Error(
        "permit confirm requires payerAddress (the EOA that signed the permit)",
      ) as Error & { httpStatus: number; code: string };
      err.httpStatus = 422;
      err.code = "INVALID_PERMIT";
      throw err;
    }

    let permitInfo: { name: string; version: string; nonce: bigint };
    try {
      permitInfo = await readUsdcPermitInfo(arcPublicClient(), input.payerAddress);
    } catch (e) {
      const err = new Error(
        `permit verification unavailable: ${(e as Error).message}`,
      ) as Error & { httpStatus: number; code: string };
      err.httpStatus = 503;
      err.code = "PERMIT_VERIFY_UNAVAILABLE";
      throw err;
    }

    const verified = await verifyUsdcPermitSignature({
      permit: input.permit,
      expectedOwner: input.payerAddress,
      expectedSpender: ESCROW_CONTRACT_ADDRESS,
      // Server-held amount: a signature made for any other value fails.
      valueMicro: totalApproveAmount,
      chainNonce: permitInfo.nonce,
      tokenName: permitInfo.name,
      tokenVersion: permitInfo.version,
    });

    permitVerifiedOwner = verified.owner;
    payerProof = "permit";
    logger.info(
      { dealId, payerAddress: verified.owner, valueMicro: verified.valueMicro.toString() },
      "confirmWlDeal: EOA permit path — signature VERIFIED",
    );
  } else if (approveTxHash && approveTxHash.startsWith("0x") && approveTxHash.length === 66) {
    try {
      const receipt = await arcPublicClient().waitForTransactionReceipt({
        hash: approveTxHash as Hex,
        timeout: 60_000,
      });
      if (receipt.status !== "success") {
        throw new Error(`approve tx ${approveTxHash} reverted on-chain`);
      }
      // SECURITY: the approve must have been sent BY the claimed
      // payer. Without this check a client could name any address as
      // payerAddress, and the escrow's allowance fallback
      // (`_applyPermit` → allowance(payer, escrow)) would pull a VICTIM's
      // approved USDC into a deal whose on-chain buyer is the victim.
      if (input.payerAddress && receipt.from.toLowerCase() !== input.payerAddress.toLowerCase()) {
        throw new Error(
          `approve tx sender ${receipt.from} does not match payerAddress ${input.payerAddress}`,
        );
      }
      payerProof = "approve-tx";
    } catch (e) {
      throw new Error(`approve tx ${approveTxHash} not confirmed: ${(e as Error).message}`);
    }
  } else if (approveTxHash) {
    logger.warn({ approveTxHash }, "confirmWlDeal: approveTxHash doesn't look like on-chain hash, skipping receipt verification");
  } else {
    logger.warn("confirmWlDeal: no approveTxHash provided, proceeding with createEscrowDealFor relay (will revert if approve missing)");
  }

  // Payer resolution runs AFTER the proof is established: an explicit
  // payerAddress that is not the session's own wallet is only accepted with a
  // permit or a verified approve tx (P0).
  const payer = resolveConfirmPayer({
    userWalletAddress: buyerWalletRow?.address ?? null,
    // on the permit path, use the address the signature PROVED.
    payerAddress: permitVerifiedOwner ?? input.payerAddress,
    permit: input.permit,
    payerProof,
  });

  // Look up seller wallet address (buyer wallet already resolved for payer).
  const { data: listing } = await admin.from("wl_listings")
    .select("seller_id, delivery_window_seconds").eq("id", (await admin.from("wl_deals").select("listing_id").eq("id", dealId).maybeSingle()).data?.listing_id).maybeSingle();
  const { data: sellerWallet } = await admin.from("wallets")
    .select("address").eq("user_id", listing?.seller_id).maybeSingle();
  if (!sellerWallet?.address) throw new Error("seller has no on-chain wallet");

  // (qty / unitMicro / checkout / totalApproveAmount were computed above, before
  // the payer-proof block, because the permit verification needs the total.)

  // .D3 — permit selection (mirrors marketplace confirmCheckoutOrder):
  //   - REAL permit (input.permit): buyer's EIP-2612 signature parts signed
  //     over value = price + baseFee (createEscrowDealFor contract fact).
  //     The DCW relays createEscrowDealFor with these parts; _applyPermit
  //     consumes them and pulls funds from the buyer's EOA — no gas for buyer.
  //   - DUMMY permit (legacy UCW/approve paths): _applyPermit catches the
  //     ecrecover failure and falls back to allowance(buyer, escrow) >= total.
  let relayPermit: PermitSig;
  if (input.permit) {
    relayPermit = {
      deadline: input.permit.deadline,
      v: input.permit.v,
      r: input.permit.r,
      s: input.permit.s,
    };
  } else {
    relayPermit = {
      deadline: String(Math.floor(Date.now() / 1000) + 3600), // 1h
      v: 0,
      r: "0x0000000000000000000000000000000000000000000000000000000000000000",
      s: "0x0000000000000000000000000000000000000000000000000000000000000000",
    };
  }

  // The on-chain BUYER is the resolved payer: the EOA for permit/approve-tx
  // EOA flows, the session UCW address otherwise. createEscrowDealFor pulls
  // funds from THIS address — never the platform DCW.
  const buyerAddress = payer.payerAddress || buyerWalletRow?.address;
  if (!buyerAddress) throw new Error("buyer has no on-chain wallet");

  let onChainDealId: string | null = null;
  let onChainTxHash: string | null = null;
  let createCircleTxId: string | undefined;
  let relaySucceeded = false;

  // The seller's delivery window, clamped the same way the contract will clamp
  // it. Computed up front so we can (a) pass it to the relay and (b) mirror the
  // resulting `deliveryDeadline` into the DB in the SAME write — the contract
  // sets `deliveryDeadline` at FUNDING time, so the DB must anchor there too.
  const deliveryWindowSeconds = clampDeliveryWindow(
    Number(
      (listing as { delivery_window_seconds?: number } | null)?.delivery_window_seconds
        ?? DEFAULT_OTC_DELIVERY_WINDOW_SECONDS,
    ),
  );

  try {
    const result = await createEscrowDealForOnChain({
      buyer: buyerAddress,
      seller: sellerWallet.address,
      priceMicro: checkout.itemAmount,
      deliveryWindowSeconds,
      permit: relayPermit,
    });
    if (!result) throw new Error("createEscrowDealForOnChain returned null");
    createCircleTxId = result.id;
    relaySucceeded = true;

    const resolved = await resolveDealIdFromCircleTx(result.id, { timeoutMs: 30_000 });
    onChainDealId = resolved.dealId;
    onChainTxHash = resolved.txHash;
  } catch (e) {
    // was logged as "non-fatal" and swallowed, so the caller returned
    // success and the UI showed "funds are in escrow" even when nothing moved.
    // We still persist what we have below, then fail honestly after the write.
    logger.error({ dealId, err: (e as Error).message }, "createEscrowDealForOnChain failed");
  }

  // Mirror the contract's `deliveryDeadline` (set at funding) into the DB so the
  // UI deadline and the escape-hatch fallback match the chain. Only when the
  // relay actually succeeded — otherwise there is no on-chain deal to mirror.
  const deliveryDeadlineIso = relaySucceeded
    ? new Date(Date.now() + deliveryWindowSeconds * 1000).toISOString()
    : null;

  await admin.from("wl_deals")
    .update({
      on_chain_deal_id: onChainDealId,
      on_chain_tx_hash: onChainTxHash,
      on_chain_status: onChainDealId ? "CREATED" : (relaySucceeded ? "create_pending" : null),
      // persist the relay's Circle tx id so the on-chain-id resolver can
      // finish the job if the contract id did not resolve in time (otherwise the
      // row is indistinguishable from a deal that never reached the chain).
      on_chain_circle_tx_id: createCircleTxId ?? null,
      // bug #35 — anchor the DB delivery clock at funding, matching the contract.
      ...(deliveryDeadlineIso ? { delivery_deadline: deliveryDeadlineIso } : {}),
      // .D3 — payer logging (migration 0051).
      buyer_payer_address: payer.payerAddress || null,
      buyer_payer_wallet_type: payer.payerWalletType,
    })
    .eq("id", dealId);

  await createMmAuditLog({
    mmUserId: buyerId,
    mmWalletId: PLATFORM_WALLET_ID,
    actorType: "user",
    action: "RELEASE_ESCROW", // closest existing action for deal funding
    refId: dealId,
    circleTxId: createCircleTxId,
    detail: {
      type: input.permit ? "non-custodial-wl-deal-confirm-permit" : "non-custodial-wl-deal-confirm",
      approveTxHash: approveTxHash,
      onChainDealId,
      onChainTxHash,
      totalApproveAmount: totalApproveAmount.toString(),
      buyerAddress,
      sellerAddress: sellerWallet.address,
      payerWalletType: payer.payerWalletType,
      payerAddress: payer.payerAddress || null,
    },
  }).catch(() => {});

  // HONESTY GATE (mirrors the marketplace checkout): if the relay never
  // reached Circle, no USDC moved and the buyer must be told, instead of the UI
  // rendering "funds are in escrow" over an empty deal.
  if (!relaySucceeded) {
    const err = new Error(
      "Deal funding could not be submitted on-chain — no funds were moved. Please try again.",
    ) as Error & { httpStatus: number; code: string };
    err.httpStatus = 502;
    err.code = "PAYMENT_NOT_MOVED";
    throw err;
  }

  // tell the SELLER a deal is funded and waiting for their collateral.
  const sellerUserId = listing?.seller_id as string | undefined;
  if (sellerUserId) {
    await notifyUser(sellerUserId, {
      icon: "shield-check",
      tone: "amber",
      title: "Escrow Deal Funded",
      text: `Deal ${dealId.slice(0, 8)}: the buyer's ${(Number(checkout.itemAmount) / 1_000_000).toFixed(2)} USDC is in escrow. Deposit your collateral to proceed.`,
      link: "escrow",
      email: true,
    }).catch(() => { /* best-effort */ });
  }

  return { dealId, onChainDealId, onChainTxHash };
}

export interface ProceedWlDealNonCustodialInput {
  dealId: string;
  sellerId: string;
  collateralMicro: bigint;
  /** On-chain tx hash of the seller's approve() call (from W3SSdk execute callback). */
  approveTxHash?: string;
  /** Legacy: Circle tx id (deprecated). */
  approveTxId?: string;
}

/**
 * Phase 2 (F5) — Seller proceeds non-custodial: verifies the seller's
 * `approve(escrow, collateral)` tx reached CONFIRMED, then relays
 * `depositEscrowCollateral` via the SELLER'S UCW (not the DCW). The contract
 * requires `msg.sender == d.seller`, so this must be a UCW challenge call,
 * not a DCW relay.
 *
 * Note: `depositEscrowCollateralOnChain` currently uses `callContract` which
 * goes through the DCW SDK — for the seller's UCW, this must go through a
 * Circle UCW CONTRACT_EXECUTION challenge instead. The caller is responsible
 * for issuing that challenge (see `app/api/wl/deals/[id]/collateral-challenge`).
 *
 * This function verifies the approve + updates DB state. The actual on-chain
 * `depositEscrowCollateral` call is issued by the challenge route (the seller's
 * UCW submits it directly via the W3S SDK execute).
 */
export async function proceedWlDealNonCustodial(
  input: ProceedWlDealNonCustodialInput,
): Promise<{ dealId: string; ok: boolean }> {
  if (!ONCHAIN_FUNDS_ENABLED) {
    throw new Error("proceedWlDealNonCustodial requires ONCHAIN_WALLET_FUNDS=1");
  }
  if (!isContractReady()) {
    throw new Error("escrow contract not ready");
  }

  const admin = supabaseAdminClient();
  const { data: deal, error: dErr } = await admin.from("wl_deals")
    .select("id, unit, qty, price, on_chain_deal_id, status, needs_collateral, seller_collateral")
    .eq("id", input.dealId)
    .maybeSingle();
  if (dErr || !deal) throw new Error("deal not found");
  const dealId = deal.id as string;
  const onChainDealId = deal.on_chain_deal_id as string | null;
  // "0" IS a valid created deal id (first contract deal) — only null/empty
  // means "not yet created".
  if (!hasOnChainDeal(onChainDealId)) throw new Error("deal not confirmed on-chain yet");

  // A2 GATE — a collateral-backed deal must not be recorded as protected until
  // the collateral is ACTUALLY locked on-chain.

  // `createEscrowDeal` creates and funds the on-chain deal in one step, so the
  // seller's collateral is always deposited AFTER the buyer's money is already
  // in escrow. That ordering cannot be reversed without a contract change, so
  // instead of trusting the client's claimed collateral we read the real figure
  // from the contract and refuse to advance the deal if it falls short.

  // Net effect: the DB can never claim "buyer funds + collateral locked" while
  // the collateral is missing. The buyer keeps a truthful picture of their
  // exposure, and the seller cannot skip the deposit and still get a protected
  // deal.
  const needsCollateral = deal.needs_collateral === true;
  const agreedMicro = BigInt((deal.seller_collateral as string) ?? "0");
  if (needsCollateral) {
    let onChainCollateral: bigint | null = null;
    try {
      onChainCollateral = await readOnChainDealCollateral(onChainDealId as string);
    } catch (e) {
      throw new Error(`collateral gate: cannot read on-chain collateral (${(e as Error).message})`);
    }
    const gate = evaluateCollateralGate({ needsCollateral, agreedMicro, onChainCollateral });
    if (!gate.ok) throw new Error(gate.reason);
    logger.info(
      { dealId, onChainCollateral: String(onChainCollateral), agreedMicro: String(agreedMicro) },
      "collateral gate passed",
    );
  }

  // Idempotent retry: WAITING→ESCROW already happened (e.g. previous proceed
  // transitioned the DB but the response/challenge step failed afterwards).
  // Do NOT re-run proceed_wl_deal_atomic — it would double-lock buyer funds
  // and raise "status must be WAITING".
  if (deal.status === "ESCROW") return { dealId, ok: true };

  // Verify the seller's approve tx reached CONFIRMED on-chain.
  const approveTxHash = input.approveTxHash ?? input.approveTxId;
  if (approveTxHash && approveTxHash.startsWith("0x") && approveTxHash.length === 66) {
    try {
      const receipt = await arcPublicClient().waitForTransactionReceipt({
        hash: approveTxHash as Hex,
        timeout: 60_000,
      });
      if (receipt.status !== "success") {
        throw new Error(`seller approve tx ${approveTxHash} reverted on-chain`);
      }
    } catch (e) {
      throw new Error(`seller approve tx ${approveTxHash} not confirmed: ${(e as Error).message}`);
    }
  } else if (approveTxHash) {
    logger.warn({ approveTxHash }, "proceedWlDealNonCustodial: approveTxHash doesn't look like on-chain hash, skipping receipt verification");
  } else {
    logger.warn("proceedWlDealNonCustodial: no approveTxHash provided, proceeding (will revert if approve missing)");
  }

  // FIX this is the NON-CUSTODIAL proceed, but it used to call
  // `proceed_wl_deal_atomic` — the CUSTODIAL RPC. That one debits
  // `wallets.usdc_balance` by `price + base_fee` and requires the buyer's
  // INTERNAL ledger balance to cover it (migration 0009). In non-custodial mode
  // the buyer's USDC already left their wallet on-chain at confirm, so the
  // internal balance is ~0 → the RPC raised "insufficient buyer balance" and
  // the deal could never reach ESCROW while the buyer's funds sat locked in
  // MarketEscrow. In the rare case the mirror DID cover it, the buyer was
  // double-debited and never credited back.

  // `proceed_wl_deal_noncustodial` (migration 0066) exists for exactly this
  // transition — it only records the state change, with NO ledger movement —
  // and was referenced nowhere in the codebase.
  const { error } = await admin.rpc("proceed_wl_deal_noncustodial", {
    p_deal_id: dealId,
    p_actor_id: input.sellerId,
    p_collateral: input.collateralMicro.toString(),
  });
  if (error) throw new Error(error.message);

  await createMmAuditLog({
    mmUserId: input.sellerId,
    mmWalletId: PLATFORM_WALLET_ID,
    actorType: "user",
    action: "RELEASE_ESCROW",
    refId: dealId,
    detail: {
      type: "non-custodial-wl-deal-proceed",
      approveTxHash: approveTxHash,
      onChainDealId,
      collateralMicro: input.collateralMicro.toString(),
      note: "seller UCW submits depositEscrowCollateral directly via challenge",
    },
  }).catch(() => {});

  return { dealId, ok: true };
}

// ===========================================================================
// Settlement lifecycle (0071/0072) — the hardened escrow contract drives
// settlement off two clocks plus a dispute flag. These four transitions mirror
// the on-chain functions:

//   markDeliveredDeal   ← markDelivered      (seller, no money movement)
//   flagDisputeDeal     ← flagDispute        (buyer or seller, freezes clocks)
//   confirmDealAsBuyer  ← confirmEscrow      (buyer self-releases)
//   slashDeal           ← refundEscrowWithSlash (Admin/MM, collateral forfeited)

// The buyer/seller-driven ones assume the CLIENT already broadcast the
// transaction (via WalletBridge or their UCW challenge) and the calling route
// verified it on-chain — the same "verify then settle" shape as collateral-eoa.
// Only slashDeal relays from the platform DCW, because it is an Admin/MM action.
// ===========================================================================

/**
 * Seller marks the deal delivered, starting the buyer's confirmation window.
 * No money moves, so this is a plain DB transition (the contract call, if any,
 * was broadcast client-side).
 */
export async function markDeliveredDeal(dealId: string, sellerId: string): Promise<void> {
  const admin = supabaseAdminClient();

  const { data: deal } = await admin.from("wl_deals")
    .select("status, seller_id").eq("id", dealId).maybeSingle();
  if (!deal) throw new Error("deal not found");
  if (deal.seller_id !== sellerId) throw new Error("mark delivered: seller only");
  if (deal.status !== "ESCROW") {
    throw new Error(`mark delivered: status must be ESCROW (got ${deal.status})`);
  }

  const { error } = await admin.rpc("mark_wl_deal_delivered", {
    p_deal_id: dealId, p_actor_id: sellerId,
  });
  if (error) throw new Error(error.message);

  await createMmAuditLog({
    mmUserId: sellerId, mmWalletId: PLATFORM_WALLET_ID,
    actorType: "user",
    action: "WL_DEAL_DELIVERED", refId: dealId,
    detail: { type: "wl-deal-delivered", confirmWindowDays: 7 },
  }).catch(() => {});
}

// ===========================================================================
// D3 — proof of payment for the fiat leg.

// In a fiat OTC deal the money moves buyer→seller OUTSIDE the platform, so the
// only thing that can be recorded is each side's declaration. Two one-way
// stamps, in order:

//   buyer  "I sent the payment"      → markDealPaid
//   seller "I received the payment"  → confirmDealPayment

// `mark_wl_deal_delivered` refuses to run until the second stamp exists on a
// fiat deal, because in OTC the seller's reason for delivering is that the money
// arrived. Ordinary USDC-for-goods deals have no fiat leg and skip all of this.
// ===========================================================================

/** Buyer declares they sent the off-platform payment. Idempotent. */
export async function markDealPaid(dealId: string, buyerId: string): Promise<void> {
  const admin = supabaseAdminClient();

  const { data: deal } = await admin.from("wl_deals")
    .select("status, buyer_id, fiat_leg, payment_marked_at").eq("id", dealId).maybeSingle();
  if (!deal) throw new Error("deal not found");
  if (deal.buyer_id !== buyerId) throw new Error("mark paid: buyer only");
  if (deal.status !== "ESCROW") {
    throw new Error(`mark paid: status must be ESCROW (got ${deal.status})`);
  }

  const { error } = await admin.rpc("mark_wl_deal_paid", {
    p_deal_id: dealId, p_actor_id: buyerId,
  });
  if (error) throw new Error(error.message);

  // Only audit the first declaration — the RPC makes re-clicks a no-op, so
  // logging unconditionally would pad the trail with duplicates.
  if (!deal.payment_marked_at) {
    await createMmAuditLog({
      mmUserId: buyerId, mmWalletId: PLATFORM_WALLET_ID,
      actorType: "user",
      action: "WL_DEAL_PAID", refId: dealId,
      detail: { type: "wl-deal-payment-marked", fiatLeg: deal.fiat_leg === true },
    }).catch(() => {});
  }
}

/** Seller confirms the off-platform payment landed. Requires the buyer's stamp. */
export async function confirmDealPayment(dealId: string, sellerId: string): Promise<void> {
  const admin = supabaseAdminClient();

  const { data: deal } = await admin.from("wl_deals")
    .select("status, seller_id, payment_confirmed_at").eq("id", dealId).maybeSingle();
  if (!deal) throw new Error("deal not found");
  if (deal.seller_id !== sellerId) throw new Error("confirm payment: seller only");
  if (deal.status !== "ESCROW") {
    throw new Error(`confirm payment: status must be ESCROW (got ${deal.status})`);
  }

  const { error } = await admin.rpc("confirm_wl_deal_payment", {
    p_deal_id: dealId, p_actor_id: sellerId,
  });
  if (error) throw new Error(error.message);

  if (!deal.payment_confirmed_at) {
    await createMmAuditLog({
      mmUserId: sellerId, mmWalletId: PLATFORM_WALLET_ID,
      actorType: "user",
      action: "WL_DEAL_PAYMENT_CONFIRMED", refId: dealId,
      detail: { type: "wl-deal-payment-confirmed" },
    }).catch(() => {});
  }
}

/**
 * Either party raises a dispute. Freezes the on-chain escape hatches so the
 * middleman can arbitrate; if the platform never resolves, the contract's
 * DISPUTE_BACKSTOP refunds the buyer after 30 days.
 */
/** Max stored claim text. Long enough for a real explanation, short enough that
 *  a party cannot wedge the arbitrator's UI with a wall of text. */
const MAX_CLAIM_CHARS = 2000;

export interface FlagDisputeOptions {
  /** Why this party is disputing. Free text, shown verbatim in the brief. */
  reason?: string | null;
  /** Supporting evidence. `side` and `at` are stamped server-side, not trusted. */
  evidence?: { note?: unknown; link?: unknown }[] | null;
}

/** Coerce client-supplied evidence into the stored shape. Never trusts `side`/`at`. */
function sanitiseEvidence(
  raw: FlagDisputeOptions["evidence"],
  side: "buyer" | "seller",
  at: string,
): DisputeEvidenceItem[] {
  if (!Array.isArray(raw)) return [];
  const out: DisputeEvidenceItem[] = [];
  for (const item of raw.slice(0, 20)) {
    const note = typeof item?.note === "string" ? item.note.trim().slice(0, MAX_CLAIM_CHARS) : "";
    const link = typeof item?.link === "string" ? item.link.trim().slice(0, 500) : "";
    if (!note && !link) continue;
    // `side` and `at` are assigned here, not taken from the client — otherwise a
    // buyer could file evidence attributed to the seller.
    out.push({ side, note, link: link || null, at });
  }
  return out;
}

/**
 * Rebuild and persist the arbitrator brief for a disputed deal.
 *
 * The brief is FACTS + contract availability only — never a verdict, never AI
 * (see lib/disputes/brief.ts for why). Best-effort: a failure here must not
 * block the dispute itself, since the flag is the on-chain-relevant part.
 */
export async function refreshDisputeBrief(dealId: string): Promise<void> {
  const admin = supabaseAdminClient();
  const { data: d } = await admin.from("wl_deals")
    .select("price, seller_collateral, delivered_at, delivery_deadline, confirm_deadline, disputed_at, on_chain_deal_id, on_chain_status, collateral_slashed, dispute_reason, dispute_evidence")
    .eq("id", dealId).maybeSingle();
  if (!d) return;

  const brief = buildDisputeBrief({
    deal: {
      price: (d.price as string | null) ?? null,
      sellerCollateral: (d.seller_collateral as string | null) ?? null,
      deliveredAt: (d.delivered_at as string | null) ?? null,
      deliveryDeadline: (d.delivery_deadline as string | null) ?? null,
      confirmDeadline: (d.confirm_deadline as string | null) ?? null,
      disputedAt: (d.disputed_at as string | null) ?? null,
      onChainDealId: (d.on_chain_deal_id as string | null) ?? null,
      onChainStatus: (d.on_chain_status as string | null) ?? null,
      collateralSlashed: (d.collateral_slashed as string | null) ?? null,
    },
    reason: (d.dispute_reason as string | null) ?? null,
    evidence: (d.dispute_evidence as DisputeEvidenceItem[] | null) ?? [],
  });

  await admin.from("wl_deals")
    .update({ dispute_brief: brief, dispute_brief_at: new Date().toISOString() })
    .eq("id", dealId);
}

/**
 * Let the OTHER party file their side while the dispute is open.
 *
 * Both parties need to be heard — a brief built from one side only is a brief
 * the arbitrator has to distrust. Appends rather than replaces, and only while
 * the deal is DISPUTED.
 */
export async function appendDisputeEvidence(
  dealId: string,
  actorId: string,
  opts: { reason?: string | null; evidence?: FlagDisputeOptions["evidence"] },
): Promise<void> {
  const admin = supabaseAdminClient();
  const { data: deal } = await admin.from("wl_deals")
    .select("status, buyer_id, seller_id, dispute_evidence").eq("id", dealId).maybeSingle();
  if (!deal) throw new Error("deal not found");
  if (deal.buyer_id !== actorId && deal.seller_id !== actorId) {
    throw new Error("evidence: buyer or seller only");
  }
  if (deal.status !== "DISPUTED") {
    throw new Error(`evidence: status must be DISPUTED (got ${deal.status})`);
  }

  const side: "buyer" | "seller" = deal.buyer_id === actorId ? "buyer" : "seller";
  const incoming = sanitiseEvidence(opts.evidence, side, new Date().toISOString());
  const existing = Array.isArray(deal.dispute_evidence)
    ? (deal.dispute_evidence as DisputeEvidenceItem[])
    : [];

  if (existing.length + incoming.length > 40) {
    throw new Error("evidence: too many entries (max 40)");
  }

  const reason = typeof opts.reason === "string" ? opts.reason.trim().slice(0, MAX_CLAIM_CHARS) : "";
  await admin.from("wl_deals")
    .update({
      dispute_evidence: [...existing, ...incoming],
      ...(reason ? { dispute_reason: reason } : {}),
    })
    .eq("id", dealId);

  await refreshDisputeBrief(dealId);
}

/**
 * Either party raises a dispute. The on-chain `flagDispute` freezes the escape
 * hatches so the middleman can arbitrate without the other side racing to settle.
 *
 * The optional `reason`/`evidence` are NOT decorative: the flag on its own says
 * nothing, and without them the arbitrator reconstructs the case by scrolling
 * chat. See lib/disputes/brief.ts.
 */
export async function flagDisputeDeal(
  dealId: string,
  actorId: string,
  opts: FlagDisputeOptions = {},
): Promise<void> {
  const admin = supabaseAdminClient();

  const { data: deal } = await admin.from("wl_deals")
    .select("status, buyer_id, seller_id").eq("id", dealId).maybeSingle();
  if (!deal) throw new Error("deal not found");
  if (deal.buyer_id !== actorId && deal.seller_id !== actorId) {
    throw new Error("dispute: buyer or seller only");
  }
  if (deal.status !== "ESCROW") {
    throw new Error(`dispute: status must be ESCROW (got ${deal.status})`);
  }

  const { error } = await admin.rpc("flag_wl_deal_dispute", {
    p_deal_id: dealId, p_actor_id: actorId,
  });
  if (error) throw new Error(error.message);

  // Record the claim, then build the brief. Best-effort: the on-chain flag and
  // the status change above are the parts that matter; a failure to file the
  // claim must not make the dispute look like it did not happen.
  const side: "buyer" | "seller" = deal.buyer_id === actorId ? "buyer" : "seller";
  const nowIso = new Date().toISOString();
  const incoming = sanitiseEvidence(opts.evidence, side, nowIso);
  const reason = typeof opts.reason === "string" ? opts.reason.trim().slice(0, MAX_CLAIM_CHARS) : "";

  if (reason || incoming.length) {
    const { error: claimErr } = await admin.from("wl_deals")
      .update({
        ...(reason ? { dispute_reason: reason } : {}),
        ...(incoming.length ? { dispute_evidence: incoming } : {}),
      })
      .eq("id", dealId);
    if (claimErr) {
      // The dispute itself stands (on-chain flag + status are already set); the
      // claim is what failed. Log it rather than throwing and making a
      // successful dispute look like it never happened.
      logger.warn({ dealId, err: claimErr.message }, "dispute claim not persisted");
    }
  }
  await refreshDisputeBrief(dealId).catch(() => { /* brief is an aid, not a gate */ });

  await createMmAuditLog({
    mmUserId: actorId, mmWalletId: PLATFORM_WALLET_ID,
    actorType: "user",
    action: "WL_DEAL_DISPUTED", refId: dealId,
    detail: {
      type: "wl-deal-disputed",
      role: side,
      hasReason: !!reason,
      evidenceCount: incoming.length,
    },
  }).catch(() => {});
}

/**
 * Buyer confirms receipt — settles the deal in the seller's favour. The buyer's
 * own wallet already broadcast `confirmEscrow` on-chain, so this only runs the
 * DB transition; the route is responsible for verifying that transaction.
 */
export async function confirmDealAsBuyer(dealId: string, buyerId: string): Promise<void> {
  const admin = supabaseAdminClient();

  const { data: deal } = await admin.from("wl_deals")
    .select("status, buyer_id").eq("id", dealId).maybeSingle();
  if (!deal) throw new Error("deal not found");
  if (deal.buyer_id !== buyerId) throw new Error("confirm: buyer only");
  if (deal.status !== "ESCROW") {
    throw new Error(`confirm: status must be ESCROW (got ${deal.status})`);
  }

  const { error } = await admin.rpc("release_wl_deal_noncustodial", {
    p_deal_id: dealId, p_actor_id: buyerId,
  });
  if (error) throw new Error(error.message);
}

/**
 * Admin/MM rules FRAUD: refunds the buyer AND forfeits the seller's collateral
 * to them as compensation. This is what gives the collateral meaning.
 *
 * FUNDS FIRST — the on-chain `refundEscrowWithSlash` is relayed before the DB
 * flips to CANCELLED, so the row can never read settled while the USDC is still
 * locked in MarketEscrow.
 */
export async function slashDeal(dealId: string, adminId: string): Promise<void> {
  const admin = supabaseAdminClient();

  const { data: dealRow } = await admin.from("wl_deals")
    .select("status, on_chain_deal_id, seller_collateral").eq("id", dealId).maybeSingle();
  if (!dealRow) throw new Error("deal not found");
  if (dealRow.status !== "ESCROW" && dealRow.status !== "DISPUTED") {
    throw new Error(`slash: status must be ESCROW or DISPUTED (got ${dealRow.status})`);
  }

  if (ONCHAIN_FUNDS_ENABLED) {
    const onChainId = dealRow.on_chain_deal_id as string | null;
    if (!isContractReady()) {
      throw new Error(
        "escrow relay not configured — cannot slash, refusing to touch the DB",
      );
    }
    if (!onChainId) {
      throw new Error("deal has no on_chain_deal_id — nothing to slash on chain");
    }

    // Throws on relay failure → the deal stays ESCROW/DISPUTED, nothing lost.
    const result = await refundEscrowWithSlashOnChain(onChainId, PLATFORM_WALLET_ID);

    const { error: rpcErr } = await admin.rpc("slash_wl_deal_noncustodial", {
      p_deal_id: dealId, p_actor_id: adminId,
    });
    if (rpcErr) {
      await admin.from("wl_deals").update({
        on_chain_status: "slash_pending",
        on_chain_circle_tx_id: result?.id ?? null,
        on_chain_error: `db transition failed after on-chain slash: ${rpcErr.message}`,
        on_chain_last_attempt_at: new Date().toISOString(),
      }).eq("id", dealId);
      throw new Error(`on-chain slash accepted but DB transition failed: ${rpcErr.message}`);
    }

    await admin.from("wl_deals").update({
      on_chain_status: "slash_pending",
      on_chain_circle_tx_id: result?.id ?? null,
      on_chain_last_attempt_at: new Date().toISOString(),
    }).eq("id", dealId);

    await createMmAuditLog({
      mmUserId: adminId, mmWalletId: PLATFORM_WALLET_ID,
      actorType: "user",
      action: "SLASH_COLLATERAL", refId: dealId,
      circleTxId: result?.id,
      detail: {
        type: "escrow-slash-fraud",
        onChainDealId: onChainId,
        collateralSlashedMicro: String(dealRow.seller_collateral ?? 0),
        mode: "non-custodial",
      },
    });
    return;
  }

  // Custodial mode has no on-chain leg; record the forfeiture only.
  const { error } = await admin.rpc("slash_wl_deal_noncustodial", {
    p_deal_id: dealId, p_actor_id: adminId,
  });
  if (error) throw new Error(error.message);
}
