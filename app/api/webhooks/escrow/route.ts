import { NextRequest, NextResponse } from "next/server";
import { decodeEventLog, type Hex } from "viem";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { ESCROW_EVENTS_ABI } from "@/lib/contracts/escrow-events";
import { circleDeveloperSdk } from "@/lib/circle/client";
import { CIRCLE_BLOCKCHAIN } from "@/lib/arc";
import { logger } from "@/lib/logger";
import {
  generateDedupeHash,
  isIpAllowed,
  verifyCircleSignature,
} from "@/lib/circle/webhook-verify";

/**
 * POST /api/webhooks/escrow
 *
 * Receiver for Circle Smart Contract Platform **event-log** notifications
 * (`contracts.eventLog`), i.e. the push half of the SCP event monitors
 * registered by `scripts/setup-event-monitors.ts`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Without a webhook subscription the monitors happily record history into
 * Circle but push nothing to us, so the escrow lifecycle was only ever mirrored
 * by a 1-minute polling cron (`/api/admin/indexer/run`). This route is the push
 * path that lets that cron drop to a low-frequency safety net.
 *
 * WHY THE PAYLOAD IS DECODED HERE, NOT IN CIRCLE
 * ----------------------------------------------
 * Circle sends the RAW log: `topics[]` + `data`, hex-encoded. It does not decode
 * arguments for you, so we decode client-side with viem against
 * `ESCROW_EVENTS_ABI` — the single generated source of truth for the escrow
 * event ABI. Do NOT hand-write an ABI here: three hand-written copies already
 * drifted from the contract and made `parseEventLogs` drop logs silently.
 *
 * IDEMPOTENCY
 * -----------
 * Circle retries. Every delivery is deduped on sha256(raw body) via the
 * `webhook_events.dedupe_hash` unique constraint, and the DB writes are
 * naturally idempotent (they set the same terminal status for the same
 * contract id). Running alongside the indexer is therefore safe — both write
 * identical values.
 *
 * CREATION EVENTS
 * ---------------
 * `OrderCreated` / `DealCreated` carry the CONTRACT id, never our DB id, so
 * there is no direct correlation key in the log. We bridge it through
 * `listTransactions({ txHash })` → the Circle transaction id we persisted at
 * checkout (`on_chain_circle_tx_id`). This is best-effort: a miss is logged and
 * left to the inline receipt parse (`resolveOrderIdFromCircleTx`) and the
 * `reconcile/onchain-ids` cron.
 *
 * SECURITY
 * --------
 * Signature verification is MANDATORY (RSA-SHA256 over the raw body). The
 * optional IP allowlist is `ESCROW_WEBHOOK_IPS`, falling back to
 * `CIRCLE_WEBHOOK_IPS`. HEAD returns 200 for Circle's reachability probe.
 */

const ESCROW_CONTRACT_ADDRESS = (process.env.ESCROW_CONTRACT_ADDRESS ?? "").toLowerCase();

/** Circle sends `contracts.eventLog`; match case-insensitively to be safe. */
const CONTRACT_EVENT_LOG_TYPE = /^contracts\.eventlog$/i;

interface EscrowEventNotification {
  id?: string;
  blockchain?: string;
  contractAddress?: string;
  blockHash?: string;
  blockHeight?: number;
  data?: string;
  eventSignature?: string;
  eventSignatureHash?: string;
  logIndex?: string;
  topics?: string[];
  txHash?: string;
  userOpHash?: string;
  firstConfirmDate?: string;
}

interface CircleWebhookPayload {
  subscriptionId?: string;
  notificationId?: string;
  notificationType?: string;
  notification?: EscrowEventNotification;
  timestamp?: string;
  version?: number;
  [k: string]: unknown;
}

/** Statuses written to `on_chain_status` for terminal lifecycle events. */
type TerminalStatus = "RELEASED" | "REFUNDED";

/** Inserts the delivery into `webhook_events`; returns true when already seen. */
async function recordDelivery(
  rawBody: string,
  payload: CircleWebhookPayload,
  mappedStatus: string | null
): Promise<boolean> {
  const admin = supabaseAdminClient();
  const { error } = await admin.from("webhook_events").insert({
    circle_event_id: payload.notificationId || null,
    circle_transaction_id: payload.notification?.txHash || null,
    notification_type: payload.notificationType || "unknown",
    mapped_status: mappedStatus,
    signature_valid: true,
    dedupe_hash: generateDedupeHash(rawBody),
    raw_payload: payload,
    processed_at: new Date().toISOString(),
  });
  if (error) {
    if (error.code === "23505") return true; // dedupe_hash collision → already handled
    // A logging failure must not lose the event; continue processing.
    logger.error({ err: error.message }, "escrow webhook: failed to record delivery");
  }
  return false;
}

async function markOrder(contractId: string, status: TerminalStatus, txHash: string) {
  const admin = supabaseAdminClient();
  const { error } = await admin
    .from("orders")
    .update({ on_chain_status: status, on_chain_tx_hash: txHash })
    .eq("on_chain_order_id", contractId);
  if (error) logger.error({ err: error.message, contractId }, "escrow webhook: order update failed");
}

async function markDeal(contractId: string, status: TerminalStatus, txHash: string) {
  const admin = supabaseAdminClient();
  const { error } = await admin
    .from("wl_deals")
    .update({ on_chain_status: status, on_chain_tx_hash: txHash })
    .eq("on_chain_deal_id", contractId);
  if (error) logger.error({ err: error.message, contractId }, "escrow webhook: deal update failed");
}

/**
 * Bridges a creation event's tx hash back to our DB row and writes the contract
 * id. See the CREATION EVENTS note in the file header.
 */
async function correlateCreation(params: {
  table: "orders" | "wl_deals";
  idColumn: "on_chain_order_id" | "on_chain_deal_id";
  contractId: string;
  txHash: string;
}): Promise<boolean> {
  const { table, idColumn, contractId, txHash } = params;
  if (!circleDeveloperSdk || !txHash) return false;

  try {
    const res = await circleDeveloperSdk.listTransactions({
      txHash,
      blockchain: CIRCLE_BLOCKCHAIN as never,
    });
    const circleTxId = res.data?.transactions?.[0]?.id;
    if (!circleTxId) {
      logger.warn({ txHash, contractId }, "escrow webhook: no Circle tx for txHash");
      return false;
    }

    const admin = supabaseAdminClient();
    const { error } = await admin
      .from(table)
      .update({
        [idColumn]: contractId,
        on_chain_tx_hash: txHash,
        on_chain_status: "CREATED",
        on_chain_error: null,
      })
      .eq("on_chain_circle_tx_id", circleTxId)
      .is(idColumn, null); // never clobber a concurrent/inline write
    if (error) {
      logger.error({ err: error.message, circleTxId }, "escrow webhook: creation correlate failed");
      return false;
    }
    logger.info({ table, contractId, circleTxId }, "escrow webhook: contract id correlated");
    return true;
  } catch (e) {
    logger.warn({ txHash, err: (e as Error).message }, "escrow webhook: correlate threw");
    return false;
  }
}

/** Decodes one raw SCP log and applies it to the DB. Returns the event name. */
async function applyEscrowLog(notification: EscrowEventNotification): Promise<string | null> {
  const topics = notification.topics;
  const data = notification.data;

  if (!Array.isArray(topics) || topics.length === 0) {
    logger.warn({ id: notification.id }, "escrow webhook: log without topics");
    return null;
  }

  // Only our escrow contract — the subscription could be broadened later.
  const from = (notification.contractAddress ?? "").toLowerCase();
  if (ESCROW_CONTRACT_ADDRESS && from !== ESCROW_CONTRACT_ADDRESS) {
    logger.warn({ from }, "escrow webhook: event from unexpected contract — ignored");
    return null;
  }

  let eventName: string;
  let args: Record<string, unknown>;
  try {
    const decoded = decodeEventLog({
      abi: ESCROW_EVENTS_ABI,
      data: (data ?? "0x") as Hex,
      topics: topics as [Hex, ...Hex[]],
    });
    eventName = decoded.eventName;
    args = decoded.args as unknown as Record<string, unknown>;
  } catch (e) {
    // Unknown signature = the monitor list drifted from the contract. Loud.
    logger.error(
      { signature: notification.eventSignature, err: (e as Error).message },
      "escrow webhook: DECODE FAILED — monitor signature probably does not match the contract"
    );
    return null;
  }

  const txHash = notification.txHash ?? "";
  const contractId = args.id !== undefined ? String(args.id) : "";

  switch (eventName) {
    case "OrderReleased":
      await markOrder(contractId, "RELEASED", txHash);
      break;
    case "OrderRefunded":
      await markOrder(contractId, "REFUNDED", txHash);
      break;
    case "DealReleased":
      await markDeal(contractId, "RELEASED", txHash);
      break;
    case "DealRefunded":
      await markDeal(contractId, "REFUNDED", txHash);
      break;
    case "OrderCreated":
      await correlateCreation({
        table: "orders",
        idColumn: "on_chain_order_id",
        contractId,
        txHash,
      });
      break;
    case "DealCreated":
      await correlateCreation({
        table: "wl_deals",
        idColumn: "on_chain_deal_id",
        contractId,
        txHash,
      });
      break;
    case "FeesCollected":
      // Observability only — no row to update.
      logger.info(
        { treasury: args.treasury, amount: String(args.amount ?? ""), txHash },
        "escrow webhook: FeesCollected"
      );
      break;
    default:
      // Admin events (Paused, MiddlemanAdded, …) are not monitored, but if a
      // monitor is ever added we log rather than drop it silently.
      logger.info({ eventName, txHash }, "escrow webhook: unhandled escrow event");
  }

  return eventName;
}

export async function POST(req: NextRequest) {
  try {
    // Optional IP allowlist (ESCROW_WEBHOOK_IPS, falling back to CIRCLE_WEBHOOK_IPS).
    if (
      !isIpAllowed(req, "ESCROW_WEBHOOK_IPS") &&
      !isIpAllowed(req, "CIRCLE_WEBHOOK_IPS")
    ) {
      logger.warn({ ip: req.headers.get("x-forwarded-for") }, "escrow webhook: IP not allowlisted");
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const signature = req.headers.get("x-circle-signature");
    const keyId = req.headers.get("x-circle-key-id");
    if (!signature || !keyId) {
      return NextResponse.json({ error: "Missing required headers" }, { status: 400 });
    }

    const rawBody = await req.text();
    let body: CircleWebhookPayload;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!(await verifyCircleSignature(rawBody, signature, keyId))) {
      logger.warn("escrow webhook: signature verification failed");
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }

    if (!body.notificationType || !body.notification) {
      return NextResponse.json(
        { error: "Malformed webhook payload - missing required fields" },
        { status: 422 }
      );
    }

    // Circle's subscription-validation ping. Acknowledge, do nothing.
    if (body.notificationType === "webhooks.test") {
      logger.info("escrow webhook: test notification — endpoint reachable");
      return NextResponse.json({ received: true }, { status: 200 });
    }

    if (!CONTRACT_EVENT_LOG_TYPE.test(body.notificationType)) {
      // Other subscriptions may share this URL; log so misrouting is visible.
      logger.warn(
        { notificationType: body.notificationType },
        "escrow webhook: unexpected notificationType — acknowledged, no action"
      );
      return NextResponse.json({ received: true, handled: false }, { status: 200 });
    }

    // Dedupe first, decode second: retries must not re-apply DB writes.
    const alreadySeen = await recordDelivery(rawBody, body, null);
    if (alreadySeen) {
      logger.info(
        { notificationId: body.notificationId },
        "escrow webhook: duplicate delivery — skipped"
      );
      return NextResponse.json({ received: true, deduped: true }, { status: 200 });
    }

    const eventName = await applyEscrowLog(body.notification);

    return NextResponse.json({ received: true, event: eventName }, { status: 200 });
  } catch (error) {
    // Log full detail server-side, return a generic message (no internal leak).
    logger.error({ err: error }, "escrow webhook: failed to process");
    return NextResponse.json({ error: "Failed to process notification" }, { status: 500 });
  }
}

/** Circle probes the endpoint with HEAD to verify reachability. */
export async function HEAD() {
  return NextResponse.json({}, { status: 200 });
}
