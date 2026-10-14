import { microToDecimal } from "@/lib/catalog/mappers";

/** Order row (DB micro-USDC) → frontend shape (decimal USDC). */
export interface OrderApiRow {
  id: string;
  date: string;
  status: string;
  productId: string;
  title: string;
  variant: string | null;
  qty: number;
  seller: string;
  buyer: string;
  amount: number;      // decimal USDC (item subtotal)
  adminFee: number;    // decimal USDC (circle + gas)
  payment: string;
  delivery: string;
  credentials: Record<string, string>;
  terms: string[];
  cancelReason: string | null;
  declineReason: string | null;
  review: { rating: number; comment: string } | null;
  sentAt: string | null;           // ISO timestamp when seller marked SENT
  releaseDeadline: string | null;  // ISO timestamp for 42h auto-release
  onChainOrderId: string | null;   // numeric contract orderId (null until mined)
  onChainTxHash: string | null;
  onChainStatus: string | null;    // release_pending | refund_pending | RELEASED | REFUNDED
  onChainCircleTxId: string | null; // Circle tx id for release/refund (migration 0036)
  onChainError: string | null;      // last on-chain error message (migration 0036)
  payerWalletType: "ucw" | "eoa" | "platform" | null; // .D (migration 0050)
  payerAddress: string | null;      // the wallet that actually paid (.D)
}

export function mapOrder(row: {
  id: string; created_at: string; status: string;
  product_id: string; product_name: string | null;
  variant: string | null; qty: number;
  amount: string | number; circle_fee: string | number; gas_fee: string | number;
  payment: string; delivery: string;
  credentials_vault_ref: string | null;
  terms: string[] | null;
  cancel_reason: string | null; decline_reason: string | null;
  sent_at?: string | null; release_deadline?: string | null;
  store_name: string | null;
  buyer?: string | null;
  review_rating: number | null; review_text: string | null;
  on_chain_order_id?: string | number | null;
  on_chain_tx_hash?: string | null;
  on_chain_status?: string | null;
  on_chain_circle_tx_id?: string | null;
  on_chain_error?: string | null;
  payer_address?: string | null;
  payer_wallet_type?: string | null;
}): OrderApiRow {
  const amount = microToDecimal(row.amount);
  // Use buyer_fee if available, otherwise fallback to circle_fee + gas_fee for backward compat
  const adminFee = ('buyer_fee' in row && row.buyer_fee !== undefined && row.buyer_fee !== null)
    ? microToDecimal(String(row.buyer_fee))
    : microToDecimal((BigInt(row.circle_fee || "0") + BigInt(row.gas_fee || "0")).toString());

  let creds: Record<string, string> = {};
  if (row.credentials_vault_ref) {
    try {
      const parsed = JSON.parse(row.credentials_vault_ref);
      if (parsed && typeof parsed === "object") {
        if (Array.isArray(parsed)) {
          // pop_stock_fifo returns string[] — parse "key: value | key: value" lines
          parsed.forEach((seg: string, i: number) => {
            const m = seg.trim().match(/^([^:]{1,28}):\s*(.+)$/);
            if (m) creds[m[1].trim()] = m[2].trim();
            else creds["Item " + (i + 1)] = seg.trim();
          });
        } else {
          creds = parsed as Record<string, string>;
        }
      }
    } catch {
      /* not JSON — ignore */
    }
  }
  let review: OrderApiRow["review"] = null;
  if (row.review_rating != null) {
    review = { rating: row.review_rating, comment: row.review_text ?? "" };
  }
  return {
    id: row.id,
    date: new Date(row.created_at).toLocaleDateString("en-US", {
      day: "2-digit", month: "short", year: "numeric",
    }),
    status: row.status,
    productId: row.product_id,
    title: row.product_name ?? "Unknown",
    variant: row.variant,
    qty: row.qty,
    seller: row.store_name ?? "Unknown",
    buyer: row.buyer ?? "Unknown",
    amount,
    adminFee,
    payment: row.payment,
    delivery: row.delivery,
    credentials: creds,
    terms: row.terms ?? [],
    cancelReason: row.cancel_reason,
    declineReason: row.decline_reason,
    review,
    sentAt: row.sent_at ?? null,
    releaseDeadline: row.release_deadline ?? null,
    onChainOrderId: row.on_chain_order_id != null ? String(row.on_chain_order_id) : null,
    onChainTxHash: row.on_chain_tx_hash ?? null,
    onChainStatus: row.on_chain_status ?? null,
    onChainCircleTxId: row.on_chain_circle_tx_id ?? null,
    onChainError: row.on_chain_error ?? null,
    payerWalletType: (row.payer_wallet_type === "ucw" || row.payer_wallet_type === "eoa" || row.payer_wallet_type === "platform")
      ? row.payer_wallet_type
      : null,
    payerAddress: row.payer_address ?? null,
  };
}
