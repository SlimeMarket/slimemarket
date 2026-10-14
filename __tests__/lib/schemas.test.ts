import { describe, it, expect } from "vitest";
import {
  CheckoutBodySchema,
  WithdrawBodySchema,
  TopupBodySchema,
  EarningsWithdrawBodySchema,
  CreateWlDealBodySchema,
  TreasuryWithdrawBodySchema,
  TreasuryAirdropBodySchema,
  CrossChainBodySchema,
} from "@/lib/schemas";

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const TX_HASH = "0x" + "ab".repeat(32);

describe("schemas — checkout", () => {
  it("accepts valid checkout body", () => {
    const r = CheckoutBodySchema.safeParse({
      productId: "550e8400-e29b-41d4-a716-446655440000",
      qty: 2,
      payment: "Balance",
    });
    expect(r.success).toBe(true);
  });

  it("rejects non-UUID productId", () => {
    const r = CheckoutBodySchema.safeParse({ productId: "not-a-uuid" });
    expect(r.success).toBe(false);
  });

  it("rejects qty <= 0", () => {
    const r = CheckoutBodySchema.safeParse({
      productId: "550e8400-e29b-41d4-a716-446655440000",
      qty: 0,
    });
    expect(r.success).toBe(false);
  });

  it("rejects qty > 1_000_000", () => {
    const r = CheckoutBodySchema.safeParse({
      productId: "550e8400-e29b-41d4-a716-446655440000",
      qty: 1_000_001,
    });
    expect(r.success).toBe(false);
  });
});

describe("schemas — withdraw", () => {
  it("accepts valid destAddress withdraw", () => {
    const r = WithdrawBodySchema.safeParse({
      amountUsdc: "10.50",
      destAddress: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(r.success).toBe(true);
  });

  it("rejects both bankAccountId and destAddress set", () => {
    const r = WithdrawBodySchema.safeParse({
      amountUsdc: "10.50",
      bankAccountId: "acct_123",
      destAddress: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(r.success).toBe(false);
  });

  it("rejects neither bankAccountId nor destAddress", () => {
    const r = WithdrawBodySchema.safeParse({ amountUsdc: "10.50" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid destAddress (not 0x-prefixed)", () => {
    const r = WithdrawBodySchema.safeParse({
      amountUsdc: "10.50",
      destAddress: "xyz",
    });
    expect(r.success).toBe(false);
  });

  it("rejects negative amountUsdc", () => {
    const r = WithdrawBodySchema.safeParse({
      amountUsdc: "-5.00",
      destAddress: "0x1234567890abcdef1234567890abcdef12345678",
    });
    expect(r.success).toBe(false);
  });
});

describe("schemas — topup", () => {
  it("accepts valid topup", () => {
    const r = TopupBodySchema.safeParse({
      method: "card",
      fiatAmount: 50.0,
      currency: "USD",
    });
    expect(r.success).toBe(true);
  });

  it("rejects invalid method", () => {
    const r = TopupBodySchema.safeParse({
      method: "paypal",
      fiatAmount: 50,
      currency: "USD",
    });
    expect(r.success).toBe(false);
  });

  it("rejects non-3-letter currency", () => {
    const r = TopupBodySchema.safeParse({
      method: "card",
      fiatAmount: 50,
      currency: "DOLLAR",
    });
    expect(r.success).toBe(false);
  });
});

describe("schemas — earnings withdraw", () => {
  it("accepts valid", () => {
    const r = EarningsWithdrawBodySchema.safeParse({
      amountUsdc: "100.00",
      destAddress: "0xb5ce274c8bd4d46b376f2d27eb5c2c2406fe042d",
    });
    expect(r.success).toBe(true);
  });

  it("rejects amountUsdc as number (must be string)", () => {
    const r = EarningsWithdrawBodySchema.safeParse({
      amountUsdc: 100,
      destAddress: "0xb5ce274c8bd4d46b376f2d27eb5c2c2406fe042d",
    });
    expect(r.success).toBe(false);
  });
});

describe("schemas — WL deal", () => {
  it("accepts valid", () => {
    const r = CreateWlDealBodySchema.safeParse({
      listingId: "550e8400-e29b-41d4-a716-446655440000",
      qty: 1,
      isOffer: false,
    });
    expect(r.success).toBe(true);
  });

  it("rejects non-UUID listingId", () => {
    const r = CreateWlDealBodySchema.safeParse({ listingId: "abc" });
    expect(r.success).toBe(false);
  });
});

describe("schemas — treasury withdraw", () => {
  it("accepts valid with sourceAccount", () => {
    const r = TreasuryWithdrawBodySchema.safeParse({
      recipientUserId: "550e8400-e29b-41d4-a716-446655440000",
      amountUsdc: "50.00",
      memo: "MM salary July",
      sourceAccount: "gas_pool",
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown sourceAccount", () => {
    const r = TreasuryWithdrawBodySchema.safeParse({
      recipientUserId: "550e8400-e29b-41d4-a716-446655440000",
      amountUsdc: "50.00",
      memo: "x",
      sourceAccount: "treasury",
    });
    expect(r.success).toBe(false);
  });
});

describe("schemas — treasury airdrop", () => {
  it("accepts valid batch (1-20 recipients)", () => {
    const r = TreasuryAirdropBodySchema.safeParse({
      recipients: [
        { userId: "550e8400-e29b-41d4-a716-446655440000", amountUsdc: "10.00" },
      ],
      memo: "Reward",
    });
    expect(r.success).toBe(true);
  });

  it("rejects empty recipients", () => {
    const r = TreasuryAirdropBodySchema.safeParse({
      recipients: [],
      memo: "Reward",
    });
    expect(r.success).toBe(false);
  });

  it("rejects >20 recipients", () => {
    const recipients = Array.from({ length: 21 }, (_, i) => ({
      userId: "550e8400-e29b-41d4-a716-44665544000" + i.toString().padStart(1, "0"),
      amountUsdc: "1.00",
    }));
    const r = TreasuryAirdropBodySchema.safeParse({ recipients, memo: "x" });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-chain bridge body — a discriminated union of three actions.
//
// The route dispatches on `action`, so a body that parses but carries the wrong
// shape would fall through to the wrong branch. These pin the discriminator and
// the per-action required fields.
// ---------------------------------------------------------------------------
describe("schemas — cross-chain bridge", () => {
  it("accepts a prepare body", () => {
    const r = CrossChainBodySchema.safeParse({
      action: "prepare",
      sourceChain: "baseSepolia",
      amountUsdc: "10.00",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a confirm body for each step", () => {
    for (const step of ["approve", "burn"]) {
      const r = CrossChainBodySchema.safeParse({
        action: "confirm",
        bridgeId: UUID,
        step,
        txHash: TX_HASH,
      });
      expect(r.success, `step=${step}`).toBe(true);
    }
  });

  it("accepts a retry body — only the id is needed, nothing is client-supplied", () => {
    const r = CrossChainBodySchema.safeParse({ action: "retry", bridgeId: UUID });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown action", () => {
    expect(CrossChainBodySchema.safeParse({ action: "nonsense" }).success).toBe(false);
  });

  it("rejects a confirm with a malformed tx hash", () => {
    const r = CrossChainBodySchema.safeParse({
      action: "confirm",
      bridgeId: UUID,
      step: "burn",
      txHash: "0xnothex",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a confirm with an unknown step", () => {
    const r = CrossChainBodySchema.safeParse({
      action: "confirm",
      bridgeId: UUID,
      step: "mint",
      txHash: TX_HASH,
    });
    expect(r.success).toBe(false);
  });

  it("rejects a prepare with a non-positive amount", () => {
    for (const amountUsdc of ["0", "0.00", "-1"]) {
      const r = CrossChainBodySchema.safeParse({
        action: "prepare",
        sourceChain: "baseSepolia",
        amountUsdc,
      });
      expect(r.success, `amount=${amountUsdc}`).toBe(false);
    }
  });

  it("rejects a retry with a non-uuid bridge id", () => {
    expect(CrossChainBodySchema.safeParse({ action: "retry", bridgeId: "abc" }).success).toBe(false);
  });
});
