import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import type { CurrentUser } from "@/lib/auth-ucw";
import { computeMarketplaceCheckout } from "@/lib/fee";
import { getOrder } from "./queries";
import {
  createOrderOnChain,
  createOrderForOnChain,
  isContractReady,
  MARKETPLACE_DELIVERY_WINDOW_SECONDS,
  type PermitSig,
} from "@/lib/contracts/escrow-client";
import { resolveOrderIdFromCircleTx } from "@/lib/contracts/resolver";
import {
  readUsdcPermitInfo,
  resolveConfirmPayer,
  resolvePrepareGateTarget,
  verifyUsdcPermitSignature,
} from "./permit-checkout";
import { arcPublicClient } from "@/lib/arc";
import {
  getOnChainBalanceMicro,
  ONCHAIN_FUNDS_ENABLED,
  shouldBypassOnChainBalanceGate,
} from "@/lib/wallet/onchain-funding";
import { ARC_USDC_CONTRACT } from "@/lib/arc";
import { createMmAuditLog } from "@/lib/mm";
import { notifyUser } from "@/lib/notif";
import { orderNewTemplate } from "@/lib/notif/templates";
import { sendOrderInvoice } from "./invoice";
import { logger } from "@/lib/logger";
import {
  bestEffortPersist,
  recordLifecycleEvent,
  validateDraftForConfirm,
  type DraftRow,
} from "./patterns";
import type { Hex } from "viem";

const ESCROW_CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS ?? "";
const PLATFORM_WALLET_ID = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";

/** Buffer for the buyer's approve gas (Arc native USDC, ~$0.01 typical). */
const APPROVE_GAS_BUFFER_MICRO = 50_000n; // 0.05 USDC

export interface CheckoutInput {
  productId: string;
  variantLabel?: string;
  qty?: number;
  payment?: string;
  idempotencyKey?: string | null;
  /**
   * .F-fix — the EOA paying this checkout (external wallet path). When
   * present, prepare's on-chain balance gate targets THIS address on Arc
   * instead of the buyer's session UCW (mirrors prepareWlDeal).
   */
  payerAddress?: string;
}

/**
 * Validate product + buyer state. Shared by both the legacy checkoutOrder and
 * the new prepareCheckoutOrder. Throws on any disqualifying condition.
 */
async function validateCheckout(user: CurrentUser, productId: string) {
  const admin = supabaseAdminClient();
  const { data: prod, error: pErr } = await admin
    .from("products")
    .select("id, store_id, name, price, variants, delivery, frozen")
    .eq("id", productId)
    .maybeSingle();
  if (pErr || !prod) throw new Error("product not found");

  // Defense in depth — getCurrentUser already rejects banned users.
  if (user.banned) throw new Error("account is banned");
  if ((prod as { frozen?: boolean }).frozen) throw new Error("product is frozen");

  const { data: storeRow } = await admin
    .from("stores")
    .select("frozen, owner_user_id")
    .eq("id", prod.store_id)
    .maybeSingle();
  if (storeRow?.frozen) throw new Error("store is frozen");

  return { prod, storeOwnerUserId: storeRow?.owner_user_id as string | undefined };
}

/**
 * Resolve the per-unit price (micro-USDC) for a product, optionally picking the
 * variant's price if `variantLabel` matches one in the product's `variants`
 * jsonb. Falls back to the product base price when no variant matches or no
 * variants are defined.
 */
function resolveVariantPrice(
  prod: { price: string | number; variants?: unknown },
  variantLabel?: string,
): bigint {
  const base = BigInt(prod.price as string);
  if (!variantLabel || variantLabel === "Default") return base;
  const variants = prod.variants as { label: string; price: number | string }[] | null;
  if (Array.isArray(variants)) {
    const variant = variants.find(v => v.label === variantLabel);
    if (variant) return BigInt(variant.price.toString());
  }
  return base;
}

/**
 * LEGACY custodial checkout. Used when `ONCHAIN_WALLET_FUNDS` is OFF (DB ledger
 * is the source of truth for spendable balance). Computes fees, calls
 * `create_order_atomic`. Instant: status SENT. Manual: PENDING.
 * If contract is deployed, also records escrow on-chain via createOrder()
 * (funded by the Platform DCW — NOT the buyer's UCW).
 */
export async function checkoutOrder(user: CurrentUser, input: CheckoutInput) {
  const admin = supabaseAdminClient();

  // (BUG 13) — REFUSE the legacy custodial rail in non-custodial mode.

  // This path creates `payment='Balance'` orders and funds escrow from the Platform
  // DCW. In non-custodial mode that is doubly wrong:
  //   1. The buyer's USDC lives in THEIR wallet; nothing was debited, yet the
  //      order is created (and, for instant delivery, flipped to SENT with
  //      credentials attached) as if it had been PAID.
  //   2. If the escrow relay then fails, the row ends up `SENT` + `Balance` +
  //      no on-chain id — a state draft-cleanup will NOT sweep, because
  //      `isStuckInstantDraft` requires `payment === "Onchain"`. The order sticks
  //      forever and `confirmOrder` correctly 409s with ONCHAIN_ID_UNRESOLVED,
  //      leaving no way out. Two orders were wedged exactly this way.

  // The supported rail in non-custodial mode is the two-phase
  // prepare → challenge → confirm flow. Callers must use that.
  if (ONCHAIN_FUNDS_ENABLED) {
    const e = new Error(
      "custodial checkout is disabled while ONCHAIN_WALLET_FUNDS=1 — " +
        "use /api/orders/checkout/prepare → /challenge → /confirm instead.",
    ) as Error & { httpStatus: number; code: string };
    e.httpStatus = 409;
    e.code = "CUSTODIAL_RAIL_DISABLED";
    throw e;
  }

  const qty = Math.max(1, input.qty ?? 1);
  const { prod } = await validateCheckout(user, input.productId);

  // Resolve per-unit price from the chosen variant (fallback to base price).
  const unitPrice = resolveVariantPrice(prod as unknown as { price: string | number; variants?: unknown }, input.variantLabel);

  const checkout = computeMarketplaceCheckout(
    unitPrice,
    qty,
    prod.delivery as "instant" | "manual",
  );

  // Default terms, PERSISTED onto the order row (`orders.terms text[]`) and
  // rendered verbatim by the client — there is no translation layer here, so
  // these must be English. They were Indonesian, which meant every non-Indonesian
  // locale saw Indonesian text in the "Terms & Conditions" block of the order
  // page. (Rows created before this change keep their original Indonesian
  // strings: `terms` is stored data, not UI chrome.)
  const terms = prod.delivery === "instant"
    ? ["Access is delivered instantly from the seller's stock (FIFO)", "No refund once the credentials have been viewed"]
    : ["The seller is preparing your order", "Confirmation within 48 hours"];

  const { data: oid, error: rpcErr } = await admin.rpc("create_order_atomic", {
    p_buyer_id: user.id,
    p_store_id: prod.store_id,
    p_product_id: prod.id,
    p_variant: input.variantLabel ?? "Default",
    p_qty: qty,
    p_buyer_fee: checkout.buyerAdminFee.toString(), // buyer-side 2% service fee
    p_gas_fee: checkout.gasFee.toString(), // legacy, always 0
    p_payment: input.payment ?? "Balance",
    p_delivery: prod.delivery,
    p_terms: terms,
    p_credentials: {},
    p_instant: prod.delivery === "instant",
  });
  if (rpcErr || !oid) throw new Error(`checkout RPC failed: ${rpcErr?.message}`);

  if (input.idempotencyKey) {
    await admin.from("orders").update({ idempotency_key: input.idempotencyKey }).eq("id", oid);
  }

  // On-chain: record escrow in contract via Platform DCW (non-blocking).
  if (isContractReady()) {
    try {
      const { data: store } = await admin.from("stores").select("owner_user_id").eq("id", prod.store_id).maybeSingle();
      const { data: sellerWallet } = await admin.from("wallets").select("address").eq("user_id", store?.owner_user_id).maybeSingle();

      if (sellerWallet?.address) {
        const onChainResult = await createOrderOnChain(
          sellerWallet.address,
          checkout.itemAmount,
          MARKETPLACE_DELIVERY_WINDOW_SECONDS,
        );
        if (onChainResult) {
          const { orderId, txHash } = await resolveOrderIdFromCircleTx(onChainResult.id, {
            timeoutMs: 30_000,
          });
          await admin.from("orders")
            .update({
              on_chain_order_id: orderId,
              on_chain_tx_hash: txHash,
              on_chain_status: "CREATED",
            })
            .eq("id", oid);
        }
      }
    } catch (e) {
      logger.error({ orderId: oid, err: (e as Error).message }, "legacy createOrderOnChain failed (non-fatal)");
    }
  }

  return await getOrder(oid as string);
}

// ===========================================================================
// Phase 3.4 — Non-custodial checkout (Opsi B: pre-approve + relayer pull).
// Active when ONCHAIN_FUNDS_ENABLED=true. Splits checkout into two phases:
//   1. prepareCheckoutOrder — validate + gate balance + create draft (PENDING).
//   2. confirmCheckoutOrder — verify approve tx + relay createOrderFor via DCW
//      with a dummy permit (v=0, r=0, s=0); _applyPermit falls back to the
//      allowance the buyer set via a Circle CONTRACT_EXECUTION challenge.
// ===========================================================================

export interface PrepareCheckoutResult {
  /** DB order id (the draft). Buyer references this when confirming. */
  orderDraftId: string;
  /** USDC micro amount for the item (basis for seller payout). */
  itemAmountMicro: string;
  /** USDC micro buyer admin fee (2%, covers platform gas). */
  buyerAdminFeeMicro: string;
  /** USDC micro total the buyer must approve (item + fee). */
  buyerPaysTotalMicro: string;
  /** Escrow contract address (the spender the buyer will approve). */
  escrowAddress: string;
  /** USDC token contract address (target of the approve call). */
  usdcAddress: string;
  /** ABI-encoded approve(escrowAddress, buyerPaysTotal) call data (for FE display). */
  approveCallData: { signature: string; parameters: string[] };
}

/**
 * Phase 3.4 — Prepare a non-custodial checkout. Validates product + buyer,
 * gates the PAYING wallet's on-chain balance (must cover itemAmount + gas
 * buffer), inserts a draft order row (status PENDING), returns the approve
 * call data.
 *
 * .F-fix — `input.payerAddress` (EOA external wallet): the balance gate
 * targets THAT address on Arc instead of the buyer's session UCW (mirrors
 * prepareWlDeal), so EOA checkout is no longer blocked by the UCW gate.
 *
 * Does NOT touch the buyer's wallet — the actual approve is signed by the buyer
 * via a Circle CONTRACT_EXECUTION challenge in the next step (see
 * `lib/ucw/contract-execution-challenge.ts`).
 *
 * Idempotency: if `idempotencyKey` is provided and an existing draft matches,
 * returns that draft instead of creating a new one.
 */
export async function prepareCheckoutOrder(
  user: CurrentUser,
  input: CheckoutInput,
): Promise<PrepareCheckoutResult> {
  if (!ONCHAIN_FUNDS_ENABLED) {
    throw new Error("prepareCheckoutOrder requires ONCHAIN_WALLET_FUNDS=1");
  }
  if (!ESCROW_CONTRACT_ADDRESS) {
    throw new Error("ESCROW_CONTRACT_ADDRESS not configured");
  }

  // .F-fix — decide which address the balance gate targets BEFORE any
  // wallet requirement: payerAddress (EOA external wallet) wins over the
  // session UCW; no address at all → typed 400.
  const gateTarget = resolvePrepareGateTarget({
    payerAddress: input.payerAddress,
    ucwAddress: user.walletAddress,
  });

  const admin = supabaseAdminClient();
  const qty = Math.max(1, input.qty ?? 1);
  const { prod } = await validateCheckout(user, input.productId);

  // Resolve per-unit price from the chosen variant (fallback to base price).
  const unitPrice = resolveVariantPrice(prod as unknown as { price: string | number; variants?: unknown }, input.variantLabel);

  const checkout = computeMarketplaceCheckout(
    unitPrice,
    qty,
    prod.delivery as "instant" | "manual",
  );

  // On-chain balance gate: the paying wallet must hold at least buyerPaysTotal
  // + gas buffer for the approve tx. This prevents a dangling approve that the
  // createOrderFor relayer can't later pull (insufficient funds).

  // .F-fix: the gate targets the resolved payer — the client-provided EOA
  // when the buyer pays from an external wallet, otherwise the buyer's UCW.
  // Mock/dev sessions bypass the read (synthetic wallets hold no real USDC on
  // Arc; a live RPC read of a fake payer would wrongly block dev checkout).
  if (!shouldBypassOnChainBalanceGate()) {
    const balanceMicro = await getOnChainBalanceMicro(gateTarget.address);
    if (balanceMicro < checkout.buyerPaysTotal + APPROVE_GAS_BUFFER_MICRO) {
      throw new Error(
        `insufficient on-chain balance: have ${balanceMicro.toString()} micro, need ${(checkout.buyerPaysTotal + APPROVE_GAS_BUFFER_MICRO).toString()} micro (item + fee + gas buffer)`,
      );
    }
  } else {
    logger.info(
      { orderProductId: input.productId, gateTarget: gateTarget.address, kind: gateTarget.kind },
      "prepareCheckoutOrder: balance gate bypassed (mock/dev mode)",
    );
  }

  // Idempotency: return existing draft if same key was used.
  if (input.idempotencyKey) {
    const { data: existing } = await admin.from("orders")
      .select("id").eq("idempotency_key", input.idempotencyKey).maybeSingle();
    if (existing) {
      const existingOrder = await getOrder(existing.id as string);
      if (existingOrder) {
        return {
          orderDraftId: existingOrder.id,
          itemAmountMicro: checkout.itemAmount.toString(),
          buyerAdminFeeMicro: checkout.buyerAdminFee.toString(),
          buyerPaysTotalMicro: checkout.buyerPaysTotal.toString(),
          escrowAddress: ESCROW_CONTRACT_ADDRESS,
          usdcAddress: ARC_USDC_CONTRACT,
          approveCallData: {
            signature: "approve(address,uint256)",
            parameters: [ESCROW_CONTRACT_ADDRESS, checkout.buyerPaysTotal.toString()],
          },
        };
      }
      // Existing row but getOrder returned null (rare RLS race) — fall through
      // to create a new draft.
    }
  }

  // Default terms, PERSISTED onto the order row (`orders.terms text[]`) and
  // rendered verbatim by the client — there is no translation layer here, so
  // these must be English. They were Indonesian, which meant every non-Indonesian
  // locale saw Indonesian text in the "Terms & Conditions" block of the order
  // page. (Rows created before this change keep their original Indonesian
  // strings: `terms` is stored data, not UI chrome.)
  const terms = prod.delivery === "instant"
    ? ["Access is delivered instantly from the seller's stock (FIFO)", "No refund once the credentials have been viewed"]
    : ["The seller is preparing your order", "Confirmation within 48 hours"];

  // Insert the draft order via the NON-CUSTODIAL RPC (0032, updated by 0034).
  // 0034 added instant-delivery support (FIFO stock pop + status=SENT). This
  // skips the legacy DB balance check + ledger debit — the on-chain approve +
  // createOrderFor is the real money movement (relayed in confirmCheckoutOrder).
  // DB order row tracks state only.
  const { data: oid, error: rpcErr } = await admin.rpc("create_non_custodial_order", {
    p_buyer_id: user.id,
    p_store_id: prod.store_id,
    p_product_id: prod.id,
    p_variant: input.variantLabel ?? "Default",
    p_qty: qty,
    p_payment: input.payment ?? "Onchain",
    p_delivery: prod.delivery,
    p_terms: terms,
    p_buyer_fee: checkout.buyerAdminFee.toString(),
  });
  if (rpcErr || !oid) throw new Error(`prepare RPC failed: ${rpcErr?.message}`);

  if (input.idempotencyKey) {
    await admin.from("orders").update({ idempotency_key: input.idempotencyKey }).eq("id", oid);
  }

  // (c) lifecycle event for the draft creation — best-effort, never fails
  // checkout (a missing row just degrades the timeline, not the money path).
  await recordLifecycleEvent(
    admin as unknown as Parameters<typeof recordLifecycleEvent>[0],
    {
      orderId: oid as string,
      operation: "CREATED",
      txHash: null,
      amountMicro: checkout.itemAmount + checkout.buyerAdminFee,
      note: "checkout-transition:PREPARED non-custodial draft",
    },
    { productId: input.productId, qty },
  );

  return {
    orderDraftId: oid as string,
    itemAmountMicro: checkout.itemAmount.toString(),
    buyerAdminFeeMicro: checkout.buyerAdminFee.toString(),
    buyerPaysTotalMicro: checkout.buyerPaysTotal.toString(),
    escrowAddress: ESCROW_CONTRACT_ADDRESS,
    usdcAddress: ARC_USDC_CONTRACT,
    approveCallData: {
      signature: "approve(address,uint256)",
      parameters: [ESCROW_CONTRACT_ADDRESS, checkout.buyerPaysTotal.toString()],
    },
  };
}

export interface ConfirmCheckoutInput {
  orderDraftId: string;
  /** On-chain tx hash of the buyer's approve() call (from W3SSdk execute callback). */
  approveTxHash?: string;
  /** Legacy: Circle tx id (deprecated — UCW challenges don't return a tx id). */
  approveTxId?: string;
  /**
   * OPTIONAL client-echoed item amount (micro-USDC). Anti-tamper: if provided
   * it must EXACTLY equal the server-held draft amount (else 422). The relay
   * always uses the server value regardless.
   */
  clientAmountMicro?: string;
  /**
   * .D — EOA gasless permit path: the buyer's EIP-2612 signature parts
   * over (owner=payerAddress, spender=escrow, value=itemAmount+buyerFee,
   * nonce, deadline). When present, the relay passes these REAL values to
   * createOrderFor instead of the dummy permit (no approve tx needed).
   */
  permit?: { v: number; r: string; s: string; deadline: string; nonce?: string };
  /** The EOA paying this order (permit owner / approve sender). 0x + 40 hex. */
  payerAddress?: string;
}

/**
 * Phase 3.4 — Confirm a non-custodial checkout. Verifies the buyer's approve
 * tx reached CONFIRMED on-chain, then relays `createOrderFor` via the DCW
 * with a DUMMY permit (v=0, r=0x0, s=0x0). The contract's `_applyPermit`
 * try/catch catches the failed ecrecover (dummy sig can't validate) and
 * falls back to checking `usdc.allowance(buyer, escrow) >= itemAmount` —
 * which the buyer's approve tx just set.
 *
 * Resolves the contract orderId via `resolveOrderIdFromCircleTx` and updates
 * the draft: `on_chain_order_id`, `on_chain_tx_hash`, `on_chain_status='CREATED'`.
 *
 * Safety:
 *   - Verifies approve tx CONFIRMED before relaying (no relay on a dangling approve).
 *   - Verifies on-chain allowance >= itemAmount after CONFIRMED (defense in depth).
 *   - Non-fatal on-chain failure: DB ledger is the source of truth STATE; the
 *     reconciliation indexer + dangling-allowance sweep (Phase 5) backstop.
 *   - Audit row written with circleTxId for traceability.
 */
/**
 * the single source of truth for "did the buyer actually pay?".
 *
 * Pure so it can be unit-tested without DB/Circle mocks, and used by
 * `confirmCheckoutOrder` so the three outcomes can never drift apart:
 *
 *  - `failed`    — the relay never reached Circle: NO funds moved. The caller
 *                  must fail the request (502 PAYMENT_NOT_MOVED) so the UI can
 *                  never render a false "Payment successful".
 *  - `pending`   — the relay was accepted but the contract order id is not yet
 *                  resolvable. Funds MAY be moving; report as processing, never
 *                  as success. The indexer reconciles.
 *  - `confirmed` — the contract order id is known: the order provably exists
 *                  on-chain.
 */
export type CheckoutOutcome = "failed" | "pending" | "confirmed";

export function resolveCheckoutOutcome(
  relaySucceeded: boolean,
  onChainOrderId: string | null,
): CheckoutOutcome {
  if (!relaySucceeded) return "failed";
  return onChainOrderId ? "confirmed" : "pending";
}

export async function confirmCheckoutOrder(
  user: CurrentUser,
  input: ConfirmCheckoutInput,
): Promise<{
  orderId: string;
  onChainOrderId: string | null;
  onChainTxHash: string | null;
  degraded?: boolean;
  /**
   * true when the relay reached Circle (so funds may be moving) but the
   * contract order id could not be resolved yet. The payment is NOT confirmed;
   * the caller must present this as "processing", never as success.
   */
  paymentPending?: boolean;
}> {
  if (!ONCHAIN_FUNDS_ENABLED) {
    throw new Error("confirmCheckoutOrder requires ONCHAIN_WALLET_FUNDS=1");
  }
  if (!isContractReady()) {
    throw new Error("escrow contract not ready");
  }

  const admin = supabaseAdminClient();

  // (e) Anti-tamper: re-load the SERVER-held draft and re-validate ownership,
  // status, and amounts. Client-echoed values are never trusted — the relay
  // below uses only these server values.
  const { data: order, error: oErr } = await admin.from("orders")
    .select("id, buyer_id, store_id, amount, buyer_fee, status, on_chain_order_id, delivery, product_id, variant, qty, payment")
    .eq("id", input.orderDraftId)
    .maybeSingle();
  if (oErr || !order) throw new Error("order draft not found");

  // Throws with typed httpStatus: 403 not-owner, 409 wrong status, 422 bad
  // amount / client-echo mismatch (validateDraftForConfirm, pattern e).
  const validation = validateDraftForConfirm({
    draft: order as unknown as DraftRow,
    userId: user.id,
    clientAmountMicro: input.clientAmountMicro,
  });

  const orderId = order.id as string;
  const storeId = order.store_id as string;
  const itemAmountMicro = validation.itemAmountMicro;
  const buyerFeeMicro = validation.buyerFeeMicro;

  // .D — payer resolution (orders columns payer_address /
  // payer_wallet_type, migration 0050). : it now happens AFTER the
  // approve-tx proof below, because an explicit payerAddress that is not the
  // session wallet is only trusted with a permit or an approve tx actually sent
  // by that address (see the note in resolveConfirmPayer).

  if ((order.on_chain_order_id as string | null)) {
    // Already confirmed — idempotent return.
    return {
      orderId,
      onChainOrderId: order.on_chain_order_id as string,
      onChainTxHash: null,
    };
  }

  // B2 — Pop stock at CONFIRM, not prepare. Instant drafts were inserted
  // PENDING by create_non_custodial_order (0048); the actual stock pop +
  // SENT + credentials attachment happens NOW, after the draft has passed
  // validation, so no stock is consumed before payment. Reuses the 0044 RPC
  // auto_advance_instant_order (exact pop+SENT+credentials+auto-soldout
  // semantics, keyed by order id). Raises 'insufficient stock' on shortage —
  // the route maps that to a clean 400 and no money moves.
  if (order.delivery === "instant") {
    const { data: storeOwner } = await admin.from("stores")
      .select("owner_user_id").eq("id", storeId).maybeSingle();
    const ownerId = storeOwner?.owner_user_id as string | undefined;
    if (!ownerId) throw new Error("store owner not found");

    const { data: advanceRes, error: advanceErr } = await admin.rpc("auto_advance_instant_order", {
      p_order_id: orderId,
      p_actor_id: ownerId,
    });
    if (advanceErr) {
      // Clean 400 for the route (typed → httpStatus mapping in route.ts).
      const err = new Error(`instant fulfillment failed: ${advanceErr.message}`) as Error & { httpStatus?: number };
      err.httpStatus = 400;
      throw err;
    }
    logger.info({ orderId, advanceRes }, "checkout-confirm: instant draft advanced (stock popped at confirm)");
  }

  // Verify the buyer's approve tx reached CONFIRMED on-chain. The FE passes
  // the on-chain txHash from the W3SSdk execute callback (UCW challenges don't
  // return a Circle tx id in the response — only the challengeId, which is
  // consumed by the browser SDK).

  // .D: the EOA PERMIT path (gasless) skips approve verification entirely
  // the buyer signs EIP-2612 typed data off-chain; there is no approve tx.
  // The real permit (v,r,s,deadline) is passed straight to createOrderFor.
  const approveTxHash = input.approveTxHash ?? input.approveTxId;
  let payerProof: "permit" | "approve-tx" | null = null;
  /**
   * the address PROVEN to have signed the permit. The payer is
   * taken from here (not from the client's `payerAddress` claim) whenever the
   * permit path is used.
   */
  let permitVerifiedOwner: string | null = null;

  if (input.permit) {
    // Gasless permit path — no approve tx exists or is required. The permit
    // itself authorizes the escrow to pull itemAmount + buyerFee.

    // FIX — this used to set payerProof = "permit" with NO recovery
    // at all, so `resolveConfirmPayer` trusted any client-named `payerAddress`.
    // That address becomes the on-chain `buyer` of createOrderFor; a forged
    // permit fails `_applyPermit`'s ecrecover and the contract falls back to
    // `allowance(payer, escrow)`, pulling a VICTIM's approved USDC into an
    // attacker's order. We now reconstruct the exact signed message (every
    // field is server-known or server-read) and recover the signer.
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
      // RPC unavailable → 503 so the FE can fall back to the approve path
      // instead of being told the permit was invalid.
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
      // Server-held amount — a signature made for any other value fails.
      valueMicro: itemAmountMicro + buyerFeeMicro,
      chainNonce: permitInfo.nonce,
      tokenName: permitInfo.name,
      tokenVersion: permitInfo.version,
    });

    permitVerifiedOwner = verified.owner;
    payerProof = "permit";
    logger.info(
      { orderId, payerAddress: verified.owner, valueMicro: verified.valueMicro.toString() },
      "confirmCheckoutOrder: EOA permit path — signature VERIFIED",
    );
  } else if (approveTxHash && approveTxHash.startsWith("0x") && approveTxHash.length === 66) {
    // Looks like an on-chain tx hash (0x + 64 hex chars). Verify via Arc RPC.
    try {
      const receipt = await arcPublicClient().waitForTransactionReceipt({
        hash: approveTxHash as Hex,
        timeout: 60_000,
      });
      if (receipt.status !== "success") {
        throw new Error(`approve tx ${approveTxHash} reverted on-chain`);
      }
      // SECURITY: the approve must have been SENT by the claimed
      // payer. Otherwise a client could name any address as payerAddress and
      // the escrow's allowance fallback (`_applyPermit` → allowance(payer,
      // escrow)) would pull a VICTIM's approved USDC into an order whose
      // on-chain buyer is the victim.
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
    // Fallback: assume it's a Circle tx id (legacy path). Skip verification —
    // the createOrderFor relay will fail if the approve didn't actually happen.
    logger.warn({ approveTxHash }, "confirmCheckoutOrder: approveTxHash doesn't look like on-chain hash, skipping receipt verification");
  } else {
    // No txHash provided — proceed anyway. The createOrderFor relay will
    // revert if the approve didn't actually happen (allowance check fails).
    // This is a safety net for when the W3S callback doesn't return a txHash.
    logger.warn("confirmCheckoutOrder: no approveTxHash provided, proceeding with createOrderFor relay (will revert if approve missing)");
  }

  // payer resolution happens here, once the proof is known.
  const payer = resolveConfirmPayer({
    userWalletAddress: user.walletAddress,
    // on the permit path, use the address the signature actually
    // PROVED, never the client's unverified claim.
    payerAddress: permitVerifiedOwner ?? input.payerAddress,
    permit: input.permit,
    payerProof,
  });

  // Fetch seller wallet address for createOrderFor.
  const { data: store } = await admin.from("stores")
    .select("owner_user_id").eq("id", storeId).maybeSingle();
  const sellerId = store?.owner_user_id as string | undefined;
  const { data: sellerWallet } = await admin.from("wallets")
    .select("address").eq("user_id", sellerId).maybeSingle();
  if (!sellerWallet?.address) throw new Error("seller has no on-chain wallet");

  // .D — permit selection:
  //   - REAL permit (input.permit): buyer's EIP-2612 signature parts signed
  //     over value = itemAmount + buyerFee (createOrderFor contract fact).
  //     The DCW relays createOrderFor with these parts; _applyPermit consumes
  //     them and pulls funds from the buyer's EOA — buyer pays NO gas.
  //   - DUMMY permit (legacy UCW/approve paths): _applyPermit catches the
  //     ecrecover failure and falls back to checking
  //     allowance(buyer, escrow) >= total, which the buyer's approve tx set.
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
  // EOA flows, the session UCW address otherwise. createOrderFor pulls funds
  // from THIS address — never the platform DCW.
  const buyerAddress = payer.payerAddress || user.walletAddress!;
  let onChainOrderId: string | null = null;
  let onChainTxHash: string | null = null;
  let createCircleTxId: string | undefined;
  let relaySucceeded = false;

  try {
    const result = await createOrderForOnChain({
      buyer: buyerAddress,
      seller: sellerWallet.address,
      amountMicro: itemAmountMicro,
      deliveryWindowSeconds: MARKETPLACE_DELIVERY_WINDOW_SECONDS,
      permit: relayPermit,
    });
    if (!result) throw new Error("createOrderForOnChain returned null");
    createCircleTxId = result.id;
    relaySucceeded = true;

    // Resolve the REAL contract orderId (numeric, from OrderCreated event).
    const resolved = await resolveOrderIdFromCircleTx(result.id, { timeoutMs: 60_000 });
    onChainOrderId = resolved.orderId;
    onChainTxHash = resolved.txHash;
  } catch (e) {
    // the relay failed. Previously this was swallowed as "non-fatal"
    // and the route still returned 200, so the UI told the buyer "Payment
    // successful!" while no funds had moved. That is the worst possible failure
    // for a payment flow: the buyer believes they paid and stops trying.
    // We keep the DB authoritative and let the restock/rollback below run, then
    // fail the request honestly.
    logger.error({ orderId, err: (e as Error).message }, "createOrderForOnChain failed");
  }

  // B2 — Relay-failure rollback for instant orders. If the relay never even
  // started (no Circle tx id), no funds moved on-chain: undo the stock pop so
  // the seller's credentials are not held hostage, and return the order to
  // PENDING (a retryable draft the buyer can confirm again). If the relay DID
  // start (relaySucceeded) but resolving the on-chain id failed, leave it
  // SENT — the reconciliation indexer is the backstop (funds may have moved).
  if (order.delivery === "instant" && !relaySucceeded) {
    const { error: restockErr } = await admin.rpc("restock_instant_order", {
      p_order_id: orderId,
      p_target_status: "PENDING",
    });
    if (restockErr) {
      logger.error({ orderId, err: restockErr.message }, "restock after failed relay failed — stuck-draft sweep will recover");
    } else {
      logger.info({ orderId }, "checkout-confirm: relay failed, instant stock restocked, order back to PENDING");
    }
  }

  // HONESTY GATE. If the relay never reached Circle, no USDC moved and
  // the buyer must be told so. Throwing here makes the route return a non-2xx,
  // which is what stops the UI from rendering a false "Payment successful".
  // For instant orders the stock pop was already undone above, so the buyer can
  // simply retry.
  const outcome = resolveCheckoutOutcome(relaySucceeded, onChainOrderId);
  if (outcome === "failed") {
    const err = new Error(
      "Payment could not be submitted on-chain — no funds were moved. Please try again.",
    ) as Error & { httpStatus: number; code: string };
    err.httpStatus = 502;
    err.code = "PAYMENT_NOT_MOVED";
    throw err;
  }

  // (c) lifecycle event BEFORE the orders row update (arc ordering: realtime
  // UI must not race ahead of the data). Best-effort — never fails checkout.
  await recordLifecycleEvent(
    admin as unknown as Parameters<typeof recordLifecycleEvent>[0],
    {
      orderId,
      operation: onChainOrderId ? "CAPTURED" : "AUTHORIZED",
      txHash: onChainTxHash,
      amountMicro: itemAmountMicro + buyerFeeMicro,
      note: onChainOrderId
        ? `checkout-transition:ORDER_CREATED onChainOrderId=${onChainOrderId}`
        : "checkout-transition:CONFIRMED approve-only (on-chain id unresolved)",
    },
    { onChainOrderId, createCircleTxId },
  );

  // (a) Best-effort persistence: the relay has already run (funds path moved
  // or failed on-chain) — a DB mirror failure must NOT surface as a checkout
  // failure. Return success with a `degraded: true` hint instead.
  const persist = await bestEffortPersist(
    "confirm:update-draft-onchain-ids",
    async () => {
      const { error } = await admin.from("orders")
        .update({
          on_chain_order_id: onChainOrderId,
          on_chain_tx_hash: onChainTxHash,
          on_chain_status: onChainOrderId ? "CREATED" : "create_pending",
          // persist Circle's tx id for the relay. Without it a row whose
          // contract id failed to resolve is indistinguishable from an abandoned
          // draft, and the stuck-draft sweep would cancel + restock it while the
          // buyer's USDC sits in escrow. This column is what lets the on-chain-id
          // resolver (lib/reconcile/onchain-ids.ts) finish the job later.
          on_chain_circle_tx_id: createCircleTxId ?? null,
          // .D — payer attribution (migration 0050 columns).
          payer_address: payer.payerAddress || null,
          payer_wallet_type: payer.payerWalletType,
        })
        .eq("id", orderId);
      if (error) throw new Error(error.message);
    },
    { logger, context: { orderId, onChainOrderId, relaySucceeded, payerWalletType: payer.payerWalletType } },
  );

  // Audit log — always written, with the createOrderFor Circle tx id.
  await createMmAuditLog({
    mmUserId: user.id,
    mmWalletId: PLATFORM_WALLET_ID,
    actorType: "user",
    action: "RELEASE_ORDER", // closest existing action; this is the funding step
    refId: orderId,
    circleTxId: createCircleTxId,
    detail: {
      type: input.permit ? "non-custodial-checkout-confirm-permit" : "non-custodial-checkout-confirm",
      approveTxHash: approveTxHash,
      onChainOrderId,
      onChainTxHash,
      itemAmountMicro: itemAmountMicro.toString(),
      buyerAddress,
      sellerAddress: sellerWallet.address,
      payerAddress: payer.payerAddress || null,
      payerWalletType: payer.payerWalletType,
      degraded: persist.degraded,
    },
  }).catch(() => {});

  // the relay started but the contract order id is unresolved, so we
  // cannot yet prove the order exists on-chain. Report it as PENDING, not as a
  // completed payment; the reconciliation indexer resolves the id afterwards.
  const paymentPending = outcome === "pending";

  // tell the SELLER. Until now nothing in the checkout path notified
  // them, so a new order arrived in complete silence and only showed up if they
  // happened to open the dashboard. Best-effort: never fail a completed payment
  // on a notification.
  if (sellerId) {
    const itemUsdc = (Number(itemAmountMicro) / 1_000_000).toFixed(2);

    // Fetch product name for the email template
    const { data: product } = order.product_id
      ? await admin.from("products").select("name").eq("id", order.product_id as string).maybeSingle()
      : { data: null };

    const template = orderNewTemplate({
      orderId,
      itemName: (product?.name as string) || "Order item",
      itemVariant: (order.variant as string) || null,
      qty: Number(order.qty || 1),
      amountUsdc: itemUsdc,
      buyerName: user.name || "A buyer",
      paymentMethod: String(order.payment || "USDC"),
      status: paymentPending ? "Confirming on-chain" : "Paid into escrow",
      appUrl: process.env.NEXT_PUBLIC_APP_URL || "https://slimemarket.app",
    });
    await notifyUser(sellerId, {
      icon: "package",
      tone: "emerald",
      title: "New Order",
      text: paymentPending
        ? `Order ${orderId.slice(0, 8)} for ${itemUsdc} USDC was submitted and is confirming on-chain.`
        : `Order ${orderId.slice(0, 8)} for ${itemUsdc} USDC was paid into escrow. Prepare the item.`,
      link: "seller",
      email: template,
    }).catch(() => { /* best-effort */ });
  }

  // Invoice to the BUYER. An escrow marketplace asks a stranger to send real
  // USDC to a contract; the emailed invoice is their durable record of what they
  // bought, what they paid and which transaction carried it. Best-effort for the
  // same reason as the notification above: never fail a completed payment on it.
  await sendOrderInvoice(orderId).catch(() => { /* best-effort */ });

  if (persist.degraded) {
    return { orderId, onChainOrderId, onChainTxHash, degraded: true, paymentPending };
  }
  return { orderId, onChainOrderId, onChainTxHash, paymentPending };
}
