/**
 * GET /api/wallet/gateway/balance
 * Fetch Gateway balance for the authenticated user across all supported chains.
 *
 * Query params: ?address=0x... (optional, defaults to user's wallet address)
 */
import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { fetchGatewayBalance } from "@/lib/circle/gateway-sdk";
import type { Address } from "viem";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const addressParam = searchParams.get("address");

  // Use provided address or user's wallet address
  const address = (addressParam || user.walletAddress) as Address;

  if (!address) {
    return jsonError("no address available", 400);
  }

  try {
    const result = await fetchGatewayBalance(address);

    // Transform balances for easier consumption.
    // Gateway API returns balance as a decimal string in USDC units (e.g. "0.500000").
    const balances = result.balances.map((b) => ({
      domain: b.domain,
      depositor: b.depositor,
      balance: b.balance,
      balanceUsdc: Number(b.balance).toFixed(6),
      balanceMicro: BigInt(Math.round(Number(b.balance) * 1_000_000)).toString(),
    }));

    // Calculate total balance across all chains (in micro units)
    const totalBalance = balances.reduce(
      (sum, b) => sum + BigInt(b.balanceMicro),
      0n
    );

    return jsonOk({
      address,
      token: result.token,
      balances,
      totalBalance: totalBalance.toString(),
      totalBalanceUsdc: (Number(totalBalance) / 1_000_000).toFixed(6),
    });
  } catch (error) {
    console.error("Gateway balance fetch error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return jsonError(`Failed to fetch Gateway balance: ${message}`, 500);
  }
}
