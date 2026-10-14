import { supabaseAdminClient } from "@/lib/supabase/admin-client";

/**
 * Actor that triggered an audit-worthy action.
 * - 'user'         : a real user (mm_user_id is their uuid).
 * - 'platform'     : platform-triggered (buyer-confirm, seller-decline, etc.)
 * - 'auto_release' : the 42h auto-release cron.
 * - 'system'       : other system jobs (reconciler, allowance sweep, etc.)
 */
export type AuditActorType = "user" | "platform" | "auto_release" | "system";

export type MmAuditAction =
  | "RELEASE_ORDER" | "REFUND_ORDER"
  | "RELEASE_ESCROW" | "REFUND_ESCROW"
  | "TREASURY_WITHDRAW" | "TREASURY_AIRDROP"
  | "MM_PROMOTE" | "MM_DEMOTE"
  | "BAN_USER" | "UNBAN_USER"
  | "FREEZE_PRODUCT" | "UNFREEZE_PRODUCT"
  | "FREEZE_STORE" | "UNFREEZE_STORE"
  | "REVOKE_SELLER" | "COLLECT_FEES"
  // Phase 2/5 hooks:
  | "ALLOWANCE_DANGLING"   // approve succeeded but createOrderFor never confirmed
  | "RECONCILE_DRIFT"      // treasury on-chain balance ≠ DB sum (alert)
  | "WALLET_FREEZE"        // Circle wallet frozen via setWalletState
  | "WALLET_UNFREEZE"      // Circle wallet unfrozen
  // EOA account recovery (permitted by 0065's widened action CHECK)
  | "RECOVERY_LOGIN"       // session established via a linked recovery wallet
  | "RECOVERY_WALLET_LINK"   // an external EOA was linked as recovery wallet
  | "RECOVERY_WALLET_UNLINK" // a recovery wallet was removed
  // WL (rekber) pre-escrow cancel — no money moved yet (permitted by 0066)
  | "CANCEL_WL_DEAL"
  // an admin set/reset a middleman's admin PIN. Privileged credential
  // change — without a PIN a promoted MM cannot use the MM console at all.
  | "MM_PIN_SET"
  // 0072: settlement lifecycle events for the hardened escrow contract. A
  // dispute freezes the on-chain escape hatches, so it MUST leave a trail.
  | "WL_DEAL_DELIVERED"   // seller marked the goods delivered (starts confirm clock)
  | "WL_DEAL_DISPUTED"    // buyer or seller raised a dispute (freezes settlement)
  | "SLASH_COLLATERAL"    // Admin/MM forfeited the seller's collateral to the buyer
  // 0074: the fiat leg of an OTC deal. The money moves off-platform, so these
  // declarations are the only record that it happened at all.
  | "WL_DEAL_PAID"                // buyer declared they sent the off-platform payment
  | "WL_DEAL_PAYMENT_CONFIRMED";  // seller confirmed the off-platform payment arrived

export interface MmAuditEntry {
  /**
   * UUID of the user who triggered the action. NULL for system actors
   * ('platform', 'auto_release', 'system'). When non-null, must reference
   * users(id) (FK enforced in DB).
   */
  mmUserId?: string | null;
  /** Circle wallet id used to relay the on-chain tx (or 'system' for off-chain). */
  mmWalletId: string;
  /** Distinguishes user vs system actor. Required (NOT NULL in DB). */
  actorType: AuditActorType;
  action: MmAuditAction;
  refId: string;
  /** On-chain tx hash (resolved async by indexer; may be null at write time). */
  txHash?: string;
  /** Circle's tx UUID (returned by callContract/sendUsdc). Always available. */
  circleTxId?: string;
  detail?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/**
 * Write an audit row. NEVER silently swallows failure — if the primary insert
 * fails (FK violation, CHECK violation, DB unreachable, etc.), the entry is
 * written to the mm_audit_log_failed dead-letter table and the error is
 * re-thrown. Callers wrapping money-moving actions should NOT catch this
 * throw (let it propagate so the request fails loudly instead of losing the
 * audit trail). Non-money callers may catch if they prefer best-effort.
 */
export async function createMmAuditLog(entry: MmAuditEntry): Promise<void> {
  const admin = supabaseAdminClient();
  const { error } = await admin.from("mm_audit_log").insert({
    mm_user_id: entry.mmUserId ?? null,
    mm_wallet_id: entry.mmWalletId,
    actor_type: entry.actorType,
    action: entry.action,
    ref_id: entry.refId,
    tx_hash: entry.txHash ?? null,
    circle_tx_id: entry.circleTxId ?? null,
    detail: entry.detail ?? entry.metadata ?? null,
  });
  if (error) {
    // Dead-letter so the audit intent is never lost. Even if this also fails
    // we still throw — the caller must surface the failure.
    await deadLetter(entry, error.message).catch(() => {});
    throw new Error(`mm_audit_log insert failed: ${error.message}`);
  }
}

/** Best-effort write to the dead-letter table. */
async function deadLetter(entry: MmAuditEntry, reason: string): Promise<void> {
  const admin = supabaseAdminClient();
  const { error } = await admin.from("mm_audit_log_failed").insert({
    mm_user_id: entry.mmUserId ?? null,
    mm_wallet_id: entry.mmWalletId,
    actor_type: entry.actorType,
    action: entry.action,
    ref_id: entry.refId,
    tx_hash: entry.txHash ?? null,
    circle_tx_id: entry.circleTxId ?? null,
    detail: entry.detail ?? entry.metadata ?? null,
    failure_reason: reason,
  });
  if (error) {
    // Both writes failed — DB is likely unreachable. Last resort: structured
    // stderr so the host platform's log capture still preserves the intent.
    console.error(JSON.stringify({
      level: "error",
      msg: "mm_audit_log + dead-letter both failed",
      reason,
      entry,
    }));
  }
}

export interface MmAuditTrailRow extends MmAuditEntry {
  createdAt: string;
}

export async function getMmAuditTrail(limit = 20): Promise<MmAuditTrailRow[]> {
  const admin = supabaseAdminClient();
  const { data, error } = await admin
    .from("mm_audit_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []).map((r: Record<string, unknown>) => ({
    mmUserId: r.mm_user_id as string | null,
    mmWalletId: r.mm_wallet_id as string,
    actorType: r.actor_type as AuditActorType,
    action: r.action as MmAuditAction,
    refId: r.ref_id as string,
    txHash: r.tx_hash as string | undefined,
    circleTxId: r.circle_tx_id as string | undefined,
    detail: r.detail as Record<string, unknown> | undefined,
    createdAt: r.created_at as string,
  }));
}
