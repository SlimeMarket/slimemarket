import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { arcFaucetCredit } from "@/lib/wallet/faucet";

/**
 * POST /api/wallet/dev/faucet  (DEV ONLY — 404 in production)
 *
 * Free testnet USDC credit (no chargeback window). For local dev balancing
 * without hitting a real Arc faucet. Mirrors the walletConnect faucet concept
 * in the frontend (auth.jsx).
 *
 * Body: { amountUsdc: string }   (e.g. "100")
 */
export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return jsonError("not found", 404);
  }
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }
  const { amountUsdc } = (body ?? {}) as { amountUsdc?: string };
  if (!amountUsdc) return jsonError("amountUsdc is required", 400);

  // arcFaucetCredit moves REAL testnet USDC out of the platform treasury wallet.
  // When that wallet is empty it throws — previously uncaught, so the client got
  // a bare 500 with an empty body. Map it to a 402 with the real reason.
  try {
    const result = await arcFaucetCredit({ user, amountUsdc });
    return jsonOk({
      walletTxId: result.walletTxId,
      amountUsdcMicro: result.amountMicroUsdc.toString(),
      status: "done",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "faucet failed";
    const status = /insufficient/i.test(msg) ? 402 : 500;
    return jsonError(msg, status);
  }
}
