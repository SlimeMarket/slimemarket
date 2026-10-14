/**
 * Shared types & enums. Mirrors ERD.md + API_CONTRACT.md.
 * Enum values are stored as text in Postgres (with CHECK constraint) so they
 * match machine codes exactly — frontend i18n only changes display labels.
 */

export type Role = "Member" | "Buyer" | "Seller" | "MM" | "Admin";
/**
 * 3 — MM (middleman) is a DB AUTHORIZATION role for WL escrow
 * deal release/refund. It deliberately sits at Member rank in the hierarchy:
 * requireRole(min) checks must NOT implicitly grant it anything. Every MM
 * privilege is an EXPLICIT role check (see isWlStaff below), so widening one
 * gate never silently widens another. Admin remains the only rank-3 role.
 */
export const ROLE_RANK: Record<Role, number> = {
  Member: 0,
  MM: 0,
  Buyer: 1,
  Seller: 2,
  Admin: 3,
};

/**
 * 3 — staff gate for WL escrow deal operations (release/refund
 * queue, deal-room monitoring). Admin OR MM. Deal-PART gates (buyer/seller
 * identity checks) must keep using user.id comparisons, NOT this helper.
 */
export function isWlStaff(role: Role): boolean {
  return role === "Admin" || role === "MM";
}

/**
 * Languages a user can choose. MUST stay in step with two other places:
 *   - `LANGS` in public/i18n.jsx (what the switcher actually offers)
 *   - the `users_preferred_lang_check` constraint (migration 0093)
 *
 * These drifted once: the UI shipped a Russian option while this union and the
 * DB constraint both stopped at `zh`. It stayed invisible only because the
 * choice was never persisted — see migration 0093.
 *
 * Declared as an array so the same list can validate at runtime, rather than
 * hand-writing the values a second time in the route.
 */
export const PREFERRED_LANGS = ["en", "id", "zh", "ru"] as const;
export type PreferredLang = (typeof PREFERRED_LANGS)[number];

/** Type guard for untrusted input (request bodies). */
export function isPreferredLang(v: unknown): v is PreferredLang {
  return typeof v === "string" && (PREFERRED_LANGS as readonly string[]).includes(v);
}

export type ProductDelivery = "instant" | "manual";
export type ProductStatus = "active" | "soldout" | "inactive";

export type OrderStatus =
  | "PENDING"
  | "PROCESS"
  | "SENT"
  | "DONE"
  | "DISPUTED"
  | "CANCELLED"
  | "DECLINED";

/**
 * Payment rail for a marketplace order. Mirrors `CheckoutBodySchema.payment`,
 * which is what the API actually accepts and enforces.
 *
 * It used to read `"Balance" | "Direct"` — wrong twice over: it omitted
 * `"Onchain"`, which the API DOES accept, and it listed `"Direct"`, which the
 * API rejects. (The `orders.payment` CHECK still permits `'Direct'`, a leftover
 * from the migration that renamed the old Indonesian value; nothing has ever
 * written it and no row uses it.)
 *
 * Nothing imports this type today, so it is documentation more than code — but
 * a type that contradicts the enforced contract is a trap for whoever reaches
 * for it next.
 */
export type PaymentMethod = "Balance" | "Onchain";

export type WLType =
  | "mint"
  | "token_transfer"
  | "wallet_surrender"
  | "discord_surrender"
  | "wallet_submit";

export type WLDealStatus = "WAITING" | "ESCROW" | "COMPLETED" | "CANCELLED";

export type RekberStatus =
  | "WAITING"
  | "APPROVED"
  | "SENT"
  | "COMPLETED"
  | "CANCELLED";

export type ChatThreadType = "normal" | "escrow";
export type ChatThreadStatus = "active" | "disrupted" | "closed";
export type ChatSenderRole = "buyer" | "seller" | "middleman" | "system";

/** Ledger accounts (double-entry). Σ DR = Σ CR per tx_group. */
export type LedgerAccount =
  | "user_wallet"
  | "escrow_holding"
  | "platform_fee"
  | "seller_payout"
  | "referral_payout"
  | "gas_pool"
  | "collateral_hold";

export type LedgerDirection = "DR" | "CR";

export type SecretKind = "credential" | "seed" | "2fa";

export type SellerAppStatus = "pending" | "approved" | "rejected";

export type DisputeOutcome = "release" | "refund";

/** AuditLog action enum. */
export type AuditAction =
  | "RELEASE"
  | "REFUND"
  | "APPROVE"
  | "REJECT"
  | "RESOLVE"
  | "BAN"
  | "FREEZE"
  | "TAKEDOWN";
