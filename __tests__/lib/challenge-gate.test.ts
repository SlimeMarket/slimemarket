import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { shouldMockChallenge } from "@/lib/wallet/challenge-gate";

/**
 * Challenge-gate mock bypass (.A1, BUG 1).
 *
 * Bug: the four challenge routes keyed their mock short-circuit on
 * `userToken.startsWith("dev-token-")`. Browser users log in via REAL Circle
 * UCW OTP, so they carry a real userToken → bypass never fired → Circle
 * rejected the user wallet ("Cannot find target wallet in the system") → 500
 * on WL proceed, WL buyer challenge, and marketplace checkout.
 *
 * Fix: `shouldMockChallenge` keys the bypass on ENV (NODE_ENV, FORCE_REAL_UCW,
 * CIRCLE_PAYMENTS_MOCK) + wallet shape, not on token shape. These tests pin
 * the decision table.
 *
 * NOTE: canFundOnChain() reads PLATFORM_CIRCLE_WALLET_ID at CALL time (* hardening), so plain static imports + process.env stubs work — no module
 * reset/dynamic-import dance needed (that pattern flaked under load).
 */

const ENV_KEYS = [
  "NODE_ENV",
  "FORCE_REAL_UCW",
  "CIRCLE_PAYMENTS_MOCK",
  "PLATFORM_CIRCLE_WALLET_ID",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Baseline: non-production dev environment. (NODE_ENV is typed read-only on
  // process.env, so it must go through vi.stubEnv; the others are plain.)
  vi.stubEnv("NODE_ENV", "development");
  process.env.FORCE_REAL_UCW = "false";
  process.env.PLATFORM_CIRCLE_WALLET_ID = "plat-wallet";
});

afterEach(() => {
  // vi.unstubAllEnvs restores NODE_ENV (it was set via vi.stubEnv).
  vi.unstubAllEnvs();
  for (const k of ENV_KEYS) {
    if (k === "NODE_ENV") continue; // typed read-only; handled by unstubAllEnvs
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

const REAL_TOKEN = "user-token:real-otp-abc123";
const DEV_TOKEN = "dev-token-test-user";
const FUNDABLE_WALLET = "8c498b76-bbc0-5d79-afba-dd3ac900f8d3";

describe("shouldMockChallenge", () => {
  it("production → always false (real token, mock mode on)", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.CIRCLE_PAYMENTS_MOCK = "1";
    expect(shouldMockChallenge({ userToken: DEV_TOKEN, circleWalletId: "mock-wallet" })).toBe(false);
    expect(shouldMockChallenge({ userToken: REAL_TOKEN, circleWalletId: FUNDABLE_WALLET })).toBe(false);
  });

  it("FORCE_REAL_UCW=true → false even with dev token + mock mode", () => {
    process.env.FORCE_REAL_UCW = "true";
    process.env.CIRCLE_PAYMENTS_MOCK = "1";
    expect(shouldMockChallenge({ userToken: DEV_TOKEN, circleWalletId: FUNDABLE_WALLET })).toBe(false);
  });

  it("dev-token session → true (mock wallet id)", () => {
    process.env.CIRCLE_PAYMENTS_MOCK = "0";
    expect(shouldMockChallenge({ userToken: DEV_TOKEN, circleWalletId: "mock-wallet-1" })).toBe(true);
  });

  it("mock- prefixed wallet id → true even with real token + real mode", () => {
    process.env.CIRCLE_PAYMENTS_MOCK = "0";
    expect(shouldMockChallenge({ userToken: REAL_TOKEN, circleWalletId: "mock-browser-wallet" })).toBe(true);
  });

  it("missing wallet id → true", () => {
    process.env.CIRCLE_PAYMENTS_MOCK = "0";
    expect(shouldMockChallenge({ userToken: REAL_TOKEN, circleWalletId: null })).toBe(true);
    expect(shouldMockChallenge({ userToken: REAL_TOKEN, circleWalletId: undefined })).toBe(true);
  });

  it("no platform wallet configured → true (nothing real to challenge)", () => {
    process.env.CIRCLE_PAYMENTS_MOCK = "0";
    delete process.env.PLATFORM_CIRCLE_WALLET_ID;
    expect(shouldMockChallenge({ userToken: REAL_TOKEN, circleWalletId: FUNDABLE_WALLET })).toBe(true);
  });

  it("CIRCLE_PAYMENTS_MOCK unset (default) + real browser session → true", () => {
    delete process.env.CIRCLE_PAYMENTS_MOCK;
    expect(shouldMockChallenge({ userToken: REAL_TOKEN, circleWalletId: FUNDABLE_WALLET })).toBe(true);
  });

  it("CIRCLE_PAYMENTS_MOCK='0' + real token + fundable wallet → false (real challenge)", () => {
    process.env.CIRCLE_PAYMENTS_MOCK = "0";
    expect(shouldMockChallenge({ userToken: REAL_TOKEN, circleWalletId: FUNDABLE_WALLET })).toBe(false);
  });
});

/**
 * BUG 2 companion: zero-collateral WL deals. The collateral body schemas must
 * accept "0" (needsCollateral=false) while other money schemas stay > 0.
 */
import {
  UsdcAmountOrZeroSchema,
  UsdcAmountSchema,
  WlCollateralChallengeBodySchema,
  WlCollateralProceedBodySchema,
} from "@/lib/schemas";

describe("UsdcAmountOrZeroSchema", () => {
  it("accepts '0' and positive decimals", () => {
    expect(UsdcAmountOrZeroSchema.safeParse("0").success).toBe(true);
    expect(UsdcAmountOrZeroSchema.safeParse("0.00").success).toBe(true);
    expect(UsdcAmountOrZeroSchema.safeParse("1.50").success).toBe(true);
  });

  it("rejects negatives, garbage, and empty", () => {
    expect(UsdcAmountOrZeroSchema.safeParse("-1").success).toBe(false);
    expect(UsdcAmountOrZeroSchema.safeParse("abc").success).toBe(false);
    expect(UsdcAmountOrZeroSchema.safeParse("").success).toBe(false);
  });
});

describe("collateral body schemas accept zero", () => {
  it("WlCollateralChallengeBodySchema accepts collateralUsdc '0'", () => {
    expect(WlCollateralChallengeBodySchema.safeParse({ collateralUsdc: "0" }).success).toBe(true);
    expect(WlCollateralChallengeBodySchema.safeParse({ collateralUsdc: "10" }).success).toBe(true);
  });

  it("WlCollateralProceedBodySchema accepts collateralUsdc '0'", () => {
    expect(WlCollateralProceedBodySchema.safeParse({ collateralUsdc: "0" }).success).toBe(true);
  });

  it("UsdcAmountSchema (checkout amounts) still rejects 0", () => {
    expect(UsdcAmountSchema.safeParse("0").success).toBe(false);
    expect(UsdcAmountSchema.safeParse("1.00").success).toBe(true);
  });
});
