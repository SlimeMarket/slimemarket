import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { logger } from "@/lib/logger";
import { onchainFundsEnabled } from "@/lib/wallet/onchain-funding";

/** Drafts older than this are expired (buyer didn't complete checkout). */
const DRAFT_TTL_MINUTES = 30;

/**
 * Custodial ('Balance') drafts get a longer TTL.
 *
 * A 'Balance' row at status PENDING means checkout was started but never
 * confirmed, so no ledger debit happened (the debit is applied at confirm).
 * Unlike the non-custodial 'Onchain' draft this is not the primary rail, so
 * we allow a longer grace period before reaping it — but it MUST be reaped,
 * because nothing else ever moves it out of PENDING.
 */
const CUSTODIAL_DRAFT_TTL_MINUTES = 120;

/**
 * Instant drafts older than this (and still not on-chain) are "stuck": the
 * relay never reached the chain after confirm advanced them, so their stock
 * was consumed but no escrow was ever funded. One hour (spec B3) gives the
 * confirm path + reconciliation indexer ample time to resolve first.
 */
const STUCK_INSTANT_TTL_MINUTES = 60;

export interface DraftCleanupResult {
  scanned: number;
  expired: number;
  /** Stuck instant drafts cancelled + restocked in this pass (B3). */
  stuckRestocked: number;
}

/** Minimal row shape the stuck-instant eligibility decision needs. */
export interface StuckDraftRow {
  status: string | null;
  delivery: string | null;
  payment: string | null;
  on_chain_order_id: string | null;
  on_chain_tx_hash: string | null;
  /**
   * Circle's tx id for the createOrderFor relay. this is the tell that
   * the relay WAS submitted: if it is set, funds may already be in the escrow
   * even when the contract order id could not be resolved, so the row must never
   * be treated as an abandoned draft.
   */
  on_chain_circle_tx_id?: string | null;
  created_at: string;
}

/**
 * B3 — Eligibility decision for a stuck instant draft. Pure function (TDD).
 *
 * A "stuck instant draft" is an order that got credentials attached at confirm
 * time (status SENT) but whose createOrderFor relay never produced an on-chain
 * escrow (both on_chain_order_id and on_chain_tx_hash null/empty), so its
 * stock items sit 'sold' forever while the buyer never paid. Those orders must
 * be CANCELLED and their stock restocked.
 *
 * Orders that DID reach the chain (any on-chain id/hash) are never touched
 * here — reconciliation owns those.
 */
export function isStuckInstantDraft(
  order: StuckDraftRow,
  now: Date = new Date(),
  ttlMinutes: number = STUCK_INSTANT_TTL_MINUTES,
): boolean {
  if (order.status !== "SENT") return false;
  if (order.delivery !== "instant") return false;

  // (BUG 13) — `payment` is NOT the right discriminator here.

  // This used to require `payment === "Onchain"`, on the theory that a 'Balance'
  // order is already PAID at creation and so follows a different lifecycle. That
  // holds in CUSTODIAL mode. It does not hold in non-custodial mode: nothing has
  // been debited from anyone, so a SENT + no-on-chain-id row there is an
  // abandoned draft exactly like an 'Onchain' one — and the legacy
  // `checkoutOrder` path could still mint such rows (`payment='Balance'`) when its
  // escrow relay failed.

  // Because the filter excluded them, those rows were unsweepable AND
  // unconfirmable (`confirmOrder` correctly refuses with
  // ONCHAIN_ID_UNRESOLVED) — they stuck forever. Two live orders were wedged
  // this way (`b5716370…`, `efefc052…`).

  // The real safety property is not the payment label, it is whether any on-chain
  // reference exists — checked right below. A 'Balance' row WITH an on-chain id is
  // still excluded (it is settled custodial money). A 'Balance' row WITHOUT one, in
  // non-custodial mode, moves nothing and is safe to cancel + restock.

  // In custodial mode we keep the historical behaviour: 'Balance' orders are paid
  // at creation and must not be swept.
  if (order.payment !== "Onchain" && !onchainFundsEnabled()) return false;

  // Any on-chain reference means escrow may exist — reconciliation owns it.
  if (order.on_chain_order_id) return false;
  if (order.on_chain_tx_hash && order.on_chain_tx_hash.trim() !== "") return false;

  // CRITICAL: a stored Circle tx id means the createOrderFor relay was
  // SUBMITTED. The contract id can still be unresolved (resolveOrderIdFromCircleTx
  // timed out), and in that case the buyer's USDC is already sitting in
  // MarketEscrow. Cancelling + restocking here would leave those funds locked with
  // nothing left to refund against (no contract id, so the indexer cannot even
  // find the order). Such rows belong to the on-chain-id resolver instead.
  if (order.on_chain_circle_tx_id && order.on_chain_circle_tx_id.trim() !== "") return false;

  const cutoff = now.getTime() - ttlMinutes * 60_000;
  const created = Date.parse(order.created_at);
  if (Number.isNaN(created)) return false;
  return created <= cutoff;
}

/**
 * Expires stale non-custodial checkout drafts. If a buyer starts checkout
 * (POST /api/orders/checkout/prepare) but never confirms (e.g. abandons the
 * page, cancels the PIN prompt, network failure), the draft row stays in
 * PENDING status forever. This marks drafts older than 30 min as CANCELLED
 * so they don't pollute the buyer's order list or the dangling-allowance scan.
 *
 * B3: additionally sweeps stuck instant drafts (SENT, never on-chain, older
 * than 1h): CANCELLED + product_stock_items returned to 'available' via the
 * transactional restock_instant_order RPC (0048).
 *
 * Idempotent: rows already in a non-PENDING state are skipped by the WHERE
 * clause; the restock RPC no-ops on anything that isn't a stuck instant SENT
 * draft. Safe to run repeatedly via cron.
 *
 * CRON: `app/api/admin/sweep/drafts/route.ts` every 10 minutes.
 */
export async function cleanupExpiredDrafts(): Promise<DraftCleanupResult> {
  const admin = supabaseAdminClient();
  const cutoff = new Date(Date.now() - DRAFT_TTL_MINUTES * 60_000).toISOString();

  // Only expire non-custodial drafts (payment='Onchain'). Custodial orders
  // (payment='Balance') have a different lifecycle — they're already PAID at
  // creation time, so "expired" doesn't apply.
  // FIX `on_chain_circle_tx_id IS NULL` is REQUIRED here.

  // `confirmCheckoutOrder` leaves exactly this state — status PENDING,
  // `on_chain_circle_tx_id` SET, `on_chain_order_id` NULL — whenever the relay
  // was submitted but `resolveOrderIdFromCircleTx` timed out reading the
  // contract id out of the receipt. The buyer's USDC is ALREADY in
  // MarketEscrow at that point. Cancelling the row used to make it invisible to
  // `reconcileMissingOnchainIds`, which only scans
  // ["PENDING","PROCESS","SENT","DONE","DISPUTED"] — CANCELLED is excluded. The
  // contract id could then never be recovered, so neither `refundOrder` nor
  // `releaseOrder` could ever be called: the money was stranded until the
  // 7-day escape hatch, which ALSO needs the id.

  // added this guard to the stuck-instant path only; the generic
  // expired-draft path below was left unguarded.
  const { data: expired, error } = await admin
    .from("orders")
    .update({ status: "CANCELLED", cancel_reason: "draft expired (checkout not completed in 30 min)" })
    .eq("status", "PENDING")
    .eq("payment", "Onchain")
    .is("on_chain_order_id", null)
    .is("on_chain_circle_tx_id", null)
    .lt("created_at", cutoff)
    .select("id");

  if (error) {
    logger.error({ err: error.message }, "draft-cleanup: update failed");
    return { scanned: 0, expired: 0, stuckRestocked: 0 };
  }

  const expiredCount = expired?.length ?? 0;
  if (expiredCount > 0) {
    logger.info({ count: expiredCount }, "draft-cleanup: expired stale drafts");
  }

  // ── Custodial ('Balance') PENDING drafts ────────────────────────────────────
  // FIX: these were never reaped. `cleanupExpiredDrafts` only matched
  // payment='Onchain', but `prepareCheckoutOrder` defaults p_payment to
  // "Balance" and `confirmCheckoutOrder`, when the relay fails, resets the row to
  // `p_target_status: "PENDING"`. Nothing else ever moves a 'Balance' PENDING row
  // out of that state, so an abandoned/rolled-back custodial checkout sat in
  // PENDING forever, polluting the buyer's order list.

  // Safety: the SAME on-chain guards as the 'Onchain' path apply. If the relay
  // was submitted (on_chain_circle_tx_id set) or an escrow reference exists,
  // the row is left alone — reconciliation owns it. A 'Balance' draft that never
  // produced any on-chain reference was never debited, so cancelling is safe.
  const custodialCutoff = new Date(
    Date.now() - CUSTODIAL_DRAFT_TTL_MINUTES * 60_000
  ).toISOString();
  const { data: custodialExpired, error: cErr } = await admin
    .from("orders")
    .update({
      status: "CANCELLED",
      cancel_reason: "draft expired (checkout not completed)",
    })
    .eq("status", "PENDING")
    .eq("payment", "Balance")
    .is("on_chain_order_id", null)
    .is("on_chain_circle_tx_id", null)
    .lt("created_at", custodialCutoff)
    .select("id");

  if (cErr) {
    logger.error({ err: cErr.message }, "draft-cleanup: custodial update failed");
  }
  const custodialExpiredCount = custodialExpired?.length ?? 0;
  if (custodialExpiredCount > 0) {
    logger.info(
      { count: custodialExpiredCount },
      "draft-cleanup: expired stale custodial drafts",
    );
  }

  // B3 — stuck instant drafts: SENT + never on-chain + older than 1 hour.
  // Process oldest-first so the restock heuristic (most-recently-'sold' rows
  // belong to the most recent stuck order) stays consistent.

  // (BUG 13): the `.eq("payment","Onchain")` filter is GONE. It made
  // 'Balance' rows unreachable, so a non-custodial order that ended up
  // `SENT` + `Balance` + no-on-chain-id could never be swept. `isStuckInstantDraft`
  // below is the single decision point and still excludes settled custodial
  // orders (any on-chain reference) as well as 'Balance' rows in custodial mode.
  const stuckCutoff = new Date(Date.now() - STUCK_INSTANT_TTL_MINUTES * 60_000).toISOString();
  const { data: candidates, error: scanErr } = await admin
    .from("orders")
    .select("id, status, delivery, payment, on_chain_order_id, on_chain_tx_hash, on_chain_circle_tx_id, created_at")
    .eq("status", "SENT")
    .eq("delivery", "instant")
    .lt("created_at", stuckCutoff)
    .order("created_at", { ascending: true })
    .limit(50);

  let stuckRestocked = 0;
  if (scanErr) {
    logger.error({ err: scanErr.message }, "draft-cleanup: stuck-instant scan failed");
  } else if (candidates) {
    for (const row of candidates as StuckDraftRow[] & { id: string }[]) {
      if (!isStuckInstantDraft(row)) continue; // defense in depth (pure guard)
      // restock_instant_order (0048) is transactional: stock rows back to
      // 'available', order → CANCELLED, credentials cleared, product
      // re-activated if it was auto-soldout'd. Double-guards inside the RPC
      // make a second pass a no-op.
      const { error: restockErr } = await admin.rpc("restock_instant_order", {
        p_order_id: row.id,
        p_target_status: "CANCELLED",
      });
      if (restockErr) {
        logger.error({ orderId: row.id, err: restockErr.message }, "draft-cleanup: restock failed");
        continue;
      }
      stuckRestocked++;
      logger.info({ orderId: row.id }, "draft-cleanup: stuck instant draft cancelled + restocked");
    }
  }

  return {
    scanned: expiredCount + custodialExpiredCount,
    expired: expiredCount + custodialExpiredCount,
    stuckRestocked,
  };
}
