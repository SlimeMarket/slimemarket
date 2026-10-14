import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * crypto-withdraw mock-mode gating .
 *
 * Bug: initiateCryptoWithdraw decided "real Circle transfer" only from
 * `circleDeveloperSdk && circle_wallet_id && !mock- prefix`. Dev-login
 * wallets carry REAL UUIDs (not mock- prefixes) while CIRCLE_PAYMENTS_MOCK=1,
 * so the code hit Circle's API with a user wallet id → "Cannot find target
 * wallet" → funds debited then thrown. The gate must also honor the
 * CIRCLE_PAYMENTS_MOCK flag, matching lib/circle/payments.ts semantics.
 */
import { shouldAttemptCircleTransfer } from "@/lib/wallet/crypto-withdraw";

describe("shouldAttemptCircleTransfer", () => {
  const originalEnv = process.env.CIRCLE_PAYMENTS_MOCK;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CIRCLE_PAYMENTS_MOCK;
    else process.env.CIRCLE_PAYMENTS_MOCK = originalEnv;
  });

  it("returns false in mock mode (CIRCLE_PAYMENTS_MOCK=1) even with SDK + real-looking wallet", () => {
    process.env.CIRCLE_PAYMENTS_MOCK = "1";
    expect(
      shouldAttemptCircleTransfer({ sdkReady: true, circleWalletId: "8c498b76-bbc0-5d79-afba-dd3ac900f8d3" }),
    ).toBe(false);
  });

  it("returns false when CIRCLE_PAYMENTS_MOCK unset (default = mock)", () => {
    delete process.env.CIRCLE_PAYMENTS_MOCK;
    expect(
      shouldAttemptCircleTransfer({ sdkReady: true, circleWalletId: "8c498b76-bbc0-5d79-afba-dd3ac900f8d3" }),
    ).toBe(false);
  });

  it("returns true only when real mode (CIRCLE_PAYMENTS_MOCK=0) + SDK + real wallet id", () => {
    process.env.CIRCLE_PAYMENTS_MOCK = "0";
    expect(
      shouldAttemptCircleTransfer({ sdkReady: true, circleWalletId: "8c498b76-bbc0-5d79-afba-dd3ac900f8d3" }),
    ).toBe(true);
  });

  it("returns false in real mode without SDK", () => {
    process.env.CIRCLE_PAYMENTS_MOCK = "0";
    expect(
      shouldAttemptCircleTransfer({ sdkReady: false, circleWalletId: "8c498b76-bbc0-5d79-afba-dd3ac900f8d3" }),
    ).toBe(false);
  });

  it("returns false in real mode with a mock- prefixed wallet", () => {
    process.env.CIRCLE_PAYMENTS_MOCK = "0";
    expect(
      shouldAttemptCircleTransfer({ sdkReady: true, circleWalletId: "mock-dev-token-x" }),
    ).toBe(false);
  });

  it("returns false in real mode with no wallet id", () => {
    process.env.CIRCLE_PAYMENTS_MOCK = "0";
    expect(shouldAttemptCircleTransfer({ sdkReady: true, circleWalletId: null })).toBe(false);
  });
});
