import crypto from "crypto";
import { randomUUID } from "crypto";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { parseUsdc } from "@/lib/money";
import { circleDeveloperSdk } from "./client";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";

/**
 * Circle On-Ramp integration for fiat → USDC top-up.
 *
 * This module provides:
 *   - createOnRampSession: Creates a Circle-hosted on-ramp checkout session
 *   - verifyOnRampWebhook: Verifies webhook signatures from Circle
 *   - handleOnRampCallback: Processes completed on-ramp transactions
 *
 * Flow:
 *   1. User initiates on-ramp via POST /api/wallet/onramp/session
 *   2. Frontend redirects to Circle-hosted checkout URL
 *   3. User completes fiat payment (card/bank transfer)
 *   4. Circle sends webhook to POST /api/wallet/onramp/webhook
 *   5. Webhook credits user wallet via credit_wallet_atomic RPC
 *
 * @deprecated session minting moved to Circle's Arc App Kit Onramp
 * (`lib/circle/app-kit.ts`, `/api/wallet/onramp/session`), which mints the
 * session via `createSessionRouteHandler` and delivers USDC straight to the
 * user's wallet on Arc. `createOnRampSession` below is no longer called by the
 * session route.
 *
 * What remains live here: the WEBHOOK side (`verifyOnRampWebhook` +
 * `handleOnRampCallback`), used by `/api/wallet/onramp/webhook`. Keep it for
 * the legacy/mock path; delete in the next cleanup wave once App Kit onramp is
 * proven on testnet.
 *
 * Money = bigint micro-USDC.
 */

const ONRAMP_API_URL = "https://onramp-api.circle.com/v1";

export interface OnRampSessionParams {
  userId: string;
  walletAddress: string;
  amount: string; // USDC amount (human-readable, e.g., "100.00")
  currency: "USD" | "EUR" | "GBP";
}

export interface OnRampSessionResult {
  url: string;
  sessionId: string;
  walletTxId: string;
}

export interface OnRampWebhookPayload {
  sessionId: string;
  status: "pending" | "complete" | "failed";
  amount: string;
  walletAddress: string;
  txHash?: string;
}

/**
 * Determine if we should use mock mode for on-ramp.
 * In development, mock is used unless explicitly disabled.
 */
export function onrampUseMock(): boolean {
  if (process.env.NODE_ENV === "production") {
    if (process.env.CIRCLE_PAYMENTS_MOCK !== "0") {
      console.error("FATAL: CIRCLE_PAYMENTS_MOCK must be '0' in production");
    }
    return false;
  }
  return process.env.CIRCLE_PAYMENTS_MOCK !== "0" || !circleDeveloperSdk;
}

/**
 * Create a Circle On-Ramp session.
 *
 * Returns a hosted URL where the user can complete their fiat → USDC purchase.
 * The session is linked to a pending wallet_tx row for webhook matching.
 */
export async function createOnRampSession(
  params: OnRampSessionParams
): Promise<OnRampSessionResult> {
  const { userId, walletAddress, amount, currency } = params;

  // Parse and validate the USDC amount
  const amountMicro = parseUsdc(amount);
  if (amountMicro <= 0n) throw new Error("amount must be positive");

  const admin = supabaseAdminClient();

  // Find user's wallet
  const { data: wallet, error: wErr } = await admin
    .from("wallets")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  if (wErr || !wallet) throw new Error("wallet not found for user");

  const idempotencyKey = randomUUID();
  const sessionId = randomUUID();

  // Create pending wallet_tx for tracking
  const { data: txRow, error: txErr } = await admin
    .from("wallet_txs")
    .insert({
      wallet_id: wallet.id,
      type: "in",
      label: "On-Ramp",
      sub: `Circle · ${currency}`,
      amount: amountMicro,
      status: "pending",
      method: "card", // Circle on-ramp primarily uses card
      fiat_amount: Math.round(parseFloat(amount) * 100), // rough cents
      fiat_currency: currency,
      idempotency_key: idempotencyKey,
      circle_tx_id: sessionId, // use sessionId as early reference
    })
    .select("id")
    .single();

  if (txErr || !txRow) {
    throw new Error(`insert wallet_tx failed: ${txErr?.message}`);
  }

  let url: string;

  if (onrampUseMock()) {
    // Dev-mock: return synthetic URL
    url = `https://mock.circle.com/onramp/${sessionId}?wallet=${walletAddress}&amount=${amount}`;
  } else {
    // Real Circle On-Ramp API call
    const response = await fetch(`${ONRAMP_API_URL}/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
        "X-Request-Id": idempotencyKey,
      },
      body: JSON.stringify({
        walletAddress,
        amount: {
          amount: amount,
          currency: currency,
        },
        redirectUrl: `${process.env.NEXT_PUBLIC_APP_URL}/wallet?onramp=complete`,
        metadata: {
          walletTxId: txRow.id,
          userId,
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      // Mark tx as failed
      await admin.from("wallet_txs").update({ status: "failed" }).eq("id", txRow.id);
      throw new Error(`Circle on-ramp session failed: ${data.message}`);
    }

    url = data.data?.url;
    if (!url) {
      await admin.from("wallet_txs").update({ status: "failed" }).eq("id", txRow.id);
      throw new Error("Circle on-ramp returned no URL");
    }
  }

  return {
    url,
    sessionId,
    walletTxId: txRow.id,
  };
}

/**
 * Verify Circle On-Ramp webhook signature.
 *
 * Uses Circle's public key to verify the request signature.
 * The signature is base64-encoded and verified against the raw body.
 */
export async function verifyOnRampWebhook(
  signature: string,
  body: string,
  keyId?: string
): Promise<boolean> {
  if (!keyId) {
    // In production, keyId is required.
    if (process.env.NODE_ENV === "production") {
      console.error("Circle on-ramp webhook: missing keyId");
      return false;
    }
    // dev-only bypass, kept for the mock path. Log loudly: an
    // unverified webhook can move balances, so this must never be quiet.
    console.warn(
      "Circle on-ramp webhook: DEV BYPASS — signature NOT verified (no keyId, non-production). Never allow this in production.",
    );
    return signature.length > 0;
  }

  try {
    // Fetch Circle's public key for verification
    const publicKey = await getCirclePublicKey(keyId);
    const verifier = crypto.createVerify("SHA256");
    verifier.update(body);
    verifier.end();
    const signatureBuffer = Buffer.from(signature, "base64");
    return verifier.verify(publicKey, signatureBuffer);
  } catch (e) {
    console.error("Circle on-ramp webhook: signature verification failed:", e);
    return false;
  }
}

/**
 * Fetch Circle's public key for webhook signature verification.
 */
async function getCirclePublicKey(keyId: string): Promise<string> {
  const response = await fetch(
    `https://api.circle.com/v2/notifications/publicKey/${keyId}`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${process.env.CIRCLE_API_KEY}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch Circle public key: ${response.statusText}`);
  }

  const data = await response.json();
  const rawPublicKey = data?.data?.publicKey;
  if (typeof rawPublicKey !== "string") {
    throw new Error("Invalid public key format from Circle");
  }

  // Format as PEM
  return [
    "-----BEGIN PUBLIC KEY-----",
    ...(rawPublicKey.match(/.{1,64}/g) ?? []),
    "-----END PUBLIC KEY-----",
  ].join("\n");
}

/**
 * Handle Circle On-Ramp callback/webhook.
 *
 * Processes completed on-ramp transactions:
 *   1. Matches the session to a pending wallet_tx
 *   2. Credits the user's wallet atomically
 *   3. Updates transaction status
 *
 * Idempotent by design — can be called multiple times safely.
 */
export async function handleOnRampCallback(
  payload: OnRampWebhookPayload
): Promise<{ success: boolean; walletTxId?: string; error?: string }> {
  const { sessionId, status, amount, walletAddress, txHash } = payload;

  const admin = supabaseAdminClient();

  // Find the pending wallet_tx by circle_tx_id (sessionId)
  const { data: tx, error: txErr } = await admin
    .from("wallet_txs")
    .select("id, wallet_id, status, type, amount")
    .eq("circle_tx_id", sessionId)
    .eq("type", "in")
    .maybeSingle();

  if (txErr) {
    console.error("On-ramp callback: lookup wallet_tx failed:", txErr.message);
    return { success: false, error: txErr.message };
  }

  if (!tx) {
    // No matching pending tx — might be a duplicate or unrelated webhook
    console.warn(`On-ramp callback: no wallet_tx found for session ${sessionId}`);
    return { success: true }; // Not an error, just skip
  }

  if (tx.status !== "pending") {
    // Already processed — idempotent skip
    console.log(`On-ramp callback: wallet_tx ${tx.id} already ${tx.status}`);
    return { success: true, walletTxId: tx.id };
  }

  // Handle failed status
  if (status === "failed") {
    await admin.from("wallet_txs").update({ status: "failed" }).eq("id", tx.id);
    console.log(`On-ramp callback: wallet_tx ${tx.id} marked failed`);
    return { success: true, walletTxId: tx.id };
  }

  // Only process complete status
  if (status !== "complete") {
    console.log(`On-ramp callback: session ${sessionId} status ${status} — skip`);
    return { success: true };
  }

  // Parse the USDC amount from the webhook
  let amountMicro: bigint;
  try {
    amountMicro = parseUsdc(amount);
  } catch (e) {
    console.error(`On-ramp callback: failed to parse amount "${amount}":`, e);
    await admin.from("wallet_txs").update({ status: "failed" }).eq("id", tx.id);
    return { success: false, error: "Invalid amount format" };
  }

  if (amountMicro <= 0n) {
    console.warn(`On-ramp callback: non-positive amount for session ${sessionId}`);
    return { success: false, error: "Non-positive amount" };
  }

  // Verify wallet address matches (optional security check)
  const { data: wallet } = await admin
    .from("wallets")
    .select("address")
    .eq("id", tx.wallet_id)
    .maybeSingle();

  if (wallet && wallet.address && walletAddress) {
    if (wallet.address.toLowerCase() !== walletAddress.toLowerCase()) {
      console.error(
        `On-ramp callback: wallet address mismatch. Expected ${wallet.address}, got ${walletAddress}`
      );
      await admin.from("wallet_txs").update({ status: "failed" }).eq("id", tx.id);
      return { success: false, error: "Wallet address mismatch" };
    }
  }

  // Credit the wallet.

  // ONCHAIN_WALLET_FUNDS=1: Circle's on-ramp settles USDC directly on-chain to
  // the user's UCW address, so the DB ledger must NOT be credited (it is only a
  // mirror). Mark the row done and record the on-chain hash.

  // Legacy: post the ledger (DR external_fiat, CR user_wallet), bump balance,
  // and apply a 72h chargeback holding window.
  if (!ONCHAIN_FUNDS_ENABLED) {
    const { error: creditErr } = await admin.rpc("credit_wallet_atomic", {
      p_wallet_id: tx.wallet_id,
      p_amount: amountMicro.toString(),
      p_ref_id: tx.id,
      p_wallet_tx_id: tx.id,
      p_holding_hours: 72,
    });

    if (creditErr) {
      console.error(
        `On-ramp callback: credit_wallet_atomic failed for ${sessionId}:`,
        creditErr.message
      );
      await admin.from("wallet_txs").update({ status: "failed" }).eq("id", tx.id);
      return { success: false, error: creditErr.message };
    }
  } else {
    // Mirror-only: funds already on-chain in the UCW.
    await admin.from("wallet_txs").update({ status: "done" }).eq("id", tx.id);
  }

  // Update txHash if provided
  if (txHash) {
    await admin
      .from("wallet_txs")
      .update({ arc_tx_hash: txHash })
      .eq("id", tx.id);
  }

  console.log(
    `On-ramp callback: credited ${amountMicro.toString()} micro-USDC to wallet ${tx.wallet_id} (tx ${tx.id})`
  );

  return { success: true, walletTxId: tx.id };
}

/**
 * Generate a mock on-ramp completion payload for development testing.
 */
export function createMockOnRampPayload(
  sessionId: string,
  amount: string,
  walletAddress: string
): OnRampWebhookPayload {
  return {
    sessionId,
    status: "complete",
    amount,
    walletAddress,
    txHash: `0x${randomUUID().replace(/-/g, "")}`,
  };
}
