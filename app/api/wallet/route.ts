import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { getWalletWithBalance } from "@/lib/wallet/balance";

/**
 * GET /api/wallet
 * Returns the authenticated user's wallet address + balances (micro-USDC) +
 * recent transactions. 401 if unauthenticated.
 *
 * Money fields are returned as JSON strings (bigint cannot be serialized).
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  const w = await getWalletWithBalance(user);
  if (!w) {
    return jsonError("wallet not found (provisioning may be incomplete)", 404);
  }
  return jsonOk({
    address: w.address,
    circleWalletId: w.circleWalletId,
    usdcBalance: w.usdcBalance.toString(),
    availableBalance: w.availableBalance.toString(),
    heldBalance: w.heldBalance.toString(),
    onChainBalance: w.onChainBalance,
    recentTx: w.recentTx.map((t) => ({
      id: t.id,
      type: t.type,
      label: t.label,
      sub: t.sub,
      amount: t.amount.toString(),
      status: t.status,
      method: t.method,
      holdingUntil: t.holdingUntil,
      circleTxId: t.circleTxId,
      createdAt: t.createdAt,
    })),
  });
}
