/**
 * AUTO-GENERATED — DO NOT EDIT BY HAND.
 *
 * Source: `contracts/MarketEscrow.json` (compiled artifact).
 * Regenerate: `node scripts/gen-escrow-events.mjs`
 *
 * This is the single source of truth for the MarketEscrow event ABI on the
 * TypeScript side. The ABI used to be hand-written in 3 different files and all
 * three drifted from the contract — which made `parseEventLogs` skip logs
 * without raising an error. Do not repeat that.
 *
 * Guarded by `__tests__/escrow-events.test.ts`.
 */

/** Every MarketEscrow event (including admin events, for the audit log). */
export const ESCROW_EVENTS_ABI = [
  {
    name: "CollateralAdded",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "seller", type: "address", indexed: false }, { name: "added", type: "uint256", indexed: false }, { name: "total", type: "uint256", indexed: false }],
  },
  {
    name: "DealConfirmed",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "buyer", type: "address", indexed: false }],
  },
  {
    name: "DealCreated",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "buyer", type: "address", indexed: false }, { name: "seller", type: "address", indexed: false }, { name: "price", type: "uint256", indexed: false }, { name: "fee", type: "uint256", indexed: false }, { name: "collateral", type: "uint256", indexed: false }],
  },
  {
    name: "DealDelivered",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "seller", type: "address", indexed: false }, { name: "confirmDeadline", type: "uint256", indexed: false }],
  },
  {
    name: "DealDisputed",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "by", type: "address", indexed: false }],
  },
  {
    name: "DealFunded",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "buyer", type: "address", indexed: false }, { name: "price", type: "uint256", indexed: false }, { name: "fee", type: "uint256", indexed: false }],
  },
  {
    name: "DealRefunded",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "mm", type: "address", indexed: false }, { name: "buyer", type: "address", indexed: false }, { name: "amount", type: "uint256", indexed: false }, { name: "collateralReturned", type: "uint256", indexed: false }],
  },
  {
    name: "DealRefundedWithSlash",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "mm", type: "address", indexed: false }, { name: "buyer", type: "address", indexed: false }, { name: "price", type: "uint256", indexed: false }, { name: "collateral", type: "uint256", indexed: false }],
  },
  {
    name: "DealReleased",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "mm", type: "address", indexed: false }, { name: "seller", type: "address", indexed: false }, { name: "payout", type: "uint256", indexed: false }, { name: "collateralReturned", type: "uint256", indexed: false }],
  },
  {
    name: "FeesCollected",
    type: "event",
    anonymous: false,
    inputs: [{ name: "treasury", type: "address", indexed: false }, { name: "amount", type: "uint256", indexed: false }],
  },
  {
    name: "MiddlemanAdded",
    type: "event",
    anonymous: false,
    inputs: [{ name: "mm", type: "address", indexed: true }],
  },
  {
    name: "MiddlemanRemoved",
    type: "event",
    anonymous: false,
    inputs: [{ name: "mm", type: "address", indexed: true }],
  },
  {
    name: "OrderConfirmed",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "buyer", type: "address", indexed: false }],
  },
  {
    name: "OrderCreated",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "buyer", type: "address", indexed: false }, { name: "seller", type: "address", indexed: false }, { name: "amount", type: "uint256", indexed: false }, { name: "fee", type: "uint256", indexed: false }],
  },
  {
    name: "OrderDelivered",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "seller", type: "address", indexed: false }],
  },
  {
    name: "OrderRefunded",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "mm", type: "address", indexed: false }, { name: "buyer", type: "address", indexed: false }, { name: "amount", type: "uint256", indexed: false }],
  },
  {
    name: "OrderReleased",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "mm", type: "address", indexed: false }, { name: "seller", type: "address", indexed: false }, { name: "payout", type: "uint256", indexed: false }],
  },
  {
    name: "OwnershipTransferred",
    type: "event",
    anonymous: false,
    inputs: [{ name: "previousOwner", type: "address", indexed: true }, { name: "newOwner", type: "address", indexed: true }],
  },
  {
    name: "PauseCancelled",
    type: "event",
    anonymous: false,
    inputs: [{ name: "by", type: "address", indexed: true }],
  },
  {
    name: "PauseRequested",
    type: "event",
    anonymous: false,
    inputs: [{ name: "by", type: "address", indexed: true }, { name: "effectiveAt", type: "uint256", indexed: false }],
  },
  {
    name: "Paused",
    type: "event",
    anonymous: false,
    inputs: [],
  },
  {
    name: "TreasuryUpdated",
    type: "event",
    anonymous: false,
    inputs: [{ name: "oldTreasury", type: "address", indexed: false }, { name: "newTreasury", type: "address", indexed: false }],
  },
  {
    name: "Unpaused",
    type: "event",
    anonymous: false,
    inputs: [],
  },
] as const;

/**
 * Order/deal lifecycle events plus fee collection — the ones that change DB state.
 * Used by the polling indexer and the escrow webhook.
 */
export const ESCROW_LIFECYCLE_ABI = [
  {
    name: "OrderReleased",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "mm", type: "address", indexed: false }, { name: "seller", type: "address", indexed: false }, { name: "payout", type: "uint256", indexed: false }],
  },
  {
    name: "OrderRefunded",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "mm", type: "address", indexed: false }, { name: "buyer", type: "address", indexed: false }, { name: "amount", type: "uint256", indexed: false }],
  },
  {
    name: "OrderDelivered",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "seller", type: "address", indexed: false }],
  },
  {
    name: "OrderConfirmed",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "buyer", type: "address", indexed: false }],
  },
  {
    name: "DealReleased",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "mm", type: "address", indexed: false }, { name: "seller", type: "address", indexed: false }, { name: "payout", type: "uint256", indexed: false }, { name: "collateralReturned", type: "uint256", indexed: false }],
  },
  {
    name: "DealRefunded",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "mm", type: "address", indexed: false }, { name: "buyer", type: "address", indexed: false }, { name: "amount", type: "uint256", indexed: false }, { name: "collateralReturned", type: "uint256", indexed: false }],
  },
  {
    name: "DealRefundedWithSlash",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "mm", type: "address", indexed: false }, { name: "buyer", type: "address", indexed: false }, { name: "price", type: "uint256", indexed: false }, { name: "collateral", type: "uint256", indexed: false }],
  },
  {
    name: "DealDisputed",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "by", type: "address", indexed: false }],
  },
  {
    name: "DealDelivered",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "seller", type: "address", indexed: false }, { name: "confirmDeadline", type: "uint256", indexed: false }],
  },
  {
    name: "DealConfirmed",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "buyer", type: "address", indexed: false }],
  },
  {
    name: "CollateralAdded",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "seller", type: "address", indexed: false }, { name: "added", type: "uint256", indexed: false }, { name: "total", type: "uint256", indexed: false }],
  },
  {
    name: "DealFunded",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "buyer", type: "address", indexed: false }, { name: "price", type: "uint256", indexed: false }, { name: "fee", type: "uint256", indexed: false }],
  },
  {
    name: "FeesCollected",
    type: "event",
    anonymous: false,
    inputs: [{ name: "treasury", type: "address", indexed: false }, { name: "amount", type: "uint256", indexed: false }],
  },
] as const;

/**
 * Order/deal creation events. Used to correlate a tx hash back to a contract id
 * (OrderCreated/DealCreated carry no DB id, so it has to be read from the
 * receipt of the tx WE sent).
 */
export const ESCROW_CREATION_ABI = [
  {
    name: "OrderCreated",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "buyer", type: "address", indexed: false }, { name: "seller", type: "address", indexed: false }, { name: "amount", type: "uint256", indexed: false }, { name: "fee", type: "uint256", indexed: false }],
  },
  {
    name: "DealCreated",
    type: "event",
    anonymous: false,
    inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "buyer", type: "address", indexed: false }, { name: "seller", type: "address", indexed: false }, { name: "price", type: "uint256", indexed: false }, { name: "fee", type: "uint256", indexed: false }, { name: "collateral", type: "uint256", indexed: false }],
  },
] as const;

/** Signatures without spaces, for registering as SCP event monitors. */
export const ESCROW_EVENT_SIGNATURES = [
  "CollateralAdded(uint256,address,uint256,uint256)",
  "DealConfirmed(uint256,address)",
  "DealCreated(uint256,address,address,uint256,uint256,uint256)",
  "DealDelivered(uint256,address,uint256)",
  "DealDisputed(uint256,address)",
  "DealFunded(uint256,address,uint256,uint256)",
  "DealRefunded(uint256,address,address,uint256,uint256)",
  "DealRefundedWithSlash(uint256,address,address,uint256,uint256)",
  "DealReleased(uint256,address,address,uint256,uint256)",
  "FeesCollected(address,uint256)",
  "OrderConfirmed(uint256,address)",
  "OrderCreated(uint256,address,address,uint256,uint256)",
  "OrderDelivered(uint256,address)",
  "OrderRefunded(uint256,address,address,uint256)",
  "OrderReleased(uint256,address,address,uint256)",
] as const;
