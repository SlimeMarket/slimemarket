import { NextResponse } from "next/server";
import { handleOnRampCallback, verifyOnRampWebhook } from "@/lib/circle/onramp";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import crypto from "crypto";

/**
 * POST /api/wallet/onramp/webhook
 *
 * Circle On-Ramp webhook receiver.
 *
 * Handles callbacks from Circle when a fiat → USDC on-ramp transaction
 * completes. Verifies the signature, processes the transaction, and
 * credits the user's wallet.
 *
 * Headers:
 *   - circle-signature: Base64-encoded signature of the request body
 *   - circle-key-id: Key ID for looking up Circle's public key
 *
 * Body: Circle On-Ramp webhook payload
 *   - sessionId: The on-ramp session identifier
 *   - status: "pending" | "complete" | "failed"
 *   - amount: USDC amount (decimal string, e.g., "100.00")
 *   - walletAddress: Destination wallet address
 *   - txHash: Optional blockchain transaction hash
 *
 * Security:
 *   - Signature verification using Circle's public key
 *   - Idempotency via webhook_events dedupe
 *   - Ownership validation via circle_tx_id lookup
 */

interface OnRampWebhookBody {
  sessionId: string;
  status: "pending" | "complete" | "failed";
  amount: string;
  walletAddress: string;
  txHash?: string;
  [key: string]: unknown;
}

function generateDedupeHash(bodyString: string): string {
  return crypto.createHash("sha256").update(bodyString).digest("hex");
}

async function logWebhookEvent(
  bodyString: string,
  payload: OnRampWebhookBody,
  signatureValid: boolean
): Promise<{ deduped: boolean }> {
  const dedupeHash = generateDedupeHash(bodyString);
  const admin = supabaseAdminClient();

  const { error } = await admin.from("webhook_events").insert({
    circle_event_id: payload.sessionId,
    circle_transaction_id: payload.txHash || payload.sessionId,
    notification_type: "onramp",
    mapped_status: payload.status,
    signature_valid: signatureValid,
    dedupe_hash: dedupeHash,
    raw_payload: payload,
    processed_at: new Date().toISOString(),
  });

  if (error) {
    if (error.code === "23505") {
      // Unique constraint on dedupe_hash — already processed
      return { deduped: true };
    }
    console.error("On-ramp webhook: failed to log event:", error);
  }

  return { deduped: false };
}

export async function POST(req: Request) {
  try {
    // Get signature headers
    const signature = req.headers.get("circle-signature") || "";
    const keyId = req.headers.get("circle-key-id") || undefined;

    // Read raw body for signature verification
    const rawBody = await req.text();

    let body: OnRampWebhookBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Validate required fields
    if (!body.sessionId) {
      return NextResponse.json(
        { error: "Missing sessionId" },
        { status: 422 }
      );
    }
    if (!body.status) {
      return NextResponse.json(
        { error: "Missing status" },
        { status: 422 }
      );
    }
    if (!body.amount) {
      return NextResponse.json(
        { error: "Missing amount" },
        { status: 422 }
      );
    }
    if (!body.walletAddress) {
      return NextResponse.json(
        { error: "Missing walletAddress" },
        { status: 422 }
      );
    }

    // Verify signature
    const isVerified = await verifyOnRampWebhook(signature, rawBody, keyId);
    if (!isVerified) {
      console.warn("On-ramp webhook: signature verification failed");
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }

    // Log webhook event (with deduplication)
    const { deduped } = await logWebhookEvent(rawBody, body, isVerified);
    if (deduped) {
      console.log(
        `On-ramp webhook: event already processed (sessionId=${body.sessionId})`
      );
      return NextResponse.json({ received: true, deduped: true }, { status: 200 });
    }

    console.log("On-ramp webhook notification:", {
      sessionId: body.sessionId,
      status: body.status,
      amount: body.amount,
      walletAddress: body.walletAddress,
    });

    // Process the callback
    const result = await handleOnRampCallback(body);

    if (!result.success) {
      console.error(
        `On-ramp webhook: failed to process session ${body.sessionId}:`,
        result.error
      );
      // Return 200 anyway to acknowledge receipt (Circle will not retry on 5xx)
      return NextResponse.json(
        { received: true, processed: false, error: result.error },
        { status: 200 }
      );
    }

    return NextResponse.json(
      { received: true, processed: true, walletTxId: result.walletTxId },
      { status: 200 }
    );
  } catch (error) {
    console.error("On-ramp webhook: failed to process:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to process notification: ${message}` },
      { status: 500 }
    );
  }
}

/**
 * HEAD handler for endpoint reachability check.
 * Circle may probe the endpoint with HEAD to verify it's accessible.
 */
export async function HEAD() {
  return NextResponse.json({}, { status: 200 });
}
