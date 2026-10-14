/**
 * WL escrow chat helpers.
 *
 * `resolveDealSenderRole` fixes a live bug (A3): the chat POST
 * stored `user.role.toLowerCase()` (the ACCOUNT role) as `sender_role`, so a
 * Seller-account acting as the deal's BUYER was stored as 'seller'. For
 * escrow threads the sender's DEAL SIDE must be stored instead.
 *
 * The CHECK constraint on chat_messages.sender_role allows only:
 * buyer | seller | middleman | system | admin (migration 0001 + 0035).
 */

/**
 * Account roles that are NOT valid `chat_messages.sender_role` CHECK values.
 *
 * `users.role` is one of Member | MM | Buyer | Seller | Admin, but the
 * sender_role CHECK (migration 0035) only accepts
 * `buyer | seller | middleman | system | admin`. Lowercasing the account role
 * therefore produced `"member"` (the DEFAULT signup role!) and `"mm"`, both of
 * which violate the constraint:
 *
 *   new row for relation "chat_messages" violates check constraint
 *   "chat_messages_sender_role_check"
 *
 * For a NON-escrow thread the account role is cosmetic (the FE aligns bubbles
 * by `sender_id` identity), so map the invalid ones onto a valid neighbour:
 *   member -> buyer    (both are "ordinary participant", rank <= Buyer)
 *   mm     -> middleman (the canonical name for the MM role in chat)
 *   admin  -> admin
 */
const ACCOUNT_ROLE_TO_SENDER_ROLE: Record<string, string> = {
  member: "buyer",
  mm: "middleman",
  buyer: "buyer",
  seller: "seller",
  middleman: "middleman",
  admin: "admin",
  system: "system",
};

/**
 * Map a `users.role` account role to a value allowed by the
 * `chat_messages.sender_role` CHECK constraint.
 *
 * Used for NON-escrow threads, where the stored role is cosmetic. Escrow
 * threads use `resolveDealSenderRole` below, which prefers the deal side.
 */
export function toSenderRole(accountRole: string | null | undefined): string {
  const role = (accountRole || "").toLowerCase().trim();
  return ACCOUNT_ROLE_TO_SENDER_ROLE[role] ?? "buyer";
}

export interface DealSideInput {
  senderId: string;
  buyerId: string | null | undefined;
  sellerId: string | null | undefined;
  /** Account role (e.g. "Admin", "Seller", "Buyer", "Member"). */
  accountRole: string;
}

/**
 * Resolves the sender's DEAL-SIDE role for an escrow chat message.
 *
 * - sender == deal buyer  → "buyer"  (regardless of account role)
 * - sender == deal seller → "seller" (regardless of account role)
 * - otherwise (admins/middlemen) → the account role lowercased, clamped to a
 *   value valid for the sender_role CHECK constraint.
 */
export function resolveDealSenderRole(input: DealSideInput): string {
  if (input.senderId === input.buyerId) return "buyer";
  if (input.senderId === input.sellerId) return "seller";
  // Only admins/middlemen can be in an escrow thread without being a party;
  // toSenderRole clamps any other value onto a valid CHECK value.
  return toSenderRole(input.accountRole);
}
