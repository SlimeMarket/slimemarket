/**
 * POST /api/wallet/gateway/deposit
 * Deposit USDC to Gateway from user's Circle wallet.
 *
 * Body: { amountUsdc: string, chain: "arcTestnet" | "avalancheFuji" | "baseSepolia", delegateAddress?: string }
 */
import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { parseUsdc } from "@/lib/money";
import {
  initiateDepositFromCustodialWallet,
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

  const { amountUsdc, chain, delegateAddress } = (body ?? {}) as {
    amountUsdc?: string;
    chain?: string;
    delegateAddress?: string;
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
    const txHash = await initiateDepositFromCustodialWallet(
      user.circleWalletId,
      chain as SupportedChain,
      amountMicro,
      delegateAddress as `0x${string}` | undefined
    );

    return jsonOk({
      success: true,
      txHash,
      amount: amountMicro.toString(),
      chain,
    });
  } catch (error) {
    console.error("Gateway deposit error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonError(`Gateway deposit failed: ${message}`, 500);
  }
}
