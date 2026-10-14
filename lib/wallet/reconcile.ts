import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { circleDeveloperSdk } from "@/lib/circle/client";
import { createMmAuditLog } from "@/lib/mm";

const PLATFORM_WALLET_ID = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";
const RECONCILE_LOOKBACK_MINUTES = 60 * 24; // scan wallet_txs created in the last 24h

interface WalletTxRow {
  id: string;
  wallet_id: string;
  amount: string;
  status: string;
  circle_tx_id: string | null;
  method: string | null;
  type: string | null;
  label: string | null;
}

export interface ReconcileResult {
  scanned: number;
  completedDebit: number;   // pending-with-confirmed-tx → debit completed
  reversedFailed: number;    // failed sendUsdc → wallet_txs marked failed (no debit happened)
  flaggedForOps: number;    // unresolvable cases (e.g. tx still pending after 24h) → audit RECONCILE_DRIFT
}

/**
 * Reconcile wallet_txs rows that are in a non-terminal state but have a Circle
 * tx id. Closes the gap from the old earnings-withdraw flow (pre Phase 1.2) and
 * backstops server crashes between `sendUsdc` CONFIRMED and `debit_wallet_atomic`.
 *
 * Idempotent: a row already in 'done' / 'failed' state is skipped (the query
 * filters status='pending'). Safe to run repeatedly via cron.
 *
 * Note on reversal logic: this query selects status='pending' rows only. The
 * debit_wallet_atomic RPC atomically flips status to 'done' on success, so any
 * 'pending' row means the debit never completed → no ledger credit reversal
 * is needed on FAILED on-chain tx, just mark the row 'failed'.
 *
 * CRON: call from `app/api/admin/reconcile/failed-withdrawals/route.ts` every
 * 5 minutes with `Authorization: Bearer INDEXER_CRON_SECRET` (or Admin session).
 */
export async function reconcileFailedWithdrawals(): Promise<ReconcileResult> {
  const admin = supabaseAdminClient();
  const since = new Date(Date.now() - RECONCILE_LOOKBACK_MINUTES * 60_000).toISOString();

  // Scan: type='out' + status='pending' + circle_tx_id NOT NULL + created within lookback.
  // excludes method='onchain-ucw': those rows carry a Circle CHALLENGE id,
  // not a transaction id, so getTransaction would never resolve them. They are
  // handled by reconcileStaleUcwSends below.
  const { data: rows, error } = await admin
    .from("wallet_txs")
    .select("id, wallet_id, amount, status, circle_tx_id, method, type, label")
    .eq("type", "out")
    .eq("status", "pending")
    .neq("method", "onchain-ucw")
    .not("circle_tx_id", "is", null)
    .gte("created_at", since);

  if (error) {
    console.error("reconcileFailedWithdrawals: select failed:", error.message);
    return { scanned: 0, completedDebit: 0, reversedFailed: 0, flaggedForOps: 0 };
  }

  let completedDebit = 0;
  let reversedFailed = 0;
  let flaggedForOps = 0;
  const scanned = rows?.length ?? 0;

  for (const r of (rows ?? []) as WalletTxRow[]) {
    if (!r.circle_tx_id) continue;

    let state: string | null = null;
    try {
      const resp = await circleDeveloperSdk?.getTransaction({ id: r.circle_tx_id });
      state = resp?.data?.transaction?.state ?? null;
    } catch (e) {
      console.error(`reconcile: getTransaction ${r.circle_tx_id} threw:`, e);
      // Don't flag — Circle API may be transient. Leave for next cycle.
      continue;
    }

    if (state === "CONFIRMED" || state === "COMPLETE") {
      // On-chain USDC left treasury. The user's ledger may or may not have been
      // debited. debit_wallet_atomic is idempotent (returns null if wallet_txs
      // status != 'pending' — see 0004_wallet_m1.sql line 116). Safe to call.
      const { error: debitErr } = await admin.rpc("debit_wallet_atomic", {
        p_wallet_id: r.wallet_id,
        p_amount: r.amount,
        p_ref_id: r.id,
        p_wallet_tx_id: r.id,
      });
      if (debitErr) {
        // Should not happen — RPC only throws on missing wallet/tx or negative
        // amount. Flag for ops visibility and leave 'pending' for next cycle.
        await createMmAuditLog({
          mmUserId: null, mmWalletId: PLATFORM_WALLET_ID,
          actorType: "system",
          action: "RECONCILE_DRIFT", refId: r.id,
          circleTxId: r.circle_tx_id,
          detail: {
            reason: "debit_failed_post_confirm",
            debitError: debitErr.message,
            amount: r.amount,
            walletTxId: r.id,
            state,
          },
        }).catch(() => {});
        flaggedForOps++;
      } else {
        // RPC returns null when already debited (idempotent) — either way, the
        // wallet_txs row is now 'done'. Just close it out.
        await admin.from("wallet_txs").update({ status: "done" }).eq("id", r.id);
        completedDebit++;
      }
    } else if (state === "FAILED" || state === "CANCELLED" || state === "DENIED") {
      // On-chain tx never succeeded. USDC is still in treasury. Since this query
      // only selects status='pending' rows, the original debit_wallet_atomic
      // never completed (RPC atomically flips status to 'done' on success).
      // So no credit reversal is needed — just mark the wallet_txs row failed.
      await admin.from("wallet_txs").update({ status: "failed" }).eq("id", r.id);
      reversedFailed++;
    }
    // state === null || "PENDING" || "SENT" || "INITIATED" → leave for next cycle.
    // If it's been pending >24h (outside lookback), it'll be invisible to this
    // query; cron for older cases can be added if needed.
  }

  return { scanned, completedDebit, reversedFailed, flaggedForOps };
}

const STALE_UCW_MINUTES = 30;
const STALE_UCW_LIMIT = 50;

export interface StaleUcwResult {
  scanned: number;
  flagged: number;
}

/**
 * surface UCW-challenge withdrawals that never came back.
 *
 * `initiateUcwSendChallenge` records a pending wallet_tx, then the frontend is
 * supposed to call settle with the on-chain txHash after the user approves with
 * their PIN. If the browser closes (or the callback fails), the row stays pending
 * forever and — before this — was invisible to every reconciler, so a user could
 * have lost funds with no trace.
 *
 * We deliberately do NOT auto-resolve these. We cannot tell from the DB whether
 * the user approved the transfer, and guessing wrong in either direction is worse
 * than flagging: marking 'failed' would hide a real on-chain outflow, and marking
 * 'done' would debit a user who never sent anything. So each stale row gets a
 * RECONCILE_DRIFT audit entry carrying the challenge id, for ops to check in the
 * Circle console and settle by hand.
 *
 * Idempotent in the sense that it is read-only apart from the audit trail; it
 * re-flags on every run until the row is settled, which is intended (a stuck
 * withdrawal should keep showing up).
 */
export async function reconcileStaleUcwSends(): Promise<StaleUcwResult> {
  const admin = supabaseAdminClient();
  const cutoff = new Date(Date.now() - STALE_UCW_MINUTES * 60_000).toISOString();

  const { data: rows, error } = await admin
    .from("wallet_txs")
    .select("id, wallet_id, amount, status, circle_tx_id, method, type, label")
    .eq("type", "out")
    .eq("status", "pending")
    .eq("method", "onchain-ucw")
    .lt("created_at", cutoff)
    .limit(STALE_UCW_LIMIT);

  if (error) {
    console.error("reconcileStaleUcwSends: select failed:", error.message);
    return { scanned: 0, flagged: 0 };
  }

  const scanned = rows?.length ?? 0;
  let flagged = 0;

  for (const r of (rows ?? []) as WalletTxRow[]) {
    await createMmAuditLog({
      mmUserId: null,
      mmWalletId: PLATFORM_WALLET_ID,
      actorType: "system",
      action: "RECONCILE_DRIFT",
      refId: r.id,
      ...(r.circle_tx_id ? { circleTxId: r.circle_tx_id } : {}),
      detail: {
        reason: "ucw_send_never_settled",
        hint: "user approved a PIN withdrawal but the FE never called settle; verify the challenge in the Circle console before resolving",
        walletTxId: r.id,
        walletId: r.wallet_id,
        amount: r.amount,
        staleMinutes: STALE_UCW_MINUTES,
      },
    }).catch(() => { /* best-effort; the row stays pending and will be retried */ });
    flagged++;
  }

  if (flagged > 0) {
    console.warn(`reconcileStaleUcwSends: ${flagged} stale UCW send(s) flagged for ops`);
  }

  return { scanned, flagged };
}
