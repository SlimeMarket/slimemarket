import { describe, it, expect } from "vitest";
import { encodeFunctionData } from "viem";
import {
  buildWlDealPermitPayload,
  validateDepositCollateralTx,
  WL_DEAL_DEPOSIT_SELECTOR,
} from "@/lib/wl/eoa";
import { resolveConfirmPayer } from "@/lib/order/permit-checkout";
import {
  WlDealConfirmBodySchema,
  WlDealPermitPayloadBodySchema,
  WlDealCollateralEoaBodySchema,
} from "@/lib/schemas";
import { ARC_CHAIN_ID, ARC_USDC_CONTRACT } from "@/lib/arc";

/**
 * .D3 — EOA external-wallet support for WL escrow deals.
 *
 * Contract facts (contracts/MarketEscrow.sol):
 *   - createEscrowDealFor(buyer, seller, price, baseFee, deadline, v, r, s)
 *     (onlyOperator) pulls total = price + baseFee from `buyer` via
 *     _applyPermit + safeTransferFrom → the buyer permit `value` MUST be
 *     price + baseFee (same shape as marketplace createOrderFor).
 *   - depositEscrowCollateral(dealId, amount) requires msg.sender == d.seller
 *     and pulls `amount` via safeTransferFrom(msg.sender) → an EOA seller
 *     must approve the escrow first, then call it from their own wallet.
 */

const BUYER_EOA = "0x1111111111111111111111111111111111111111";
const SELLER_EOA = "0x2222222222222222222222222222222222222222";
const ESCROW = "0x2cfb1c34b5afd797948a5716de422128df3d1553";
const USDC = "0x3600000000000000000000000000000000000000";

const DEPOSIT_ABI = [
  {
    type: "function",
    name: "depositEscrowCollateral",
    stateMutability: "nonpayable",
    inputs: [
      { name: "dealId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

function depositInput(dealId: bigint, amount: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: DEPOSIT_ABI,
    functionName: "depositEscrowCollateral",
    args: [dealId, amount],
  });
}

// ---------------------------------------------------------------------------
// buildWlDealPermitPayload — EIP-2612 typed data for deal funding
// ---------------------------------------------------------------------------

describe("buildWlDealPermitPayload — permit value = price + baseFee exactly", () => {
  const base = {
    owner: BUYER_EOA,
    spender: ESCROW,
    priceMicro: 25_500_000n, // $25.50
    baseFeeMicro: 4_000_000n, // fixed $4 base fee
    nonce: 3n,
    nowSeconds: 1_700_000_000,
  };

  it("value is EXACTLY price + baseFee in micro-USDC (bigint math)", () => {
    const p = buildWlDealPermitPayload(base);
    expect(p.message.value).toBe("29500000"); // 25_500_000 + 4_000_000
  });

  it("uses the Arc USDC EIP-712 domain (name USDC, version 2, chainId 5042002)", () => {
    const p = buildWlDealPermitPayload(base);
    expect(p.domain).toEqual({
      name: "USDC",
      version: "2",
      chainId: ARC_CHAIN_ID,
      verifyingContract: ARC_USDC_CONTRACT.toLowerCase(),
    });
    expect(p.primaryType).toBe("Permit");
  });

  it("message carries owner/spender/nonce + server deadline (now + 30 min)", () => {
    const p = buildWlDealPermitPayload(base);
    expect(p.message.owner).toBe(BUYER_EOA);
    expect(p.message.spender).toBe(ESCROW);
    expect(p.message.nonce).toBe("3");
    expect(p.message.deadline).toBe(String(1_700_000_000 + 30 * 60));
    expect(p.deadline).toBe(p.message.deadline);
  });

  it("handles large micro amounts without number-precision loss", () => {
    const p = buildWlDealPermitPayload({
      ...base,
      priceMicro: 999_999_999_999_999n, // ~$1B
    });
    expect(p.message.value).toBe("1000000003999999"); // price + 4_000_000
  });

  it("rejects zero price (contract requires price > 0)", () => {
    expect(() => buildWlDealPermitPayload({ ...base, priceMicro: 0n })).toThrow(/price/i);
  });

  it("rejects a negative fee", () => {
    expect(() => buildWlDealPermitPayload({ ...base, baseFeeMicro: -1n })).toThrow(/fee/i);
  });

  it("allows a zero fee — computeFee(price) is legitimately 0 for dust prices", () => {
    // the fee is the contract's 2% (computeFee), which truncates to 0
    // below 50 micro-USDC. The old guard rejected 0 only because callers used to
    // pass the deprecated always-0 baseFee field.
    const p = buildWlDealPermitPayload({ ...base, baseFeeMicro: 0n });
    expect(p.message.value).toBe(base.priceMicro.toString());
  });
});

// ---------------------------------------------------------------------------
// validateDepositCollateralTx — strict on-chain deposit verification
// ---------------------------------------------------------------------------

describe("validateDepositCollateralTx — receipt/tx verification matrix", () => {
  const expected = {
    escrowAddress: ESCROW,
    sellerAddress: SELLER_EOA,
    onChainDealId: "7",
    collateralMicro: 10_000_000n,
  };

  const validTx = {
    to: ESCROW,
    status: "success" as const,
    sender: SELLER_EOA,
    input: depositInput(7n, 10_000_000n),
  };

  it("selector matches depositEscrowCollateral(uint256,uint256)", () => {
    expect(WL_DEAL_DEPOSIT_SELECTOR).toBe("0x25f043d8");
  });

  it("accepts a fully valid deposit tx", () => {
    expect(validateDepositCollateralTx(validTx, expected)).toBe(true);
  });

  it("is case-insensitive on addresses (checksummed inputs)", () => {
    const tx = {
      ...validTx,
      to: "0x2CFB1C34B5AFD797948A5716DE422128DF3D1553",
      sender: "0x2222222222222222222222222222222222222222".toUpperCase().replace("0X", "0x"),
    };
    expect(validateDepositCollateralTx(tx, expected)).toBe(true);
  });

  it("rejects a reverted tx (status)", () => {
    expect(() =>
      validateDepositCollateralTx({ ...validTx, status: "reverted" }, expected),
    ).toThrow(/status|revert/i);
  });

  it("rejects a tx sent to the wrong contract (to != escrow)", () => {
    expect(() =>
      validateDepositCollateralTx({ ...validTx, to: USDC }, expected),
    ).toThrow(/escrow|to\b/i);
  });

  it("rejects a tx from a sender other than the deal's seller", () => {
    expect(() =>
      validateDepositCollateralTx({ ...validTx, sender: BUYER_EOA }, expected),
    ).toThrow(/seller|sender/i);
  });

  it("rejects calldata that is not depositEscrowCollateral", () => {
    // USDC.approve(escrow, amount) calldata instead of the deposit call.
    const approveInput = encodeFunctionData({
      abi: [
        {
          type: "function", name: "approve", stateMutability: "nonpayable",
          inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }],
          outputs: [{ type: "bool" }],
        },
      ] as const,
      functionName: "approve",
      args: [ESCROW, 10_000_000n],
    });
    expect(() =>
      validateDepositCollateralTx({ ...validTx, input: approveInput }, expected),
    ).toThrow(/function|selector/i);
  });

  it("rejects a deposit for a different on-chain deal id", () => {
    expect(() =>
      validateDepositCollateralTx({ ...validTx, input: depositInput(8n, 10_000_000n) }, expected),
    ).toThrow(/deal/i);
  });

  it("rejects a deposit with the wrong collateral amount", () => {
    expect(() =>
      validateDepositCollateralTx({ ...validTx, input: depositInput(7n, 9_999_999n) }, expected),
    ).toThrow(/amount|collateral/i);
  });

  it("rejects malformed/empty calldata", () => {
    expect(() =>
      validateDepositCollateralTx({ ...validTx, input: "0x" }, expected),
    ).toThrow(/function|selector|calldata/i);
  });
});

// ---------------------------------------------------------------------------
// Schemas (additive permit fields for deals)
// ---------------------------------------------------------------------------

describe("WL deal EOA schemas", () => {
  const DEAL = "550e8400-e29b-41d4-a716-446655440000";
  const R = "0x" + "ab".repeat(32);
  const S = "0x" + "cd".repeat(32);

  it("WlDealConfirmBodySchema accepts a permit + payerAddress (EOA gasless)", () => {
    const r = WlDealConfirmBodySchema.safeParse({
      dealDraftId: DEAL,
      payerAddress: BUYER_EOA,
      permit: { v: 28, r: R, s: S, deadline: "1700001800" },
    });
    expect(r.success).toBe(true);
  });

  it("WlDealConfirmBodySchema still accepts the legacy approve-tx body", () => {
    const r = WlDealConfirmBodySchema.safeParse({
      dealDraftId: DEAL,
      approveTxHash: "0x" + "1".repeat(64),
    });
    expect(r.success).toBe(true);
  });

  it("WlDealConfirmBodySchema rejects an incomplete permit", () => {
    const r = WlDealConfirmBodySchema.safeParse({
      dealDraftId: DEAL,
      permit: { v: 28, r: R, deadline: "1700001800" },
    });
    expect(r.success).toBe(false);
  });

  it("WlDealPermitPayloadBodySchema requires a valid payerAddress", () => {
    expect(WlDealPermitPayloadBodySchema.safeParse({ payerAddress: BUYER_EOA }).success).toBe(true);
    expect(WlDealPermitPayloadBodySchema.safeParse({}).success).toBe(false);
    expect(WlDealPermitPayloadBodySchema.safeParse({ payerAddress: "nope" }).success).toBe(false);
  });

  it("WlDealCollateralEoaBodySchema requires depositTxHash + collateralUsdc", () => {
    const ok = WlDealCollateralEoaBodySchema.safeParse({
      depositTxHash: "0x" + "2".repeat(64),
      collateralUsdc: "10",
    });
    expect(ok.success).toBe(true);
    expect(WlDealCollateralEoaBodySchema.safeParse({ collateralUsdc: "10" }).success).toBe(false);
    expect(
      WlDealCollateralEoaBodySchema.safeParse({ depositTxHash: "0x123", collateralUsdc: "10" }).success,
    ).toBe(false);
    expect(
      WlDealCollateralEoaBodySchema.safeParse({ depositTxHash: "0x" + "2".repeat(64), collateralUsdc: "-1" }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Payer resolution for deals (reuses the generic resolveConfirmPayer)
// ---------------------------------------------------------------------------

describe("deal payer resolution — resolveConfirmPayer reused for WL deals", () => {
  const UCW = "0x3333333333333333333333333333333333333333";
  const sig = { v: 28, r: "0x" + "ab".repeat(32), s: "0x" + "cd".repeat(32), deadline: "1700001800" };

  it("permit + payerAddress → eoa (gasless permit funding)", () => {
    expect(resolveConfirmPayer({ userWalletAddress: UCW, payerAddress: BUYER_EOA, permit: sig }))
      .toEqual({ payerWalletType: "eoa", payerAddress: BUYER_EOA.toLowerCase() });
  });

  it("payerAddress + verified approve tx (direct approve fallback from the EOA) → eoa", () => {
    expect(resolveConfirmPayer({ userWalletAddress: UCW, payerAddress: BUYER_EOA, payerProof: "approve-tx" }))
      .toEqual({ payerWalletType: "eoa", payerAddress: BUYER_EOA.toLowerCase() });
  });

  it("payerAddress without proof → 422 (IDOR guard)", () => {
    expect(() => resolveConfirmPayer({ userWalletAddress: UCW, payerAddress: BUYER_EOA })).toThrow(/payer/i);
  });

  it("no permit + no payerAddress → ucw (default Circle challenge path)", () => {
    expect(resolveConfirmPayer({ userWalletAddress: UCW }))
      .toEqual({ payerWalletType: "ucw", payerAddress: UCW.toLowerCase() });
  });
});
