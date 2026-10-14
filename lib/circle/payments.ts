import { randomBytes, randomUUID } from "crypto";
import { circleDeveloperSdk } from "./client";

/**
 * Circle Payments API client (on-ramp / off-ramp).
 *
 * M1 SCOPE: dev-mock only. Real Circle Payments API integration is M7.
 * The dev-mock returns synthetic redirect URLs and IDs so the frontend flow
 * can be exercised end-to-end without a Circle Payments account.
 *
 * Mock detection: dev-mock is used when EITHER
 *   - `CIRCLE_PAYMENTS_MOCK !== "0"` (default — explicit opt-in stays mocked), OR
 *   - `circleDeveloperSdk` is null (CIRCLE_API_KEY / CIRCLE_ENTITY_SECRET unset).
 * This lets wallet provisioning run against a real Circle key while payments stay
 * mocked, avoiding the M0-era trap where setting CIRCLE_API_KEY flipped payments
 * into a code path that throws "not implemented (M7)".
 * Real path (M7) will hit `https://api.circle.com/v2/payments` and
 * `https://api.circle.com/v2/payouts`; it requires payout destinations registered
 * in the Circle Console + a live webhook endpoint.
 */

/** True when payments should be served from the dev-mock. */
export function paymentsUseMock(): boolean {
  // Production MUST have CIRCLE_PAYMENTS_MOCK="0" and a configured SDK.
  if (process.env.NODE_ENV === "production") {
    if (process.env.CIRCLE_PAYMENTS_MOCK !== "0") {
      console.error("FATAL: CIRCLE_PAYMENTS_MOCK must be '0' in production");
    }
    return false; // never use mock in production
  }
  // Default to mock unless explicitly disabled with "0", AND the SDK is configured.
  return process.env.CIRCLE_PAYMENTS_MOCK !== "0" || !circleDeveloperSdk;
}

export interface TopupIntentInput {
  amountMicroUsdc: bigint;
  method: "qris" | "card" | "bank";
  currency: string; // "IDR" | "USD"
  walletTxId: string;
  idempotencyKey: string;
}

export interface TopupIntentResult {
  redirectUrl: string;
  circlePaymentId: string;
}

export interface PayoutInput {
  amountMicroUsdc: bigint;
  bankAccountId: string;
  walletTxId: string;
  idempotencyKey: string;
}

export interface PayoutResult {
  circlePayoutId: string;
  status: "pending" | "complete" | "failed";
}

/**
 * Create a Circle hosted payment intent (on-ramp). Dev-mock returns mock URL.
 *
 * the REAL branch is intentionally disabled. It used to POST
 * `amount: { amount: <micro-USDC as a decimal string> }` to
 * `api.circle.com/v2/payments`, and its caller passed `0n` because the USDC
 * amount is only known after the fiat payment settles. That is not a payment
 * intent, it is a zero-amount request — it could only ever fail or mischarge.
 *
 * Fiat → USDC is now owned by Circle's Arc App Kit Onramp (see
 * `lib/circle/app-kit.ts` + `/api/wallet/onramp/session`), which handles KYC,
 * payment and on-chain delivery in one hosted widget. Rather than ship a
 * silently broken second path, this throws. The dev-mock branch stays so local
 * flows and the `simulate-topup` helper keep working.
 */
export async function createTopupIntent(
  input: TopupIntentInput
): Promise<TopupIntentResult> {
  if (paymentsUseMock()) {
    const mockId = `mock-pay-${randomBytes(8).toString("hex")}`;
    return {
      redirectUrl: `https://mock.circle.com/pay/${mockId}?wt=${input.walletTxId}`,
      circlePaymentId: mockId,
    };
  }

  const err = new Error(
    "Fiat top-up via the Circle Payments API is not available — use the Arc App Kit onramp (/api/wallet/onramp/session).",
  ) as Error & { code: string };
  err.code = "SUPERSEDED_BY_ONRAMP";
  throw err;
}

/** Create a Circle payout (off-ramp to bank). Dev-mock returns simulated complete. */
export async function createPayout(input: PayoutInput): Promise<PayoutResult> {
  if (paymentsUseMock()) {
    return {
      circlePayoutId: `mock-payout-${randomUUID().slice(0, 8)}`,
      status: "complete",
    };
  }

  const resp = await fetch("https://api.circle.com/v2/payouts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
      "X-Request-Id": input.idempotencyKey,
    },
    body: JSON.stringify({
      source: { type: "wallet", id: process.env.PLATFORM_CIRCLE_WALLET_ID },
      destination: { type: "bank_account", id: input.bankAccountId },
      amount: { amount: input.amountMicroUsdc.toString(), currency: "USD" },
      metadata: { walletTxId: input.walletTxId },
    }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(`Circle payout failed: ${data.message}`);

  return {
    circlePayoutId: data.data?.id,
    status: data.data?.status ?? "pending",
  };
}
