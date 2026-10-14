import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { arcPublicClient } from "@/lib/arc";
import type { CurrentUser } from "@/lib/auth-ucw";
import type {
  WalletWithBalance,
  WalletTxRow,
  WalletTxType,
  WalletTxStatus,
} from "./types";

/**
 * GET /api/wallet handler data: address + balances + last 25 txs.
 *
 * Balances:
 *   - usdcBalance: total wallet balance (mirror of ledger).
 *   - availableBalance: usdcBalance − held (chargeback-window) funds.
 *   - heldBalance: sum of pending-hold topup credits (holding_until > now()).
 *   - onChainBalance: raw Arc testnet balance (native USDC, 18→6 decimals). Null if RPC down.
 *
 * Money = bigint micro-USDC.
 */
export async function getWalletWithBalance(
  user: CurrentUser
): Promise<WalletWithBalance | null> {
  const admin = supabaseAdminClient();

  const { data: wallet, error } = await admin
    .from("wallets")
    .select("id, address, circle_wallet_id, usdc_balance")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error || !wallet) return null;

  // Call RPC for available balance (bigint micro-USDC).
  const { data: availableRaw, error: availErr } = await admin.rpc(
    "wallet_available_balance",
    { p_wallet_id: wallet.id }
  );
  if (availErr) throw availErr;

  const usdcBalance = BigInt(wallet.usdc_balance ?? 0);
  const availableBalance =
    typeof availableRaw === "string" ? BigInt(availableRaw) : BigInt(availableRaw ?? 0);
  const heldBalance = usdcBalance - availableBalance;

  // Read on-chain balance from Arc RPC (native USDC, 18 decimals → 6 decimals micro-USDC)
  let onChainBalance: string | null = null;
  try {
    const client = arcPublicClient();
    const balance = await client.getBalance({
      address: wallet.address as `0x${string}`,
    });
    // Arc native balance = 18 decimals (EIP-7708). Divide by 10^12 → 6-decimal micro-USDC.
    onChainBalance = (balance / 10n ** 12n).toString();
  } catch (e) {
    console.error("on-chain balance read failed:", e);
  }

  const { data: txRows, error: txErr } = await admin
    .from("wallet_txs")
    .select(
      "id, wallet_id, type, label, sub, amount, status, method, fiat_amount, fiat_currency, holding_until, arc_tx_hash, circle_tx_id, bank_account_id, idempotency_key, created_at"
    )
    .eq("wallet_id", wallet.id)
    .order("created_at", { ascending: false })
    // 10 was too small: a couple of sends plus top-ups and it looked like the
    // history had been "reset" after logging back in, because older rows fell
    // off the page even though they were still in the ledger.
    .limit(25);

  if (txErr) throw txErr;

  const recentTx: WalletTxRow[] = (txRows ?? []).map((r) => ({
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

  return {
    address: wallet.address,
    circleWalletId: wallet.circle_wallet_id,
    usdcBalance,
    availableBalance,
    heldBalance,
    onChainBalance,
    recentTx,
  };
}
