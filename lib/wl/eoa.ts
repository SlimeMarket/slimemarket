import { isAddress, toFunctionSelector } from "viem";
import {
  buildEoaPermitPayload,
  PERMIT_PAYLOAD_TTL_SECONDS,
  type PermitPayload,
} from "@/lib/order/permit-checkout";

/**
 * .D3 — EOA external-wallet support for WL escrow deals.
 *
 * Reuses the .D1 permit primitives (lib/order/permit-checkout.ts):
 * the Arc USDC EIP-712 domain, 30-min TTL, and signature layout are identical
 * for marketplace orders and WL deals — only the permit `value` differs
 * (createEscrowDealFor pulls price + baseFee; MarketEscrow.sol L176-196).
 *
 * Contract facts (contracts/MarketEscrow.sol):
 *   - `createEscrowDealFor(buyer, seller, price, baseFee, deadline, v, r, s)`
 *     is onlyOperator; pulls `price + baseFee` from `buyer` via
 *     `_applyPermit` + safeTransferFrom. Buyer pays NO gas (platform relays).
 *   - `depositEscrowCollateral(dealId, amount)` requires `msg.sender ==
 *     d.seller` and pulls `amount` from msg.sender via safeTransferFrom.
 *     An EOA seller calls it from their own wallet (msg.sender check passes),
 *     paying gas in USDC themselves — after approving the escrow.
 */

/** depositEscrowCollateral(uint256,uint256) selector (4-byte). */
export const WL_DEAL_DEPOSIT_SELECTOR = "0x25f043d8";

/**
 * Build the EIP-2612 permit payload for EOA deal funding. Pure — the nonce
 * is read server-side from Arc (readUsdcPermitInfo). Value = price + baseFee
 * exactly (bigint math, micro-USDC).
 */
export function buildWlDealPermitPayload(params: {
  owner: string;
  spender: string;
  priceMicro: bigint;
  baseFeeMicro: bigint;
  nonce: bigint;
  tokenName?: string;
  tokenVersion?: string;
  nowSeconds?: number;
  ttlSeconds?: number;
}): PermitPayload {
  if (params.priceMicro <= 0n) throw new Error("deal price must be positive");
  // the fee is the contract's computeFee(price) = 2%, which can be
  // legitimately 0 for dust prices (below 50 micro-USDC). The old `<= 0n` guard
  // existed to catch callers passing the deprecated always-0 `baseFee`; those
  // callers now pass the real fee, so reject only negatives.
  if (params.baseFeeMicro < 0n) throw new Error("deal fee must not be negative");
  return buildEoaPermitPayload({
    owner: params.owner,
    spender: params.spender,
    valueMicro: params.priceMicro + params.baseFeeMicro,
    nonce: params.nonce,
    tokenName: params.tokenName,
    tokenVersion: params.tokenVersion,
    nowSeconds: params.nowSeconds,
    ttlSeconds: params.ttlSeconds ?? PERMIT_PAYLOAD_TTL_SECONDS,
  });
}

// ---------------------------------------------------------------------------
// Seller EOA collateral deposit verification
// ---------------------------------------------------------------------------

export interface DepositTxFields {
  /** tx.to — must be the escrow contract. */
  to: string;
  /** Receipt status — must be 'success'. */
  status: string;
  /** tx.from (msg.sender) — the contract requires this == deal seller. */
  sender: string;
  /** Raw tx calldata. */
  input: string;
}

export interface DepositValidationExpectation {
  escrowAddress: string;
  /** The seller address recorded as d.seller on-chain (lowercase compare). */
  sellerAddress: string;
  /** The deal's on_chain_deal_id (decimal string; "0" is valid). */
  onChainDealId: string;
  /** Server-held collateral the seller is depositing (micro-USDC). */
  collateralMicro: bigint;
}

/**
 * Strictly validate an on-chain tx claiming to be the seller's
 * `depositEscrowCollateral(dealId, amount)` call. Throws a descriptive error
 * naming the first failed check (route maps to 400); returns true when every
 * check passes. Checks (all case-insensitive on addresses):
 *   1. receipt status === 'success'
 *   2. tx.to == escrow contract
 *   3. tx.from == the deal's on-chain seller (contract: msg.sender == d.seller)
 *   4. calldata selector == depositEscrowCollateral(uint256,uint256)
 *   5. arg[0] (dealId) == the deal's on_chain_deal_id
 *   6. arg[1] (amount) == the server-held collateral amount
 */
export function validateDepositCollateralTx(
  tx: DepositTxFields,
  expected: DepositValidationExpectation,
): boolean {
  if (tx.status !== "success") {
    throw new Error(`deposit tx status must be 'success' (got '${tx.status}')`);
  }
  const to = (tx.to ?? "").toLowerCase();
  if (to !== expected.escrowAddress.toLowerCase()) {
    throw new Error(`deposit tx must target the escrow contract (${expected.escrowAddress}), got ${tx.to}`);
  }
  const sender = (tx.sender ?? "").toLowerCase();
  const seller = expected.sellerAddress.toLowerCase();
  if (!isAddress(sender) || sender !== seller) {
    throw new Error(`deposit tx sender must be the deal seller (${expected.sellerAddress}), got ${tx.sender}`);
  }

  const input = (tx.input ?? "").toLowerCase();
  if (input.length < 10 || !input.startsWith(WL_DEAL_DEPOSIT_SELECTOR)) {
    throw new Error(
      `deposit tx calldata must call depositEscrowCollateral(uint256,uint256) (selector ${WL_DEAL_DEPOSIT_SELECTOR})`,
    );
  }

  // decodeFunctionData-style manual arg parse: two uint256 words follow the selector.
  const argHex = input.slice(10);
  if (argHex.length !== 128 || !/^[0-9a-f]{128}$/.test(argHex)) {
    throw new Error("deposit tx calldata malformed: expected exactly two uint256 args");
  }
  const dealId = BigInt("0x" + argHex.slice(0, 64));
  const amount = BigInt("0x" + argHex.slice(64, 128));

  let expectedDealId: bigint;
  try {
    expectedDealId = BigInt(expected.onChainDealId);
  } catch {
    throw new Error(`deal has no numeric on-chain deal id (${expected.onChainDealId})`);
  }
  if (dealId !== expectedDealId) {
    throw new Error(`deposit tx dealId ${dealId} does not match deal ${expectedDealId}`);
  }
  if (amount !== expected.collateralMicro) {
    throw new Error(
      `deposit amount ${amount} micro does not match expected collateral ${expected.collateralMicro} micro`,
    );
  }
  return true;
}

// ===========================================================================
// Settlement lifecycle actions (0071/0072)

// `markDelivered`, `confirmEscrow` and `flagDispute` all take exactly one
// uint256 (the contract dealId) and are called by a PARTY to the deal from
// their own wallet — the client broadcasts, the route verifies. One validator
// covers all three; only the selector and the expected sender differ.
// ===========================================================================

/** 4-byte selectors, derived from the signature so they can never drift. */
export const WL_DEAL_ACTION_SELECTORS = {
  markDelivered: toFunctionSelector("markDelivered(uint256)"),
  confirmEscrow: toFunctionSelector("confirmEscrow(uint256)"),
  flagDispute: toFunctionSelector("flagDispute(uint256)"),
} as const;

export type WlDealAction = keyof typeof WL_DEAL_ACTION_SELECTORS;

export interface DealActionTxFields {
  to: string | null;
  status: string;
  sender: string;
  input: string;
}

export interface DealActionExpectation {
  escrowAddress: string;
  /** The address that MUST have signed: the deal's seller (markDelivered) or buyer (confirmEscrow), or either party (flagDispute). */
  allowedSenders: string[];
  onChainDealId: string;
  action: WlDealAction;
}

/**
 * Strictly validate an on-chain tx claiming to be one of the single-arg escrow
 * lifecycle calls. Throws a descriptive error naming the first failed check
 * (routes map it to 400); returns the matched sender on success.
 *
 * Checks (addresses compared case-insensitively):
 *   1. receipt status === 'success'
 *   2. tx.to == escrow contract
 *   3. tx.from is one of `allowedSenders` (the contract enforces msg.sender)
 *   4. calldata selector == the expected action's selector
 *   5. arg[0] (dealId) == the deal's on_chain_deal_id
 */
export function validateDealActionTx(
  tx: DealActionTxFields,
  expected: DealActionExpectation,
): string {
  const action = expected.action;
  if (tx.status !== "success") {
    throw new Error(`${action} tx status must be 'success' (got '${tx.status}')`);
  }
  const to = (tx.to ?? "").toLowerCase();
  if (to !== expected.escrowAddress.toLowerCase()) {
    throw new Error(
      `${action} tx must target the escrow contract (${expected.escrowAddress}), got ${tx.to}`,
    );
  }
  const sender = (tx.sender ?? "").toLowerCase();
  const allowed = expected.allowedSenders
    .filter((a): a is string => !!a)
    .map((a) => a.toLowerCase());
  if (!isAddress(sender) || !allowed.includes(sender)) {
    throw new Error(
      `${action} tx sender must be ${allowed.join(" or ")}, got ${tx.sender}`,
    );
  }

  const selector = WL_DEAL_ACTION_SELECTORS[action];
  const input = (tx.input ?? "").toLowerCase();
  if (input.length < 10 || !input.startsWith(selector)) {
    throw new Error(
      `${action} tx calldata must call ${action}(uint256) (selector ${selector})`,
    );
  }

  const argHex = input.slice(10);
  if (argHex.length !== 64 || !/^[0-9a-f]{64}$/.test(argHex)) {
    throw new Error(`${action} tx calldata malformed: expected exactly one uint256 arg`);
  }
  const dealId = BigInt("0x" + argHex);

  let expectedDealId: bigint;
  try {
    expectedDealId = BigInt(expected.onChainDealId);
  } catch {
    throw new Error(`deal has no numeric on-chain deal id (${expected.onChainDealId})`);
  }
  if (dealId !== expectedDealId) {
    throw new Error(`${action} tx dealId ${dealId} does not match deal ${expectedDealId}`);
  }

  return sender;
}
