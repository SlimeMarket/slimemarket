import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { settleUcwSend } from "@/lib/wallet/ucw-send";
import { checkUserRateLimit, WITHDRAW_RATE_LIMIT } from "@/lib/rate-limit";
import { z } from "zod";

/**
 * POST /api/wallet/withdraw/ucw-settle — .
 *
 * Called by the FE after the UCW TRANSFER challenge resolves (or the user
 * cancels). Verifies the on-chain receipt (success + originated from the
 * user's own wallet), flips the pending wallet_tx to done, and best-effort
 * mirrors the debit. Cancel → marks the pending tx failed (nothing moved).
 *
 * Body: { walletTxId: string, txHash?: string, cancelled?: boolean }
 */
const SettleBodySchema = z.object({
  walletTxId: z.string().uuid(),
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  cancelled: z.boolean().optional(),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  const rlErr = await checkUserRateLimit(user.id, "withdraw", WITHDRAW_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON body", 400); }
  const parsed = SettleBodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonError("invalid body: " + parsed.error.issues[0]?.message, 400);
  }

  const result = await settleUcwSend({
    user,
    walletTxId: parsed.data.walletTxId,
    txHash: parsed.data.txHash,
    cancelled: parsed.data.cancelled,
  });

  if (!result.ok) {
    return jsonError(result.error ?? "settlement failed", result.status === "cancelled" ? 409 : 400);
  }
  return jsonOk({ status: result.status, arcTxHash: result.arcTxHash });
}
