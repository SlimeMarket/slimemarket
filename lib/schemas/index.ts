import { z } from "zod";

/**
 * Shared Zod schemas + parse helpers for API route input validation.
 *
 * Why: pre-Phase 1.3 every route did ad-hoc `String()` / `typeof` casts that
 * feed directly into DB queries and on-chain calls. This lets a malicious
 * client pass malformed UUIDs, negative amounts, or non-hex addresses into
 * functions that trust the caller. zod schemas centralize the validators so a
 * single source of truth defines the shape of every money-moving endpoint.
 *
 * Usage:
 *   const parsed = CheckoutBody.safeParse(body);
 *   if (!parsed.success) return validationError(parsed.error);
 *   const { productId, qty, ... } = parsed.data;
 */

/**
 * NOTE (Zod v4): Optional fields MUST use `.optional()` or `.default(undefined)` instead of `z.null()`.
 * Zod v4 does NOT accept null values for optional types — use `.optional()` which implicitly allows undefined.
 * When serializing JSON for API calls, prefer `?.field ?? undefined` pattern to avoid sending null.
 */

// ---- Primitives -------------------------------------------------------------

/** UUID v4 (Supabase row ids). */
export const UuidSchema = z.string().uuid();

/** 0x-prefixed 40-hex-char EVM address (case-insensitive). */
export const ArcAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 40-hex address");

/** Decimal USDC string (e.g. "1.50", "0.01"). Must parse via parseUsdc to micro. */
export const UsdcAmountSchema = z.string()
  .regex(/^\d+(\.\d+)?$/, "must be a decimal string like '1.50'")
  .refine((s) => parseFloat(s) > 0, "must be > 0");

/**
 * Decimal USDC string that may be "0" (e.g. WL deals with needsCollateral=false,
 * where the FE sends { collateralUsdc: "0" }). Checkout/withdraw amounts stay
 * on UsdcAmountSchema (> 0) — only routes that legitimately accept zero use this.
 */
export const UsdcAmountOrZeroSchema = z.string()
  .regex(/^\d+(\.\d+)?$/, "must be a decimal string like '1.50'")
  .refine((s) => parseFloat(s) >= 0, "must be >= 0");

/** Positive integer qty. */
export const QtySchema = z.number().int().positive().max(1_000_000);

// ---- Body schemas -----------------------------------------------------------

export const CheckoutBodySchema = z.object({
  productId: UuidSchema,
  variantLabel: z.string().min(1).max(200).optional(),
  qty: QtySchema.optional(),
  payment: z.enum(["Balance", "Onchain"]).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});
export type CheckoutBody = z.infer<typeof CheckoutBodySchema>;

export const WithdrawBodySchema = z.object({
  amountUsdc: UsdcAmountSchema,
  // Exactly one of { bankAccountId, destAddress } must be set (checked at use).
  bankAccountId: z.string().min(1).max(200).optional(),
  destAddress: ArcAddressSchema.optional(),
}).refine(
  (b) => !!b.bankAccountId !== !!b.destAddress,
  "exactly one of bankAccountId or destAddress must be set",
);
export type WithdrawBody = z.infer<typeof WithdrawBodySchema>;

// ---- Cross-chain (CCTP) bridge ---------------------------------------------
// `sourceChain` is deliberately NOT a zod enum: the valid set depends on the
// active network (testnet vs mainnet) and is owned by lib/cctp/chains.ts. The
// route validates it with `cctpSourceChain()` and returns a 400 listing the
// chains it actually supports, which is more useful than a static enum that
// would drift the moment the chain table changes.
export const CrossChainPrepareSchema = z.object({
  action: z.literal("prepare"),
  sourceChain: z.string().min(1).max(40),
  amountUsdc: UsdcAmountSchema,
});
export type CrossChainPrepare = z.infer<typeof CrossChainPrepareSchema>;

/**
 * Confirming one step of the two-transaction flow.
 *
 * `txHash` is shape-checked here and then verified against the source chain —
 * the browser is not trusted to report progress (see lib/cctp/burn.ts).
 */
export const CrossChainConfirmSchema = z.object({
  action: z.literal("confirm"),
  bridgeId: UuidSchema,
  step: z.enum(["approve", "burn"]),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be a 32-byte hex hash"),
});
export type CrossChainConfirm = z.infer<typeof CrossChainConfirmSchema>;

/**
 * Re-attempt the Arc mint for a bridge that is already burned.
 *
 * Only needs the id: everything else (amount, recipient, message) is fixed in
 * Circle's signed attestation, so there is nothing for the client to supply and
 * nothing it could tamper with.
 */
export const CrossChainRetrySchema = z.object({
  action: z.literal("retry"),
  bridgeId: UuidSchema,
});
export type CrossChainRetry = z.infer<typeof CrossChainRetrySchema>;

export const CrossChainBodySchema = z.discriminatedUnion("action", [
  CrossChainPrepareSchema,
  CrossChainConfirmSchema,
  CrossChainRetrySchema,
]);
export type CrossChainBody = z.infer<typeof CrossChainBodySchema>;

export const TopupBodySchema = z.object({
  method: z.enum(["qris", "card", "bank"]),
  fiatAmount: z.number().positive().finite().max(1_000_000),
  currency: z.string().min(3).max(3),
});
export type TopupBody = z.infer<typeof TopupBodySchema>;

export const EarningsWithdrawBodySchema = z.object({
  amountUsdc: UsdcAmountSchema,
  destAddress: ArcAddressSchema,
});
export type EarningsWithdrawBody = z.infer<typeof EarningsWithdrawBodySchema>;

export const CreateWlDealBodySchema = z.object({
  listingId: UuidSchema,
  unit: z.number().positive().finite().max(1_000_000).optional(), // decimal USDC
  qty: QtySchema.optional(),
  isOffer: z.boolean().optional(),
});
export type CreateWlDealBody = z.infer<typeof CreateWlDealBodySchema>;

// ---- Non-custodial checkout (Phase 3.5) ------------------------------------

export const CheckoutPrepareBodySchema = z.object({
  productId: UuidSchema,
  variantLabel: z.string().min(1).max(200).optional(),
  qty: QtySchema.optional(),
  payment: z.enum(["Balance", "Onchain"]).optional(),
  // .F-fix — EOA external-wallet checkout: the external wallet paying the
  // order. When present, the prepare on-chain balance gate targets THIS address
  // on Arc instead of the buyer's session UCW (mirrors WlDealPrepareBodySchema).
  payerAddress: ArcAddressSchema.optional(),
});
export type CheckoutPrepareBody = z.infer<typeof CheckoutPrepareBodySchema>;

export const CheckoutChallengeBodySchema = z.object({
  orderDraftId: UuidSchema,
});
export type CheckoutChallengeBody = z.infer<typeof CheckoutChallengeBodySchema>;

export const CheckoutConfirmBodySchema = z.object({
  orderDraftId: UuidSchema,
  approveTxHash: z.string().min(1).max(200).optional(),
  approveTxId: z.string().min(1).max(200).optional(),
  // .D — EOA permit path (gasless): buyer-signed EIP-2612 permit parts.
  // Additive/optional — the approve-tx fallback path stays untouched.
  permit: z.object({
    v: z.number().int().min(27).max(28),
    r: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "r must be 0x + 64 hex (bytes32)"),
    s: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "s must be 0x + 64 hex (bytes32)"),
    deadline: z.string().regex(/^\d+$/, "deadline must be a decimal-seconds string"),
    nonce: z.string().regex(/^\d+$/).optional(),
  }).optional(),
  /** The EOA that pays (permit owner / approve sender). 0x + 40 hex. */
  payerAddress: ArcAddressSchema.optional(),
});
export type CheckoutConfirmBody = z.infer<typeof CheckoutConfirmBodySchema>;

/** .D — permit-payload request: { orderDraftId, payerAddress }. */
export const CheckoutPermitPayloadBodySchema = z.object({
  orderDraftId: UuidSchema,
  payerAddress: ArcAddressSchema,
});
export type CheckoutPermitPayloadBody = z.infer<typeof CheckoutPermitPayloadBodySchema>;

// ---- F5 WL non-custodial deal (Phase 2) ------------------------------------

export const WlDealPrepareBodySchema = z.object({
  listingId: UuidSchema,
  unit: z.number().positive().finite().max(1_000_000).optional(),
  qty: QtySchema.optional(),
  isOffer: z.boolean().optional(),
  // .D3 — EOA permit funding: the external wallet paying the deal. When
  // present, the buyer's UCW on-chain balance gate is skipped (the EOA pays,
  // and Arc gas is USDC — the buyer needs no native gas token).
  payerAddress: ArcAddressSchema.optional(),
});
export type WlDealPrepareBody = z.infer<typeof WlDealPrepareBodySchema>;

export const WlDealChallengeBodySchema = z.object({
  dealDraftId: UuidSchema,
});
export type WlDealChallengeBody = z.infer<typeof WlDealChallengeBodySchema>;

export const WlDealConfirmBodySchema = z.object({
  dealDraftId: UuidSchema,
  approveTxHash: z.string().min(1).max(200).optional(),
  approveTxId: z.string().min(1).max(200).optional(),
  // .D3 — EOA permit path (gasless): buyer-signed EIP-2612 permit parts.
  // Additive/optional — the approve-tx fallback path stays untouched.
  permit: z.object({
    v: z.number().int().min(27).max(28),
    r: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "r must be 0x + 64 hex (bytes32)"),
    s: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "s must be 0x + 64 hex (bytes32)"),
    deadline: z.string().regex(/^\d+$/, "deadline must be a decimal-seconds string"),
    nonce: z.string().regex(/^\d+$/).optional(),
  }).optional(),
  /** The EOA that pays (permit owner / approve sender). 0x + 40 hex. */
  payerAddress: ArcAddressSchema.optional(),
});
export type WlDealConfirmBody = z.infer<typeof WlDealConfirmBodySchema>;

/** .D3 — WL deal permit-payload request: { payerAddress } (deal id in URL). */
export const WlDealPermitPayloadBodySchema = z.object({
  payerAddress: ArcAddressSchema,
});
export type WlDealPermitPayloadBody = z.infer<typeof WlDealPermitPayloadBodySchema>;

/** .D3 — seller EOA collateral deposit record: { depositTxHash, collateralUsdc }. */
export const WlDealCollateralEoaBodySchema = z.object({
  depositTxHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "depositTxHash must be 0x + 64 hex"),
  collateralUsdc: UsdcAmountOrZeroSchema,
  /** The seller's EOA that sent approve+deposit (audited; verified server-side). */
  sellerAddress: ArcAddressSchema.optional(),
});
export type WlDealCollateralEoaBody = z.infer<typeof WlDealCollateralEoaBodySchema>;

/**
 * Shared body for the single-arg escrow lifecycle routes — the client already
 * broadcast `markDelivered` / `confirmEscrow` / `flagDispute` from the party's
 * own wallet, and the route verifies that tx on Arc before settling the DB.
 */
export const WlDealActionBodySchema = z.object({
  // Either an on-chain hash (external-wallet rail) or a Circle transaction id
  // (UCW rail — a CONTRACT_EXECUTION settles with `data: null`, so there is no
  // hash on the client). verifyDealActionTx resolves the Circle id to the real
  // hash before touching Arc.
  txHash: z.string().min(10).refine(
    (v) => /^0x[0-9a-fA-F]{64}$/.test(v) || /^[0-9a-fA-F-]{36}$/.test(v),
    "txHash must be 0x + 64 hex, or a Circle transaction id",
  ),
});
export type WlDealActionBody = z.infer<typeof WlDealActionBodySchema>;

/**
 * POST /api/wl/deals/[id]/dispute — WlDealActionBody plus the claimant's own
 * account of the dispute.
 *
 * The on-chain `flagDispute` carries no information: it freezes settlement and
 * nothing more. Without a reason and evidence the arbitrator reconstructs the
 * case by scrolling chat, which is the cost this field exists to remove.
 *
 * Both are OPTIONAL on purpose — a dispute must never be blocked by a form
 * (the money is already frozen either way), but supplying them is what makes
 * arbitration cheap. `side` and `at` are stamped server-side, never accepted
 * from the client.
 */
export const WlDisputeBodySchema = WlDealActionBodySchema.extend({
  reason: z.string().trim().max(2000).optional(),
  evidence: z
    .array(
      z.object({
        note: z.string().trim().max(2000).optional(),
        link: z.string().trim().max(500).optional(),
      }),
    )
    .max(20)
    .optional(),
});
export type WlDisputeBody = z.infer<typeof WlDisputeBodySchema>;

/**
 * POST /api/wl/deals/[id]/dispute-evidence — the OTHER party files their side
 * while the dispute is open. Same shape, no txHash: nothing goes on-chain here.
 */
export const WlDisputeEvidenceBodySchema = z.object({
  reason: z.string().trim().max(2000).optional(),
  evidence: WlDisputeBodySchema.shape.evidence,
});
export type WlDisputeEvidenceBody = z.infer<typeof WlDisputeEvidenceBodySchema>;

/**
 * Body for POST /api/wl/deals/[id]/action-challenge — asks the server to build
 * the Circle CONTRACT_EXECUTION challenge for a deal action the caller performs
 * on-chain. Mirrors the `WL_ACTION_SELECTOR` map in public/app.jsx, which is the
 * external-EOA rail for the same three contract calls.
 */
export const WlDealActionChallengeBodySchema = z.object({
  action: z.enum(["markDelivered", "confirmEscrow", "flagDispute"]),
});
export type WlDealActionChallengeBody = z.infer<typeof WlDealActionChallengeBodySchema>;

export const WlCollateralChallengeBodySchema = z.object({
  // "0" allowed: deals with needsCollateral=false send zero and the route
  // skips the challenge entirely (no approval needed).
  collateralUsdc: UsdcAmountOrZeroSchema,
});
export type WlCollateralChallengeBody = z.infer<typeof WlCollateralChallengeBodySchema>;

/**
 * Body for POST /api/wl/deals/[id]/collateral-confirm — the client reports the
 * Circle challenge it signed for `depositEscrowCollateral`. The server resolves
 * the challenge to the real on-chain tx, verifies it, and records
 * `seller_collateral_tx_hash` so the deposit is provable.
 */
export const WlDealCollateralConfirmBodySchema = z.object({
  depositChallengeId: z.string().min(10),
});
export type WlDealCollateralConfirmBody = z.infer<typeof WlDealCollateralConfirmBodySchema>;

export const WlCollateralProceedBodySchema = z.object({
  approveTxHash: z.string().min(1).max(200).optional(),
  approveTxId: z.string().min(1).max(200).optional(),
  // "0" allowed: zero-collateral deals proceed without any Circle deposit
  // challenge (mirrors lib/wl/transitions.ts proceedDeal's collateralMicro > 0n
  // guard before the on-chain deposit).
  collateralUsdc: UsdcAmountOrZeroSchema,
});
export type WlCollateralProceedBody = z.infer<typeof WlCollateralProceedBodySchema>;

// ---- Admin schemas ----------------------------------------------------------

export const TreasuryWithdrawBodySchema = z.object({
  recipientUserId: UuidSchema.optional(),
  amountUsdc: UsdcAmountSchema,
  memo: z.string().min(1).max(500).optional(),
  sourceAccount: z.enum(["platform_fee", "gas_pool"]).optional(),
  // Optional UCW wallet address for direct platform earnings withdrawal.
  // If provided, transfer directly to this Arc address (0x...) instead of bank fallback.
  // Enables admin to withdraw platform earnings to external UCW wallets.
  targetWalletAddress: ArcAddressSchema.optional(),
});
export type TreasuryWithdrawBody = z.infer<typeof TreasuryWithdrawBodySchema>;

export const TreasuryAirdropBodySchema = z.object({
  recipients: z.array(z.object({
    userId: UuidSchema,
    amountUsdc: UsdcAmountSchema,
  })).min(1).max(20),
  memo: z.string().min(1).max(500),
});
export type TreasuryAirdropBody = z.infer<typeof TreasuryAirdropBodySchema>;

// ---- Helper -----------------------------------------------------------------

/**
 * Validate a request body against a zod schema. Returns either the parsed
 * value (typed) or a Next.js Response with 400 + flattened error details.
 *
 * Usage:
 *   const parsed = parseBody(CheckoutBodySchema, body);
 *   if (parsed instanceof Response) return parsed;
 *   const data = parsed;  // typed
 */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T | Response {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  // Flatten errors into { field: [messages] } for a consistent API surface.
  const flat = result.error.flatten();
  return new Response(
    JSON.stringify({
      error: "validation_error",
      details: flat.fieldErrors,
      formErrors: flat.formErrors,
    }),
    { status: 400, headers: { "content-type": "application/json" } },
  );
}

/** True if the given value is a Response (returned by parseBody on failure). */
export function isParseFailure(v: unknown): v is Response {
  return v instanceof Response;
}
