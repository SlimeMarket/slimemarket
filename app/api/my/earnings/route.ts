import { getCurrentUser } from "@/lib/auth-ucw";
import { formatUsdc } from "@/lib/money";
import { computeSellerNet } from "@/lib/fee";
import { jsonError, jsonOk , dbErrorMessage } from "@/lib/utils";
import { ONCHAIN_FUNDS_ENABLED, getOnChainBalanceMicro } from "@/lib/wallet/onchain-funding";

/**
 * GET /api/my/earnings
 * Returns seller earnings.
 *
 * Custodial mode (flag off): legacy ledger sum of seller_payout entries.
 *
 * Non-custodial mode (ONCHAIN_WALLET_FUNDS=1, B4): the ledger is no longer
 * credited at release (MarketEscrow.releaseOrder pays the seller amount - 2%
 * marketplace fee on-chain; the 2% buyer fee was taken at creation),
 * on-chain), so earnings = the seller's ON-CHAIN USDC balance. The legacy
 * ledger sum is still returned for reference (`ledgerMicro`).
 *
 * Response is additive: `totalEarnings`/`totalEarningsFormatted` keep their
 * meaning in BOTH modes (spendable/withdrawable earnings for the seller).
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);

  try {
    const { supabaseAdminClient } = await import("@/lib/supabase/admin-client");
    const admin = supabaseAdminClient();

    // Find user's wallet
    const { data: wallet } = await admin
      .from("wallets")
      .select("id, address")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!wallet) {
      return jsonOk({
        mode: ONCHAIN_FUNDS_ENABLED ? "onchain" : "custodial",
        totalEarnings: 0,
        totalEarningsFormatted: "0.00",
        ...(ONCHAIN_FUNDS_ENABLED
          ? { balanceMicro: "0", balanceUsdc: "0.00", ledgerMicro: "0" }
          : {}),
      });
    }

    // Sum seller_payout entries for this wallet (custodial source of truth,
    // and the reference number in on-chain mode).
    const { data, error } = await admin
      .from("ledger_entries")
      .select("amount")
      .eq("account", "seller_payout")
      .eq("wallet_id", wallet.id);

    if (error) return jsonError(dbErrorMessage("my/earnings", error), 500);

    const totalMicro = (data || []).reduce(
      (sum: bigint, row: { amount: string | number }) =>
        sum + BigInt(typeof row.amount === "string" ? row.amount : row.amount),
      0n
    );

    /**
     * "revenue from completed sales", computed from the ORDERS that
     * actually settled rather than from the ledger.
     *
     * In non-custodial mode the ledger is no longer credited at release, so
     * summing `seller_payout` entries produced a number that simply stopped
     * growing — and after a flag flip it could be non-zero for unrelated
     * reasons. The orders table is the durable record of what was sold, and the
     * seller's share is `gross - 2%`, exactly what `releaseOrder` pays on-chain.
     */
    const settledSalesNetMicro = async (): Promise<bigint> => {
      const { data: store } = await admin
        .from("stores")
        .select("id")
        .eq("owner_user_id", user.id)
        .maybeSingle();
      if (!store?.id) return 0n;

      const { data: rows } = await admin
        .from("orders")
        .select("amount")
        .eq("store_id", store.id)
        .in("status", ["DONE", "RELEASED"]);

      let gross = 0n;
      for (const r of (rows ?? []) as { amount: string | number }[]) {
        try {
          gross += BigInt(String(r.amount));
        } catch {
          // Malformed row — skip rather than fail the whole Seller Center.
        }
      }
      return computeSellerNet(gross);
    };

    // B4 — non-custodial: earnings are the seller's ON-CHAIN USDC balance.
    // No ledger credit happens at release anymore, so the ledger sum is
    // reference-only (it stops growing once the flag flips).
    if (ONCHAIN_FUNDS_ENABLED) {
      // Revenue from settled sales, independent of the ledger (see the helper).
      const salesNetMicro = await settledSalesNetMicro();

      const address = (wallet.address as string | null) ?? (user as { walletAddress?: string }).walletAddress;
      if (!address) {
        // No on-chain address on file — nothing can be held on-chain, but the
        // sales figure is still real and must be reported.
        return jsonOk({
          mode: "onchain",
          balanceMicro: "0",
          balanceUsdc: "0.00",
          ledgerMicro: totalMicro.toString(),
          totalEarnings: Number(salesNetMicro) / 1_000_000,
          totalEarningsFormatted: formatUsdc(salesNetMicro),
        });
      }

      let balanceMicro: bigint;
      try {
        balanceMicro = await getOnChainBalanceMicro(address);
      } catch (e) {
        // RPC unreachable — degrade to the settled-sales figure instead of
        // erroring the whole Seller Center. (The sales number does not need the
        // RPC, so it stays trustworthy; only the wallet balance is unknown.)
        return jsonOk({
          mode: "onchain",
          balanceMicro: null,
          balanceUsdc: null,
          error: `on-chain balance unavailable: ${(e as Error).message}`,
          ledgerMicro: totalMicro.toString(),
          totalEarnings: Number(salesNetMicro) / 1_000_000,
          totalEarningsFormatted: formatUsdc(salesNetMicro),
        });
      }

      return jsonOk({
        mode: "onchain",
        balanceMicro: balanceMicro.toString(),
        balanceUsdc: formatUsdc(balanceMicro),
        ledgerMicro: totalMicro.toString(),
        // Revenue from settled sales (gross − 2% seller fee), from the orders
        // table — NOT the frozen ledger sum.
        totalEarnings: Number(salesNetMicro) / 1_000_000,
        totalEarningsFormatted: formatUsdc(salesNetMicro),
        walletBalance: Number(balanceMicro) / 1_000_000, // On-chain wallet balance (includes faucet, topups)
        walletBalanceFormatted: formatUsdc(balanceMicro),
      });
    }

    // Custodial mode — existing behavior, plus an additive `mode` tag.
    return jsonOk({
      mode: "custodial",
      totalEarnings: Number(totalMicro) / 1_000_000,
      totalEarningsFormatted: formatUsdc(totalMicro),
    });
  } catch (e: any) {
    return jsonError(e.message || "internal error", 500);
  }
}
