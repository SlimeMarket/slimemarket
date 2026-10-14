import { circleDeveloperSdk } from "@/lib/circle/client";
import { CIRCLE_USDC_TOKEN_ID } from "@/lib/arc";
import { arcPublicClient } from "@/lib/arc";
import { formatUsdc } from "@/lib/money";
import type { Hex } from "viem";

const ESCROW_CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS ?? "";
const PLATFORM_CIRCLE_WALLET_ID = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";

const TX_OPTS = { fee: { type: "level" as const, config: { feeLevel: "LOW" as const } } };

function getSdk() {
  if (!circleDeveloperSdk) throw new Error("Circle SDK not configured");
  return circleDeveloperSdk;
}

/** Check if on-chain escrow contract is configured */
export function isContractReady(): boolean {
  return !!ESCROW_CONTRACT_ADDRESS && !!PLATFORM_CIRCLE_WALLET_ID && !!circleDeveloperSdk;
}

export async function callContract(
  walletId: string,
  abiFunctionSignature: string,
  abiParameters: unknown[]
): Promise<{ id: string; state: string }> {
  const sdk = getSdk();
  const resp = await sdk.createContractExecutionTransaction({
    walletId,
    contractAddress: ESCROW_CONTRACT_ADDRESS,
    abiFunctionSignature,
    abiParameters,
    ...TX_OPTS,
  });
  return {
    id: resp.data?.id ?? "",
    state: resp.data?.state ?? "UNKNOWN",
  };
}

export async function sendUsdc(
  fromWalletId: string,
  toAddress: string,
  amountMicro: bigint
): Promise<{ id: string; state: string }> {
  const sdk = getSdk();
  // Circle API expects amount in DISPLAY units (e.g. "5.5" USDC), NOT micro-USDC.
  // formatUsdc converts micro-USDC bigint → human-readable string.
  const resp = await sdk.createTransaction({
    walletId: fromWalletId,
    tokenId: CIRCLE_USDC_TOKEN_ID,
    amount: [formatUsdc(amountMicro)],
    destinationAddress: toAddress,
    ...TX_OPTS,
  });
  return {
    id: resp.data?.id ?? "",
    state: resp.data?.state ?? "UNKNOWN",
  };
}

// ===== Marketplace Contract Calls (when ready) =====
// Marketplace fee model: buyer pays +2% (FEE_BPS, non-refundable), seller
// receives amount -2% (SELLER_FEE_BPS) at release. Fee computed inside the
// contract (computeFee). Backend just passes `amount` (= item price).
// Buyer approves `amount + fee` (= buyerPaysTotal).

// `deliveryWindowSeconds` sets the seller's delivery deadline (clamped on-chain
// to [MIN_DELIVERY_WINDOW, MAX_DELIVERY_WINDOW]).

export async function createOrderOnChain(
  seller: string,
  amountMicro: bigint,
  deliveryWindowSeconds: number,
) {
  if (!isContractReady()) return null;
  return callContract(
    PLATFORM_CIRCLE_WALLET_ID,
    "createOrder(address,uint256,uint256)",
    [seller, amountMicro.toString(), String(deliveryWindowSeconds)]
  );
}

/** EIP-2612 permit signature captured from the buyer's UCW (Sign Typed Data). */
export interface PermitSig {
  deadline: string; // uint256 as decimal string (must match the signed value)
  v: number;
  r: string; // bytes32 hex
  s: string; // bytes32 hex
}

/**
 * Relayer-submitted order funded by the BUYER via EIP-2612 permit.
 * Platform DCW submits the tx and pays gas; funds are pulled from the buyer's
 * UCW (not the DCW). Requires the buyer's permit signature over `buyerPaysTotal`
 * (= amount + 2% fee, computed by the contract).
 */
export async function createOrderForOnChain(params: {
  buyer: string;
  seller: string;
  amountMicro: bigint;
  deliveryWindowSeconds: number;
  permit: PermitSig;
}) {
  if (!isContractReady()) return null;
  const { buyer, seller, amountMicro, deliveryWindowSeconds, permit } = params;
  return callContract(
    PLATFORM_CIRCLE_WALLET_ID,
    "createOrderFor(address,address,uint256,uint256,uint256,uint8,bytes32,bytes32)",
    [
      buyer,
      seller,
      amountMicro.toString(),
      String(deliveryWindowSeconds),
      permit.deadline,
      permit.v,
      permit.r,
      permit.s,
    ]
  );
}

export async function releaseOrderOnChain(orderId: string, mmWalletId: string) {
  if (!isContractReady()) return null;
  return callContract(mmWalletId, "releaseOrder(uint256)", [orderId]);
}

export async function refundOrderOnChain(orderId: string, mmWalletId: string) {
  if (!isContractReady()) return null;
  return callContract(mmWalletId, "refundOrder(uint256)", [orderId]);
}

/** Seller marks the order delivered, starting the buyer's confirmation clock. */
export async function markOrderDeliveredOnChain(orderId: string, sellerWalletId: string) {
  if (!isContractReady()) return null;
  return callContract(sellerWalletId, "markOrderDelivered(uint256)", [orderId]);
}

/**
 * Buyer confirms receipt. Buyer-only; releases immediately without any operator.
 * The buyer's own UCW signs this, so no relayer is needed.
 */
export async function confirmOrderOnChain(orderId: string, buyerWalletId: string) {
  if (!isContractReady()) return null;
  return callContract(buyerWalletId, "confirmOrder(uint256)", [orderId]);
}

// ===== Fee collection (F4) =====

/** Minimal view ABI for reading escrow accounting state off-chain. */
const ESCROW_VIEW_ABI = [
  { type: "function", name: "pendingFees", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "orderCounter", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  // F6 views:
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "pauseRequestedAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  // Settlement clocks — surfaced so the UI can show the buyer the real windows
  // before they pay, and so the sweeper knows when a deal becomes settleable.
  { type: "function", name: "MIN_DELIVERY_WINDOW", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "MAX_DELIVERY_WINDOW", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "CONFIRM_WINDOW", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "DISPUTE_BACKSTOP", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

/**
 * Escape-hatch timeout for MARKETPLACE ORDERS (7 days). Escrow deals no longer
 * use a global constant — they settle off the per-deal `deliveryDeadline` and
 * `confirmDeadline` stored on the deal row.
 */
export const ESCROW_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;
/** Pause timelock (24 hours) — `executePause` works only after this elapses. */
export const PAUSE_DELAY_SECONDS = 24 * 60 * 60;

/**
 * Local mirrors of the contract's timing constants. These are DEFAULTS for
 * building new deals; the authoritative values are read from the contract via
 * `readSettlementWindows()` and clamped on-chain, so a config drift can never
 * let the app promise a window the contract would reject.
 */
export const MIN_DELIVERY_WINDOW_SECONDS = 60 * 60; // 1 hour
export const MAX_DELIVERY_WINDOW_SECONDS = 365 * 24 * 60 * 60; // 1 year
export const CONFIRM_WINDOW_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const DISPUTE_BACKSTOP_SECONDS = 30 * 24 * 60 * 60; // 30 days

/** Common delivery windows offered in the listing form (label → seconds). */
export const DELIVERY_WINDOW_PRESETS: ReadonlyArray<{ label: string; seconds: number }> = [
  { label: "1 day", seconds: 24 * 60 * 60 },
  { label: "3 days", seconds: 3 * 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { label: "30 days", seconds: 30 * 24 * 60 * 60 },
  { label: "90 days", seconds: 90 * 24 * 60 * 60 },
  { label: "180 days", seconds: 180 * 24 * 60 * 60 },
  { label: "1 year", seconds: 365 * 24 * 60 * 60 },
];

/**
 * Default delivery window for MARKETPLACE ORDERS. Marketplace listings are
 * physical goods shipped promptly, so they do not carry a seller-chosen window
 * the way OTC listings do — a 7-day default matches the order escape hatch.
 */
export const MARKETPLACE_DELIVERY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * Fallback delivery window for OTC deals when the listing carries no explicit
 * value. Mirrors the `wl_listings.delivery_window_seconds` column default, so a
 * row written before this feature existed still produces a sane deal.
 */
export const DEFAULT_OTC_DELIVERY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * Reads the ACTUAL collateral locked for a deal straight from the contract.
 *
 * Why this exists (A2): `createEscrowDeal` creates AND funds the on-chain deal in
 * one step, so the seller's collateral can only be deposited afterwards. That
 * leaves a window where the DB could claim a deal is "protected" while the
 * collateral is not really there. The DB must never trust a client-supplied
 * collateral figure — it reads the chain.
 *
 * Returns null when the deal does not exist on-chain.
 */
export async function readOnChainDealCollateral(onChainDealId: string): Promise<bigint | null> {
  if (!ESCROW_CONTRACT_ADDRESS) throw new Error("ESCROW_CONTRACT_ADDRESS not configured");
  let id: bigint;
  try {
    id = BigInt(onChainDealId);
  } catch {
    throw new Error(`invalid on-chain deal id: ${onChainDealId}`);
  }
  const client = arcPublicClient();
  const raw = (await client.readContract({
    address: ESCROW_CONTRACT_ADDRESS as Hex,
    abi: DEAL_VIEW_ABI,
    functionName: "deals",
    args: [id],
  })) as unknown as readonly unknown[];
  if (!raw || raw.length === 0) return null;
  // Positional tuple (viem returns an array for struct views):
  // [0]=buyer [1]=seller [2]=price [3]=fee [4]=collateral ...
  const collateral = raw[4];
  return typeof collateral === "bigint" ? collateral : null;
}

/** Minimal view ABI for the escrow deal struct. */
const DEAL_VIEW_ABI = [
  {
    type: "function",
    name: "deals",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "buyer", type: "address" },
      { name: "seller", type: "address" },
      { name: "price", type: "uint256" },
      { name: "fee", type: "uint256" },
      { name: "collateral", type: "uint256" },
      { name: "collateralReturned", type: "uint256" },
      { name: "createdAt", type: "uint256" },
      { name: "deliveryDeadline", type: "uint256" },
      { name: "confirmDeadline", type: "uint256" },
      { name: "disputedAt", type: "uint256" },
      { name: "buyerDeposited", type: "bool" },
      { name: "delivered", type: "bool" },
      { name: "buyerConfirmed", type: "bool" },
      { name: "disputed", type: "bool" },
      { name: "released", type: "bool" },
      { name: "refunded", type: "bool" },
    ],
  },
] as const;

/** True only when a contract address is configured (reads don't need the DCW). */
export function isContractAddressSet(): boolean {
  return !!ESCROW_CONTRACT_ADDRESS;
}

/**
 * Reads the settlement windows straight from the contract. Prefer this over the
 * local mirrors above when displaying anything the user will rely on.
 */
export async function readSettlementWindows(): Promise<{
  minDeliveryWindow: bigint;
  maxDeliveryWindow: bigint;
  confirmWindow: bigint;
  disputeBackstop: bigint;
}> {
  if (!ESCROW_CONTRACT_ADDRESS) throw new Error("ESCROW_CONTRACT_ADDRESS not configured");
  const client = arcPublicClient();
  const address = ESCROW_CONTRACT_ADDRESS as Hex;
  const [minDeliveryWindow, maxDeliveryWindow, confirmWindow, disputeBackstop] = await Promise.all([
    client.readContract({ address, abi: ESCROW_VIEW_ABI, functionName: "MIN_DELIVERY_WINDOW" }) as Promise<bigint>,
    client.readContract({ address, abi: ESCROW_VIEW_ABI, functionName: "MAX_DELIVERY_WINDOW" }) as Promise<bigint>,
    client.readContract({ address, abi: ESCROW_VIEW_ABI, functionName: "CONFIRM_WINDOW" }) as Promise<bigint>,
    client.readContract({ address, abi: ESCROW_VIEW_ABI, functionName: "DISPUTE_BACKSTOP" }) as Promise<bigint>,
  ]);
  return { minDeliveryWindow, maxDeliveryWindow, confirmWindow, disputeBackstop };
}

/**
 * Reads on-chain fee accounting: accrued `pendingFees` (micro-USDC), the
 * `treasury` address authorized to collect them, and the `orderCounter`.
 * Throws if no contract address is configured or the RPC is unreachable.
 */
export async function readEscrowStats(): Promise<{
  pendingFees: bigint;
  treasury: string;
  orderCounter: bigint;
  // F6 views:
  paused: boolean;
  pauseRequestedAt: bigint;
  owner: string;
}> {
  if (!ESCROW_CONTRACT_ADDRESS) throw new Error("ESCROW_CONTRACT_ADDRESS not configured");
  const client = arcPublicClient();
  const address = ESCROW_CONTRACT_ADDRESS as Hex;
  const [pendingFees, treasury, orderCounter, paused, pauseRequestedAt, owner] = await Promise.all([
    client.readContract({ address, abi: ESCROW_VIEW_ABI, functionName: "pendingFees" }) as Promise<bigint>,
    client.readContract({ address, abi: ESCROW_VIEW_ABI, functionName: "treasury" }) as Promise<string>,
    client.readContract({ address, abi: ESCROW_VIEW_ABI, functionName: "orderCounter" }) as Promise<bigint>,
    client.readContract({ address, abi: ESCROW_VIEW_ABI, functionName: "paused" }) as Promise<boolean>,
    client.readContract({ address, abi: ESCROW_VIEW_ABI, functionName: "pauseRequestedAt" }) as Promise<bigint>,
    client.readContract({ address, abi: ESCROW_VIEW_ABI, functionName: "owner" }) as Promise<string>,
  ]);
  return { pendingFees, treasury, orderCounter, paused, pauseRequestedAt, owner };
}

/**
 * Sweep accrued platform fees from the escrow to the treasury.
 *
 * treasury is the platform DCW itself (contracts/deploy.ts deploys
 * MarketEscrow with `_treasury = _platform = <platform DCW address>`), and
 * `collectFees()` only requires `msg.sender == treasury`. So the DCW can call it
 * directly through the same `callContract` path every other admin action uses.
 *
 * HISTORY / WHY THIS WAS BROKEN: an earlier design put a 2-of-3 MultisigTreasury
 * at that address, so this function was stubbed out to throw and a viem-based
 * multisig trio (submit/confirm/execute) was added instead. The multisig was
 * never deployed (deploy.ts skips it), the owner private keys were never in
 * `.env.multisig-keys`, and the trio would have called `submitTx` on a plain
 * DCW address. Net result: there was NO working way to collect fees at all.
 * The multisig code is deleted; treasury is one wallet by design.
 *
 * `pendingFees` accumulates BOTH fees: the buyer fee (2%, collected at creation)
 * and, for marketplace orders, the seller fee (2%, deducted at release). WL
 * deals contribute only the buyer fee.
 */
export async function collectFeesOnChain(): Promise<{ id: string; state: string } | null> {
  if (!isContractReady()) return null;
  return callContract(PLATFORM_CIRCLE_WALLET_ID, "collectFees()", []);
}

// ===== WL Escrow Contract Calls (when ready) =====
// WL/rekber fee model: buyer pays +2% (FEE_BPS, non-refundable), seller
// receives 100% of `price` (no seller-side fee). Fee computed inside the
// contract (computeFee). Backend just passes `price`.
// Buyer approves `price + fee` (= buyerPaysTotal).

// SETTLEMENT CLOCKS (mirrors the contract):
//   createdAt ─▶ deliveryDeadline ─▶ markDelivered ─▶ confirmDeadline ─▶ release
//   - seller never delivers past deliveryDeadline  ⇒ anyone may refund
//   - delivered, buyer silent past confirmDeadline ⇒ anyone may release
//   - disputed ⇒ escape hatches frozen; backstop refunds the buyer

// `deliveryWindowSeconds` is the seller's delivery window, clamped on-chain to
// [MIN_DELIVERY_WINDOW, MAX_DELIVERY_WINDOW]. OTC deals legitimately run long
// (e.g. an airdrop-eligible wallet claiming months later), so this is per-deal
// rather than a global constant.

export async function createEscrowDealOnChain(
  seller: string,
  priceMicro: bigint,
  deliveryWindowSeconds: number,
) {
  if (!isContractReady()) return null;
  return callContract(
    PLATFORM_CIRCLE_WALLET_ID,
    "createEscrowDeal(address,uint256,uint256)",
    [seller, priceMicro.toString(), String(deliveryWindowSeconds)]
  );
}

/**
 * COLLATERAL-FIRST shell flow (A2).
 *
 * The SELLER opens an unfunded deal shell and deposits the fraud collateral in
 * the same transaction. The buyer then funds it via `fundEscrowDealOnChain`, and
 * `fundEscrowDeal` refuses to run unless collateral is already locked — so the
 * buyer's USDC can never sit in escrow with nothing backing it.
 *
 * The delivery clock starts at FUNDING, not here, so a late buyer still gets the
 * full window.
 */
export async function createEscrowDealAsSellerOnChain(params: {
  buyer: string;
  priceMicro: bigint;
  deliveryWindowSeconds: number;
  collateralMicro: bigint;
  sellerWalletId: string;
}) {
  if (!isContractReady()) return null;
  const { buyer, priceMicro, deliveryWindowSeconds, collateralMicro, sellerWalletId } = params;
  return callContract(
    sellerWalletId,
    "createEscrowDealAsSeller(address,uint256,uint256,uint256)",
    [buyer, priceMicro.toString(), String(deliveryWindowSeconds), collateralMicro.toString()]
  );
}

/**
 * Buyer funds a shell the seller opened. This is the moment the deal goes live:
 * the buyer's `price + fee` moves and the delivery clock starts.
 */
export async function fundEscrowDealOnChain(dealId: string, buyerWalletId: string) {
  if (!isContractReady()) return null;
  return callContract(buyerWalletId, "fundEscrowDeal(uint256)", [dealId]);
}

/**
 * Relayer-submitted WL escrow deal funded by the BUYER via EIP-2612 permit.
 * Pulls price+fee from `buyer` (not msg.sender). Buyer permit over `buyerPaysTotal`.
 */
export async function createEscrowDealForOnChain(params: {
  buyer: string;
  seller: string;
  priceMicro: bigint;
  deliveryWindowSeconds: number;
  permit: PermitSig;
}) {
  if (!isContractReady()) return null;
  const { buyer, seller, priceMicro, deliveryWindowSeconds, permit } = params;
  return callContract(
    PLATFORM_CIRCLE_WALLET_ID,
    "createEscrowDealFor(address,address,uint256,uint256,uint256,uint8,bytes32,bytes32)",
    [
      buyer,
      seller,
      priceMicro.toString(),
      String(deliveryWindowSeconds),
      permit.deadline,
      permit.v,
      permit.r,
      permit.s,
    ]
  );
}

/**
 * Seller deposits — or TOPS UP — the fraud collateral.
 *
 * Deliberately callable more than once: OTC collateral is negotiated in the deal
 * room, and the buyer may ask for more after the first deposit. Collateral can
 * only grow; there is no withdrawal path, so the buyer's protection can never be
 * reduced after they have paid.
 */
export async function depositEscrowCollateralOnChain(dealId: string, amountMicro: bigint, sellerWalletId: string) {
  if (!isContractReady()) return null;
  return callContract(
    sellerWalletId,
    "depositEscrowCollateral(uint256,uint256)",
    [dealId, amountMicro.toString()]
  );
}

/** Seller marks the deal delivered, starting the buyer's confirmation clock. */
export async function markDeliveredOnChain(dealId: string, sellerWalletId: string) {
  if (!isContractReady()) return null;
  return callContract(sellerWalletId, "markDelivered(uint256)", [dealId]);
}

/**
 * Buyer confirms receipt — releases immediately, no middleman involved.
 * The buyer's own UCW signs this, so a happy buyer never needs the platform.
 */
export async function confirmEscrowOnChain(dealId: string, buyerWalletId: string) {
  if (!isContractReady()) return null;
  return callContract(buyerWalletId, "confirmEscrow(uint256)", [dealId]);
}

export async function releaseEscrowOnChain(dealId: string, mmWalletId: string) {
  if (!isContractReady()) return null;
  return callContract(mmWalletId, "releaseEscrow(uint256)", [dealId]);
}

export async function refundEscrowOnChain(dealId: string, mmWalletId: string) {
  if (!isContractReady()) return null;
  return callContract(mmWalletId, "refundEscrow(uint256)", [dealId]);
}

/**
 * Refund the buyer AND forfeit the seller's collateral to them as compensation
 * for PROVEN FRAUD. Middleman-only.
 *
 * This is what gives the collateral meaning. Typical WL/mint fraud: the buyer
 * funds a mint wallet with their own money, and the seller forwards those funds
 * elsewhere or mints the NFT to an address that is not the buyer's. Evidence
 * usually lives on another chain, so the platform admin verifies it manually and
 * rules here. Requires `collateral > 0`.
 */
export async function refundEscrowWithSlashOnChain(dealId: string, mmWalletId: string) {
  if (!isContractReady()) return null;
  return callContract(mmWalletId, "refundEscrowWithSlash(uint256)", [dealId]);
}

/**
 * Either party raises a dispute, freezing the escape hatches so the middleman can
 * arbitrate without the other side racing settlement. If the platform never
 * resolves, the contract's DISPUTE_BACKSTOP refunds the buyer.
 */
export async function flagDisputeOnChain(dealId: string, partyWalletId: string) {
  if (!isContractReady()) return null;
  return callContract(partyWalletId, "flagDispute(uint256)", [dealId]);
}

// ===== Escape Hatches (F6 — anti-censorship) =====

// Callable by ANYONE after `ESCROW_TIMEOUT` (7 days) elapsed since order/deal
// creation. The `deadline` param protects against stale calls. These functions
// protect against DCW censorship: if the platform refuses or is unable to
// relay release/refund, the counterparty self-serves after the timeout.

// Wallet id here is the relayer executing the escape hatch — typically the
// platform DCW, but could be ANY Circle wallet (even the buyer/seller's own UCW
// if they want to self-serve).

export async function releaseOrderAfterTimeoutOnChain(
  orderId: string,
  deadline: number,
  callerWalletId: string,
) {
  if (!isContractReady()) return null;
  return callContract(
    callerWalletId,
    "releaseOrderAfterTimeout(uint256,uint256)",
    [orderId, deadline.toString()],
  );
}

export async function refundOrderAfterTimeoutOnChain(
  orderId: string,
  deadline: number,
  callerWalletId: string,
) {
  if (!isContractReady()) return null;
  return callContract(
    callerWalletId,
    "refundOrderAfterTimeout(uint256,uint256)",
    [orderId, deadline.toString()],
  );
}

export async function releaseEscrowAfterTimeoutOnChain(
  dealId: string,
  deadline: number,
  callerWalletId: string,
) {
  if (!isContractReady()) return null;
  return callContract(
    callerWalletId,
    "releaseEscrowAfterTimeout(uint256,uint256)",
    [dealId, deadline.toString()],
  );
}

export async function refundEscrowAfterTimeoutOnChain(
  dealId: string,
  deadline: number,
  callerWalletId: string,
) {
  if (!isContractReady()) return null;
  return callContract(
    callerWalletId,
    "refundEscrowAfterTimeout(uint256,uint256)",
    [dealId, deadline.toString()],
  );
}

// ===== Admin: pause timelock + ownership transfer (F6) =====

export async function requestPauseOnChain(ownerWalletId?: string) {
  if (!isContractReady()) return null;
  return callContract(ownerWalletId ?? PLATFORM_CIRCLE_WALLET_ID, "requestPause()", []);
}

export async function cancelPauseOnChain(ownerWalletId?: string) {
  if (!isContractReady()) return null;
  return callContract(ownerWalletId ?? PLATFORM_CIRCLE_WALLET_ID, "cancelPause()", []);
}

export async function executePauseOnChain(ownerWalletId?: string) {
  if (!isContractReady()) return null;
  return callContract(ownerWalletId ?? PLATFORM_CIRCLE_WALLET_ID, "executePause()", []);
}

export async function unpauseOnChain(ownerWalletId?: string) {
  if (!isContractReady()) return null;
  return callContract(ownerWalletId ?? PLATFORM_CIRCLE_WALLET_ID, "unpause()", []);
}

export async function transferOwnershipOnChain(newOwner: string, ownerWalletId?: string) {
  if (!isContractReady()) return null;
  return callContract(
    ownerWalletId ?? PLATFORM_CIRCLE_WALLET_ID,
    "transferOwnership(address)",
    [newOwner],
  );
}

export async function setTreasuryOnChain(newTreasury: string, ownerWalletId?: string) {
  if (!isContractReady()) return null;
  return callContract(
    ownerWalletId ?? PLATFORM_CIRCLE_WALLET_ID,
    "setTreasury(address)",
    [newTreasury],
  );
}

export async function addMiddlemanOnChain(mm: string, ownerWalletId?: string) {
  if (!isContractReady()) return null;
  return callContract(
    ownerWalletId ?? PLATFORM_CIRCLE_WALLET_ID,
    "addMiddleman(address)",
    [mm],
  );
}

export async function removeMiddlemanOnChain(mm: string, ownerWalletId?: string) {
  if (!isContractReady()) return null;
  return callContract(
    ownerWalletId ?? PLATFORM_CIRCLE_WALLET_ID,
    "removeMiddleman(address)",
    [mm],
  );
}
