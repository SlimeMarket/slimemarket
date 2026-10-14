import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import type { CurrentUser } from "@/lib/auth-ucw";
import type { PaginatedHistory, WalletTxRow, WalletTxType, WalletTxStatus } from "./types";

/**
 * Paginated wallet history (cursor-based).
 * Cursor = ISO timestamp of last item on previous page.
 * Returns most recent first.
 */
export async function getWalletHistory(args: {
  user: CurrentUser;
  cursor?: string | null;
  limit?: number;
}): Promise<PaginatedHistory> {
  const { user, cursor, limit = 20 } = args;
  const clampedLimit = Math.min(Math.max(limit, 1), 100);

  const admin = supabaseAdminClient();

  const { data: wallet, error: wErr } = await admin
    .from("wallets")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (wErr || !wallet) throw new Error("wallet not found for user");

  let query = admin
    .from("wallet_txs")
    .select(
      "id, wallet_id, type, label, sub, amount, status, method, fiat_amount, fiat_currency, holding_until, arc_tx_hash, circle_tx_id, bank_account_id, idempotency_key, created_at"
    )
    .eq("wallet_id", wallet.id)
    .order("created_at", { ascending: false })
    .limit(clampedLimit + 1);

  if (cursor) {
    query = query.lt("created_at", cursor);
  }

  const { data: rows, error } = await query;
  if (error) throw error;

  const hasMore = (rows?.length ?? 0) > clampedLimit;
  const sliced = (rows ?? []).slice(0, clampedLimit);

  const items: WalletTxRow[] = sliced.map((r) => ({
    id: r.id,
    walletId: r.wallet_id,
    type: r.type as WalletTxType,
    label: r.label,
    sub: r.sub,
    amount: BigInt(r.amount ?? 0),
    status: r.status as WalletTxStatus,
    method: r.method,
    fiatAmount: r.fiat_amount != null ? BigInt(r.fiat_amount) : null,
    fiatCurrency: r.fiat_currency,
    holdingUntil: r.holding_until,
    arcTxHash: r.arc_tx_hash,
    circleTxId: r.circle_tx_id,
    bankAccountId: r.bank_account_id,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
  }));

  const nextCursor =
    hasMore && items.length > 0 ? items[items.length - 1].createdAt : null;

  return { items, nextCursor, hasMore };
}
