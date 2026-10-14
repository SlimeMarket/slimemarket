/**
 * POST /api/wallet/gateway/transfer
 * Transfer USDC cross-chain via Gateway.
 *
 * Body: {
 *   amountUsdc: string,
 *   sourceChain: "arcTestnet" | "avalancheFuji" | "baseSepolia",
 *   destinationChain: "arcTestnet" | "avalancheFuji" | "baseSepolia",
 *   recipientAddress: string
 * }
 */
import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { parseUsdc } from "@/lib/money";
import { calculateGatewayFee } from "@/lib/fee/gateway";
import {
  transferUnifiedBalanceCircle,
  type SupportedChain,
} from "@/lib/circle/gateway-sdk";
import type { Address } from "viem";

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

  const { amountUsdc, sourceChain, destinationChain, recipientAddress } =
    (body ?? {}) as {
      amountUsdc?: string;
      sourceChain?: string;
      destinationChain?: string;
      recipientAddress?: string;
    };

  // Validate required fields
  if (!amountUsdc) {
    return jsonError("amountUsdc is required", 400);
  }

  const validChains = ["arcTestnet", "avalancheFuji", "baseSepolia"];

  if (
    !sourceChain ||
    !validChains.includes(sourceChain)
  ) {
    return jsonError(
      `sourceChain must be one of: ${validChains.join(", ")}`,
      400
    );
  }

  if (
    !destinationChain ||
    !validChains.includes(destinationChain)
  ) {
    return jsonError(
      `destinationChain must be one of: ${validChains.join(", ")}`,
      400
    );
  }

  if (sourceChain === destinationChain) {
    return jsonError("sourceChain and destinationChain must be different", 400);
  }

  if (!recipientAddress) {
    return jsonError("recipientAddress is required", 400);
  }

  // Parse amount
  let amountMicro: bigint;
  try {
    amountMicro = parseUsdc(amountUsdc);
  } catch {
    return jsonError("amountUsdc is not a valid decimal amount", 400);
  }

  if (amountMicro <= 0n) {
    return jsonError("amountUsdc must be greater than 0", 400);
  }

  // Calculate and display fee
  const fee = calculateGatewayFee(amountMicro);

  try {
    const result = await transferUnifiedBalanceCircle(
      user.circleWalletId,
      amountMicro,
      sourceChain as SupportedChain,
      destinationChain as SupportedChain,
      recipientAddress as Address
    );

    return jsonOk({
      success: true,
      transfer: {
        sourceChain,
        destinationChain,
        amount: amountMicro.toString(),
        amountUsdc: (Number(amountMicro) / 1_000_000).toFixed(6),
        fee: fee.totalFee.toString(),
        feeUsdc: (Number(fee.totalFee) / 1_000_000).toFixed(6),
        recipientAddress,
      },
      txHash: result.mintTxHash,
      attestation: result.attestation,
    });
  } catch (error) {
    console.error("Gateway transfer error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonError(`Gateway transfer failed: ${message}`, 500);
  }
}
