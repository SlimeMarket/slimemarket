import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { getWalletHistory } from "@/lib/wallet/history";

/**
 * GET /api/wallet/history?cursor=&limit=
 * Cursor-paginated wallet ledger (most-recent first).
 *   cursor: ISO timestamp of the last item on the previous page.
 *   limit:  1..100 (default 20).
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;

  if (limitParam && (!Number.isFinite(limit) || (limit as number) <= 0)) {
    return jsonError("limit must be a positive number", 400);
  }

  const page = await getWalletHistory({ user, cursor, limit });
  return jsonOk({
    items: page.items.map((t) => ({
      id: t.id,
      type: t.type,
      label: t.label,
      sub: t.sub,
      amount: t.amount.toString(),
      status: t.status,
      method: t.method,
      fiatAmount: t.fiatAmount?.toString() ?? null,
      fiatCurrency: t.fiatCurrency,
      holdingUntil: t.holdingUntil,
      arcTxHash: t.arcTxHash,
      circleTxId: t.circleTxId,
      bankAccountId: t.bankAccountId,
      createdAt: t.createdAt,
    })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  });
}
