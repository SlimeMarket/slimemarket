import { microToDecimal } from "@/lib/catalog/mappers";
import type { DisputeBrief, DisputeEvidenceItem } from "@/lib/disputes/brief";

export interface ListingApiRow {
  id: string;
  project: string;
  wlType: string | null;
  type: string;
  /** A1 — WTS = the creator sells, WTB = the creator buys. */
  side: "WTS" | "WTB";
  unitPrice: number;
  mintPrice: number;
  qty: number;
  projectLink: string | null;
  offer: boolean;
  collateral: boolean;
  desc: string | null;
  glyph: string | null;
  gradient: string | null;
  img: string | null;
  seller: string;
  sellerAvatar: string;
  /** Seller-chosen delivery window (seconds). The buyer sees this before paying. */
  deliveryWindowSeconds: number;
}

export function mapListing(row: {
  id: string; project: string; wl_type: string | null; type: string;
  side?: string | null;
  unit_price: string | number; mint_price: string | number; qty: number;
  project_link: string | null; offer: boolean; collateral: boolean;
  desc: string | null; gradient: string | null; glyph: string | null;
  img_url?: string | null;
  seller_name: string | null; seller_avatar: string | null;
  delivery_window_seconds?: number | null;
}): ListingApiRow {
  return {
    id: row.id, project: row.project, wlType: row.wl_type, type: row.type,
    // A1 — WTS (owner sells) or WTB (owner buys). Old rows default to WTS.
    side: row.side === "WTB" ? "WTB" : "WTS",
    unitPrice: microToDecimal(row.unit_price), mintPrice: microToDecimal(row.mint_price),
    qty: row.qty, projectLink: row.project_link, offer: row.offer, collateral: row.collateral,
    desc: row.desc, gradient: row.gradient, glyph: row.glyph,
    img: row.img_url ?? null,
    seller: row.seller_name ?? "Unknown", sellerAvatar: row.seller_avatar ?? "from-slate-600 to-slate-800",
    deliveryWindowSeconds: row.delivery_window_seconds ?? 7 * 24 * 60 * 60,
  };
}

export interface DealApiRow {
  id: string;
  status: string;
  project: string;
  unit: number;
  qty: number;
  price: number;
  baseFee: number;
  total: number;
  isOffer: boolean;
  needsCollateral: boolean;
  sellerCollateral: number;
  buyerHeld: boolean;
  middlemanJoined: boolean;
  buyerId: string;
  sellerId: string;
  seller: string;
  sellerAvatar: string;
  date: string;
  listing: { project: string; img: string | null };
  onChainDealId: string | null;
  onChainTxHash: string | null;
  onChainStatus: string | null;
  /** .D3 — who funded the deal (EOA permit / EOA approve / UCW / platform). */
  buyerPayerAddress: string | null;
  buyerPayerWalletType: "ucw" | "eoa" | "platform" | null;
  /** .D3 — seller collateral deposit provenance (EOA WalletBridge tx hash). */
  sellerCollateralTxHash: string | null;
  sellerCollateralWalletType: "ucw" | "eoa" | "platform" | null;
  /**
   * Settlement clocks (mirrors the contract). Shown to the buyer BEFORE they pay
   * so the refund/release windows are never a surprise.
   */
  deliveryDeadline: string | null;
  confirmDeadline: string | null;
  deliveredAt: string | null;
  disputedAt: string | null;
  /** Amount of the seller's collateral forfeited to the buyer for proven fraud. */
  collateralSlashed: number;
  /**
   * Arbitrator case file (migration 0090). Facts + both sides' claims + which
   * outcomes the contract currently permits — never a verdict, never AI.
   * See lib/disputes/brief.ts.
   */
  disputeReason: string | null;
  disputeEvidence: DisputeEvidenceItem[];
  disputeBrief: DisputeBrief | null;
  disputeBriefAt: string | null;
  /** D3 — true when the buyer pays the seller in fiat outside the platform. */
  fiatLeg: boolean;
  /** When the buyer declared the off-platform payment was sent. */
  paymentMarkedAt: string | null;
  /** When the seller confirmed the off-platform payment arrived. */
  paymentConfirmedAt: string | null;
}

export function mapDeal(row: {
  id: string; status: string; unit: string | number; qty: number;
  price: string | number; base_fee: string | number; total: string | number;
  is_offer: boolean; needs_collateral: boolean; seller_collateral: string | number;
  buyer_held: boolean; middleman_joined: boolean;
  buyer_id: string; seller_id: string;
  seller_name: string | null; seller_avatar: string | null;
  project: string | null; listing_img?: string | null; created_at: string;
  // D3 — off-platform payment trail (absent on pre-0074 rows).
  fiat_leg?: boolean;
  payment_marked_at?: string | null;
  payment_confirmed_at?: string | null;
  on_chain_deal_id: string | null; on_chain_tx_hash: string | null;
  on_chain_status: string | null;
  buyer_payer_address: string | null; buyer_payer_wallet_type: string | null;
  seller_collateral_tx_hash: string | null; seller_collateral_wallet_type: string | null;
  delivery_deadline?: string | null; confirm_deadline?: string | null;
  delivered_at?: string | null; disputed_at?: string | null;
  collateral_slashed?: string | number | null;
  dispute_reason?: string | null;
  dispute_evidence?: DisputeEvidenceItem[] | null;
  dispute_brief?: DisputeBrief | null;
  dispute_brief_at?: string | null;
}): DealApiRow {
  const walletType = (v: string | null): "ucw" | "eoa" | "platform" | null =>
    v === "ucw" || v === "eoa" || v === "platform" ? v : null;
  return {
    id: row.id, status: row.status, project: row.project ?? "Unknown",
    unit: microToDecimal(row.unit), qty: row.qty,
    price: microToDecimal(row.price), baseFee: microToDecimal(row.base_fee),
    total: microToDecimal(row.total), isOffer: row.is_offer,
    needsCollateral: row.needs_collateral,
    sellerCollateral: microToDecimal(row.seller_collateral),
    buyerHeld: row.buyer_held, middlemanJoined: row.middleman_joined,
    buyerId: row.buyer_id, sellerId: row.seller_id,
    seller: row.seller_name ?? "Unknown",
    sellerAvatar: row.seller_avatar ?? "from-slate-600 to-slate-800",
    date: new Date(row.created_at).toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "numeric" }),
    listing: { project: row.project ?? "Unknown", img: row.listing_img ?? null },
    onChainDealId: row.on_chain_deal_id ?? null,
    onChainTxHash: row.on_chain_tx_hash ?? null,
    onChainStatus: row.on_chain_status ?? null,
    buyerPayerAddress: row.buyer_payer_address ?? null,
    buyerPayerWalletType: walletType(row.buyer_payer_wallet_type),
    sellerCollateralTxHash: row.seller_collateral_tx_hash ?? null,
    sellerCollateralWalletType: walletType(row.seller_collateral_wallet_type),
    deliveryDeadline: row.delivery_deadline ?? null,
    confirmDeadline: row.confirm_deadline ?? null,
    deliveredAt: row.delivered_at ?? null,
    disputedAt: row.disputed_at ?? null,
    collateralSlashed: microToDecimal(row.collateral_slashed ?? 0),
    disputeReason: row.dispute_reason ?? null,
    disputeEvidence: row.dispute_evidence ?? [],
    disputeBrief: row.dispute_brief ?? null,
    disputeBriefAt: row.dispute_brief_at ?? null,
    // D3 — off-platform payment trail.
    fiatLeg: row.fiat_leg === true,
    paymentMarkedAt: row.payment_marked_at ?? null,
    paymentConfirmedAt: row.payment_confirmed_at ?? null,
  };
}
