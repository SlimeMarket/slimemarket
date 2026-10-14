import { getCurrentUser } from "@/lib/auth-ucw";
import { isWlStaff } from "@/lib/types";
import { jsonError, jsonOk } from "@/lib/utils";
import { requireStaffAuth } from "@/lib/admin-auth";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { createMmAuditLog } from "@/lib/mm";
import { hasOnChainDeal } from "@/lib/wl/transitions";

const PLATFORM_WALLET_ID = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";

/**
 * POST /api/wl/deals/[id]/cancel — buyer/seller (or Admin/MM) cancel while the
 * deal is still WAITING **and no money has moved**.
 *
 * WHY WAITING-only: in the LEGACY custodial flow create_wl_deal does NOT lock
 * buyer funds (buyer_held=false) and no seller collateral is deposited until
 * proceed_wl_deal_atomic, so a WAITING cancel moves NO money.
 *
 * ⚠️ FIX — that premise is FALSE in non-custodial mode
 * (`ONCHAIN_WALLET_FUNDS=1`). There, `confirmWlDeal` relays
 * `createEscrowDealFor` and the buyer's `price + 2%` leaves their wallet
 * ON-CHAIN, but the deal status stays `WAITING` until the seller proceeds.
 * Cancelling such a deal flipped it to `CANCELLED` with no refund, and every
 * recovery route then refused it:
 *   - escape-hatch requires status `ESCROW` (escape-hatch/route.ts)
 *   - release/refund require status `ESCROW` (lib/wl/transitions.ts)
 * → the buyer's USDC was unrecoverable through the app.
 *
 * So: a deal that was ever funded on-chain (`on_chain_deal_id` set, or a relay
 * submitted → `on_chain_circle_tx_id` set) may NOT be cancelled. The parties
 * must go forward: the seller proceeds → `ESCROW`, which unlocks
 * release / refund / the 7-day escape hatch.
 *
 * Idempotent: cancelling an already-CANCELLED deal returns 200 with no side effects.
 *
 * Body: none.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  const rlErr = await checkUserRateLimit(user.id, "wl-cancel", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const { id } = await params;
  const admin = supabaseAdminClient();
  const { data: deal, error: dErr } = await admin.from("wl_deals")
    .select("id, buyer_id, seller_id, status, on_chain_deal_id, on_chain_circle_tx_id")
    .eq("id", id)
    .maybeSingle();
  if (dErr) return jsonError("deal lookup failed", 500);
  if (!deal) return jsonError("deal not found", 404);

  // Authorization: identity ALWAYS comes from the session, never the body.
  // Buyer/seller may cancel; Admin/MM may cancel too, but only with a valid
  // PIN + UCW staff token (same gate as release/refund — requireStaffAuth).
  const isParty = deal.buyer_id === user.id || deal.seller_id === user.id;
  if (!isParty) {
    if (!isWlStaff(user.role)) return jsonError("forbidden", 403);
    const auth = await requireStaffAuth(req);
    if (auth.error) return auth.error;
  }

  // Idempotent: already cancelled → success, no side effects.
  if (deal.status === "CANCELLED") return jsonOk({ id, status: "CANCELLED", idempotent: true });

  // FIX refuse to cancel a deal that is already funded on-chain.
  // `hasOnChainDeal` treats "0" as a valid contract id (first deal), so only
  // null/empty counts as "not on-chain". A non-null `on_chain_circle_tx_id`
  // means a relay was submitted — the USDC may already be in MarketEscrow even
  // if the contract id has not resolved yet.
  if (hasOnChainDeal(deal.on_chain_deal_id) || deal.on_chain_circle_tx_id) {
    return jsonError(
      "This deal is already funded on-chain and cannot be cancelled. " +
        "Ask the seller to proceed so it reaches ESCROW, then it can be released or refunded.",
      409,
      { code: "FUNDS_ON_CHAIN", status: deal.status, onChainDealId: deal.on_chain_deal_id ?? null },
    );
  }

  // Only WAITING may cancel (nothing escrowed yet). 409 + code so callers can
  // branch to release/refund/escape-hatch instead of retrying blindly.
  if (deal.status !== "WAITING") {
    return jsonError("deal can only be cancelled while status is WAITING", 409, {
      code: "INVALID_STATUS",
      status: deal.status,
    });
  }

  // Conditional update closes the race with a concurrent proceed: the row only
  // flips if it is STILL WAITING at write time (no transaction needed — the
  // status predicate is atomic under Postgres UPDATE).
  const { data: updated, error: uErr } = await admin.from("wl_deals")
    .update({ status: "CANCELLED" })
    .eq("id", id)
    .eq("status", "WAITING")
    .select("id")
    .maybeSingle();
  if (uErr) return jsonError(uErr.message, 500);
  if (!updated) {
    // Lost the race to proceed (or to another cancel). Re-read and report the
    // truthful outcome rather than a misleading success/error.
    const { data: after } = await admin.from("wl_deals").select("status").eq("id", id).maybeSingle();
    if (after?.status === "CANCELLED") return jsonOk({ id, status: "CANCELLED", idempotent: true });
    return jsonError("deal can only be cancelled while status is WAITING", 409, {
      code: "INVALID_STATUS",
      status: after?.status ?? "unknown",
    });
  }

  // audit the cancellation now that mm_audit_log allows CANCEL_WL_DEAL
  // (migration 0066 + lib/mm.ts union). Best-effort: a failed audit must not
  // fail the cancel (the conditional status flip above is the source of truth).
  await createMmAuditLog({
    mmUserId: isParty ? user.id : null,
    mmWalletId: PLATFORM_WALLET_ID,
    actorType: "user",
    action: "CANCEL_WL_DEAL",
    refId: id,
    detail: { status: "WAITING", cancelledBy: isParty ? "party" : "staff" },
  }).catch(() => { /* best-effort */ });

  return jsonOk({ id, status: "CANCELLED" });
}
