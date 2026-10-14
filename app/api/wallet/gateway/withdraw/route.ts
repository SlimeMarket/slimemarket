/**
 * POST /api/wallet/gateway/withdraw
 * Withdraw USDC from Gateway back to user's wallet.
 *
 * Body: { amountUsdc: string, chain: "arcTestnet" | "avalancheFuji" | "baseSepolia" }
 */
import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { parseUsdc } from "@/lib/money";
import {
  withdrawFromCustodialWallet,
  type SupportedChain,
} from "@/lib/circle/gateway-sdk";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  if (!user.circleWalletId) {
    return jsonError("user has no Circle wallet", 400);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid JSON body", 400);
  }

  const { amountUsdc, chain } = (body ?? {}) as {
    amountUsdc?: string;
    chain?: string;
  };

  if (!amountUsdc) {
    return jsonError("amountUsdc is required", 400);
  }

  if (!chain || !["arcTestnet", "avalancheFuji", "baseSepolia"].includes(chain)) {
    return jsonError(
      "chain must be one of: arcTestnet, avalancheFuji, baseSepolia",
      400
    );
  }

  let amountMicro: bigint;
  try {
    amountMicro = parseUsdc(amountUsdc);
  } catch {
    return jsonError("amountUsdc is not a valid decimal amount", 400);
  }

  if (amountMicro <= 0n) {
    return jsonError("amountUsdc must be greater than 0", 400);
  }

  try {
    const txHash = await withdrawFromCustodialWallet(
      user.circleWalletId,
      chain as SupportedChain,
      amountMicro
    );

    return jsonOk({
      success: true,
      txHash,
      amount: amountMicro.toString(),
      amountUsdc: (Number(amountMicro) / 1_000_000).toFixed(6),
      chain,
    });
  } catch (error) {
    console.error("Gateway withdrawal error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonError(`Gateway withdrawal failed: ${message}`, 500);
  }
}
