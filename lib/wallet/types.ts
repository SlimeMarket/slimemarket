/**
 * Shared types for the wallet module (M1).
 * Money = bigint micro-USDC throughout.
 */

export type WalletTxType = "in" | "out";
export type WalletTxStatus = "done" | "escrowed" | "pending" | "failed";
export type TopupMethod = "qris" | "card" | "bank";

/** DB row from `wallet_txs` (subset user-facing). */
export interface WalletTxRow {
  id: string;
  walletId: string;
  type: WalletTxType;
  label: string;
  sub: string | null;
  amount: bigint;
  status: WalletTxStatus;
  method: TopupMethod | "onchain" | "cctp" | null;
  fiatAmount: bigint | null;
  fiatCurrency: string | null;
  holdingUntil: string | null;
  arcTxHash: string | null;
  circleTxId: string | null;
  bankAccountId: string | null;
  idempotencyKey: string | null;
  createdAt: string;
}

/** `GET /api/wallet` response. Balances as bigint micro-USDC. */
export interface WalletWithBalance {
  address: string;
  circleWalletId: string;
  usdcBalance: bigint;
  availableBalance: bigint;
  heldBalance: bigint;
  onChainBalance: string | null; // micro-USDC from Arc RPC (null if RPC down or mock)
  recentTx: WalletTxRow[];
}

export interface TopupResult {
  redirectUrl: string;
  walletTxId: string;
}

export interface WithdrawResult {
  walletTxId: string;
  status: WalletTxStatus;
}

export interface BankAccountRow {
  id: string;
  bank: string;
  number: string;
  name: string | null;
  createdAt: string;
}

export interface PaginatedHistory {
  items: WalletTxRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface BridgeResult {
  txHash: string | null;
  status: "simulated" | "pending" | "complete" | "failed";
  message?: string;
}
