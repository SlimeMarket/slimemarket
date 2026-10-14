import { NextRequest, NextResponse } from "next/server";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { parseUsdc } from "@/lib/money";
import {
  generateDedupeHash,
  isIpAllowed,
  verifyCircleSignature,
} from "@/lib/circle/webhook-verify";

/**
 * POST /api/webhooks/circle
 *
 * Circle webhook receiver. Verifies the request signature against Circle's public
 * key (fetched by keyId), dedupes via sha256(raw body), logs every event, and
 * dispatches to handlers based on notificationType.
 *
 * Pattern from arc-commerce/app/api/circle/webhook/route.ts. For M0 the handlers
 * are stubs that just log — actual credit/ledger logic lands in M1 (fiat ramp).
 *
 * Security:
 *   - Signature verification is MANDATORY (x-circle-signature + x-circle-key-id).
 *   - Idempotency via webhook_events.dedupe_hash unique constraint.
 *   - HEAD returns 200 for Circle's endpoint reachability check.
 */

type CircleNotification = {
  id?: string;
  state?: string;
  walletId?: string;
  contractAddress?: string;
  blockchain?: string;
  amounts?: string[];
  txHash?: string;
  [k: string]: unknown;
};

interface CircleWebhookPayload {
  subscriptionId: string;
  notificationId: string;
  notificationType: string;
  notification: CircleNotification;
  timestamp: string;
  version: number;
  [k: string]: unknown;
}

function mapCircleStateToStatus(
  circleState: string | undefined
): "pending" | "confirmed" | "failed" | "complete" | null {
  if (!circleState) return null;
  const stateMap: Record<string, "pending" | "confirmed" | "failed" | "complete"> = {
    QUEUED: "pending",
    SENT: "pending",
    PENDING: "pending",
    CONFIRMED: "confirmed",
    COMPLETE: "complete",
    FAILED: "failed",
  };
  return stateMap[circleState] ?? null;
}

async function logWebhookEvent(
  bodyString: string,
  rawPayload: CircleWebhookPayload,
  circleEventId: string | undefined,
  circleTransactionId: string | undefined,
  mappedStatus: string | null,
  signatureValid: boolean
): Promise<{ deduped: boolean }> {
  const dedupeHash = generateDedupeHash(bodyString);
  const admin = supabaseAdminClient();
  const { error } = await admin.from("webhook_events").insert({
    circle_event_id: circleEventId || null,
    circle_transaction_id: circleTransactionId || null,
    notification_type: rawPayload.notificationType,
    mapped_status: mappedStatus || null,
    signature_valid: signatureValid,
    dedupe_hash: dedupeHash,
    raw_payload: rawPayload,
    processed_at: new Date().toISOString(),
  });
  if (error) {
    if (error.code === "23505") {
      // unique constraint on dedupe_hash — already processed
      return { deduped: true };
    }
    console.error("Circle webhook: failed to log event:", error);
  }
  return { deduped: false };
}

/**
 * Notification types that indicate an inbound USDC credit settled.
 *
 * ⚠️ These strings MUST come from Circle's `NotificationType` enum
 * (`@circle-fin/developer-controlled-wallets` → NotificationType). The previous
 * values — `"payments"` and `"wallets/transactions"` — are NOT Circle
 * notification types at all. `isTopup` was therefore never true, so every
 * inbound transfer fell through to the "unhandled notificationType" log and
 * **no top-up was ever credited**. The string that actually arrives is
 * `transactions.inbound`.
 *
 * `transactions.inbound` carries a transaction object, so `notification.state`
 * is one of QUEUED / SENT / PENDING / CONFIRMED / COMPLETE / FAILED — exactly
 * what `mapCircleStateToStatus` understands.
 *
 * App Kit Onramp is NOT in this set on purpose: the widget delivers
 * USDC straight to the user's wallet on Arc, so in non-custodial mode the
 * balance is read from the chain (`onChainBalance`) and the DB is only a
 * mirror. There is no synchronous credit to trigger. Gateway/CCTP events
 * (`gateway.deposit.finalized`, `gateway.mint.finalized`) are logged as
 * unhandled by `dispatchEvent` rather than silently dropped.
 */
const SETTLED_TRANSFER_TYPES = new Set([
  "transactions.inbound",
  "transactions.outbound",
]);

/**
 * M1 dispatch handler. Credits the user's wallet when a top-up / inbound USDC
 * transfer settles (state CONFIRMED or COMPLETE), matching the pending
 * `wallet_txs` row via `circle_tx_id`.
 *
 * Idempotent by design:
 *   - webhook_events dedupe happens upstream (before dispatch is called).
 *   - credit_wallet_atomic is a no-op if wallet_tx.status != 'pending'.
 *
 * Failures here must NOT crash the webhook (200 ack to Circle); they are logged
 * and surfaced via the wallet_tx 'failed' status. A reconciliation job (M7) can
 * retry based on webhook_events rows.
 */
/**
 * Promote a user-initiated SEND to `done` when Circle reports it settled.
 *
 * Matching is deliberately NOT by `circle_tx_id`: `initiateUcwSendChallenge`
 * stores the CHALLENGE id there (the only handle available before approval),
 * while the webhook carries the TRANSACTION id — they never match. So we match
 * on the authoritative triple Circle gives us: the sending Circle wallet, the
 * amount, and a row that is still `pending`/`failed`.
 *
 * Idempotent: an already-`done` row is skipped, and only the most recent
 * candidate is touched.
 */
async function reconcileOutboundSend(notification: CircleNotification): Promise<void> {
  // The SENDER is `sourceAddress`, not `walletId`. On an inbound notification
  // `walletId` belongs to the recipient, so matching on it would "reconcile" a
  // send against the wrong wallet. `outboundTransactionId` is the sender's own
  // Circle transaction id (prefer it over `id`, which is the recipient's).
  const sourceAddress = (notification as Record<string, unknown>).sourceAddress as
    | string
    | undefined;
  const rawAmount = notification.amounts?.[0];
  const txHash = notification.txHash;
  const outboundTxId = (notification as Record<string, unknown>).outboundTransactionId as
    | string
    | undefined;
  const circleTxId = outboundTxId || notification.id;
  if (!sourceAddress || !rawAmount) {
    console.warn("Circle webhook: outbound reconcile missing sourceAddress/amount — skip");
    return;
  }

  let amountMicro: bigint;
  try {
    amountMicro = parseUsdc(rawAmount);
  } catch {
    console.warn(`Circle webhook: outbound reconcile bad amount "${rawAmount}" — skip`);
    return;
  }
  if (amountMicro <= 0n) return;

  const admin = supabaseAdminClient();
  // wallets.address is stored checksummed; PostgREST `eq` is case-sensitive, so
  // match on the lowercased form explicitly.
  const { data: wallet } = await admin
    .from("wallets")
    .select("id")
    .ilike("address", sourceAddress)
    .maybeSingle();
  if (!wallet) {
    console.warn(`Circle webhook: no local wallet for sender ${sourceAddress} — skip`);
    return;
  }

  const { data: rows } = await admin
    .from("wallet_txs")
    .select("id, status")
    .eq("wallet_id", wallet.id)
    .eq("type", "out")
    .eq("method", "onchain-ucw")
    .eq("amount", amountMicro.toString())
    .in("status", ["pending", "failed"])
    .order("created_at", { ascending: false })
    .limit(1);

  const row = rows?.[0];
  if (!row) return; // no matching send (or already done)
  if (row.status === "done") return;

  const patch: Record<string, unknown> = { status: "done" };
  if (txHash) patch.arc_tx_hash = txHash;
  if (circleTxId) patch.circle_tx_id = circleTxId;

  const { error } = await admin.from("wallet_txs").update(patch).eq("id", row.id);
  if (error) {
    console.error("Circle webhook: outbound reconcile update failed:", error.message);
    return;
  }
  console.log(`Circle webhook: outbound send ${row.id} reconciled -> done (${txHash ?? "no hash"})`);
}

async function dispatchEvent(payload: CircleWebhookPayload): Promise<void> {
  const { notificationType, notification } = payload;
  if (!notification) return;

  const mapped = mapCircleStateToStatus(notification.state);
  const settled = mapped === "confirmed" || mapped === "complete";
  const isTopup = SETTLED_TRANSFER_TYPES.has(notificationType);

  // Only act on settled transfer confirmations we care about.
  if (!isTopup || !settled) {
    // previously this returned silently, so a Gateway or App Kit
    // Onramp event (gateway.deposit.finalized, gateway.mint.finalized,
    // transactions.inbound, challenges.*) would vanish without a trace and we
    // would never know an inbound rail was unhandled. Log unhandled types so
    // they show up in ops and can be wired deliberately.
    if (!isTopup) {
      console.log(
        `Circle webhook: unhandled notificationType "${notificationType}" (id ${notification.id ?? "?"}, state ${notification.state ?? "?"}) — acknowledged, no action taken`,
      );
    }
    return;
  }

  const circleTxId = notification.id;
  if (!circleTxId) {
    console.warn("Circle webhook: settled topup without notification.id — skip");
    return;
  }

  // Reconcile user-initiated SENDS. In practice Circle only ever delivers
  // `transactions.inbound` here (no `transactions.outbound` has ever been
  // observed), but an inbound notification describes BOTH sides: `walletId` is
  // the recipient, `sourceAddress` is the sender, and `outboundTransactionId`
  // is the sender's Circle transaction id. Use it to settle the sender's row —
  // otherwise a completed send stays `pending` forever.
  await reconcileOutboundSend(notification);

  const admin = supabaseAdminClient();

  // Match the pending inbound wallet_tx we created at topup time.
  const { data: tx, error: txErr } = await admin
    .from("wallet_txs")
    .select("id, wallet_id, status, type, amount, fiat_amount")
    .eq("circle_tx_id", circleTxId)
    .eq("type", "in")
    .maybeSingle();

  if (txErr) {
    console.error("Circle webhook: lookup wallet_tx failed:", txErr.message);
    return;
  }
  if (!tx) {
    // No matching pending tx (e.g. direct inbound transfer without a top-up
    // intent, or already handled). Not an error — skip silently.
    return;
  }
  if (tx.status !== "pending") {
    // Already processed — idempotent skip.
    return;
  }

  // Resolve the credited USDC amount. Prefer Circle's `amounts[0]` (decimal
  // USDC string); fall back to the stored amount / fiat_amount if absent.
  const rawAmount = notification.amounts?.[0];
  let amountMicro: bigint;
  try {
    if (rawAmount) {
      amountMicro = parseUsdc(rawAmount);
    } else if (tx.amount && BigInt(tx.amount) > 0n) {
      amountMicro = BigInt(tx.amount);
    } else {
      console.warn(
        `Circle webhook: no amount for settled tx ${circleTxId} — mark failed`
      );
      await admin.from("wallet_txs").update({ status: "failed" }).eq("id", tx.id);
      return;
    }
  } catch (e) {
    console.error(
      `Circle webhook: failed to parse amount "${rawAmount}" for ${circleTxId}:`,
      e
    );
    await admin.from("wallet_txs").update({ status: "failed" }).eq("id", tx.id);
    return;
  }

  if (amountMicro <= 0n) {
    console.warn(`Circle webhook: non-positive amount for ${circleTxId} — skip`);
    return;
  }

  // Credit atomically: ledger (DR external_fiat, CR user_wallet) + balance bump
  // + status flip + 72h chargeback holding window. No-op if already processed.
  const { error: creditErr } = await admin.rpc("credit_wallet_atomic", {
    p_wallet_id: tx.wallet_id,
    p_amount: amountMicro.toString(),
    p_ref_id: tx.id,
    p_wallet_tx_id: tx.id,
    p_holding_hours: 72,
  });

  if (creditErr) {
    console.error(
      `Circle webhook: credit_wallet_atomic failed for ${circleTxId}:`,
      creditErr.message
    );
    await admin.from("wallet_txs").update({ status: "failed" }).eq("id", tx.id);
    return;
  }

  console.log(
    `Circle webhook: credited ${amountMicro.toString()} micro-USDC to wallet ${tx.wallet_id} (tx ${tx.id})`
  );
}

export async function POST(req: NextRequest) {
  try {
    // IP allowlist: if CIRCLE_WEBHOOK_IPS is set, only allow those IPs
    if (!isIpAllowed(req, "CIRCLE_WEBHOOK_IPS")) {
      console.warn(
        `Circle webhook: IP ${req.headers.get("x-forwarded-for")} not in allowlist`
      );
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const signature = req.headers.get("x-circle-signature");
    const keyId = req.headers.get("x-circle-key-id");
    if (!signature || !keyId) {
      return NextResponse.json(
        { error: "Missing required headers" },
        { status: 400 }
      );
    }

    const rawBody = await req.text();
    let body: CircleWebhookPayload;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const isVerified = await verifyCircleSignature(rawBody, signature, keyId);
    if (!isVerified) {
      console.warn("Circle webhook: signature verification failed");
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }

    if (
      !body.subscriptionId ||
      !body.notificationId ||
      !body.notificationType
    ) {
      return NextResponse.json(
        { error: "Malformed webhook payload - missing required fields" },
        { status: 422 }
      );
    }

    const notification = body.notification;
    if (!notification) {
      return NextResponse.json(
        { error: "Malformed notification payload" },
        { status: 422 }
      );
    }

    const circleEventId = body.notificationId;
    const circleTransactionId = notification.id;
    const mappedStatus = mapCircleStateToStatus(notification.state);

    const { deduped } = await logWebhookEvent(
      rawBody,
      body,
      circleEventId,
      circleTransactionId,
      mappedStatus,
      isVerified
    );

    if (deduped) {
      console.log(
        `Circle webhook: event already processed (notificationId=${circleEventId})`
      );
      return NextResponse.json({ received: true, deduped: true }, { status: 200 });
    }

    console.log("Circle webhook notification:", {
      notificationId: body.notificationId,
      type: body.notificationType,
      state: notification.state,
      txHash: notification.txHash,
    });

    if (body.notificationType === "webhooks.test") {
      console.log("Circle webhook: test notification — validation successful");
      return NextResponse.json({ received: true }, { status: 200 });
    }

    await dispatchEvent(body);

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    // Log full error server-side, return generic message to caller (security: no internal leak)
    console.error("Circle webhook: failed to process:", error);
    return NextResponse.json(
      { error: "Failed to process notification" },
      { status: 500 }
    );
  }
}

/** Circle probes the endpoint with HEAD to verify reachability. */
export async function HEAD() {
  return NextResponse.json({}, { status: 200 });
}
