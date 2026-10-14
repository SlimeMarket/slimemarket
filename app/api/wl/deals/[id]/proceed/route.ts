import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { proceedDeal } from "@/lib/wl/transitions";

/**
 * Sane upper bound for client-supplied collateral (mirrors
 * proceed-non-custodial): the RPC/contract accept any uint256, so cap it
 * before it can overflow downstream arithmetic or drain the seller's wallet.
 */
const MAX_COLLATERAL_MICRO = 1_000_000n * 1_000_000n;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  // P1-6 parity with the sibling WL routes: banned accounts cannot mutate deals.
  if (user.banned) return jsonError("account is banned", 403);
  const { id } = await params;
  let body: unknown; try { body = await req.json(); } catch { body = {}; }
  const { collateral } = (body ?? {}) as { collateral?: number };

  // Collateral is client-supplied and flows straight into the ledger RPC.
  // Require a finite, non-negative amount and cap it before conversion.
  const collateralNum = Number(collateral ?? 0);
  if (!Number.isFinite(collateralNum) || collateralNum < 0) {
    return jsonError("invalid collateral amount", 400, { code: "INVALID_COLLATERAL" });
  }
  const colMicro = BigInt(Math.round(collateralNum * 1_000_000));
  if (colMicro > MAX_COLLATERAL_MICRO) {
    return jsonError(
      `collateral exceeds maximum ${MAX_COLLATERAL_MICRO / 1_000_000n} USDC`,
      400,
      { code: "COLLATERAL_TOO_LARGE" },
    );
  }

  // A listing that demands collateral cannot proceed with 0 — otherwise the
  // seller could lock the buyer's funds with no skin in the game.
  // needs_collateral is snapshotted on the deal at create_wl_deal time; the
  // listing is the fallback for legacy rows.
  const admin = supabaseAdminClient();
  const { data: deal } = await admin.from("wl_deals")
    .select("listing_id, needs_collateral").eq("id", id).maybeSingle();
  if (!deal) return jsonError("deal not found", 404);
  const { data: listing } = await admin.from("wl_listings")
    .select("collateral").eq("id", deal.listing_id).maybeSingle();
  if ((deal.needs_collateral === true || listing?.collateral === true) && colMicro === 0n) {
    return jsonError("collateral is required for this listing", 400, { code: "COLLATERAL_REQUIRED" });
  }

  try {
    await proceedDeal(id, user.id, colMicro);
    return jsonOk({ status: "ESCROW" });
  } catch (e) { return jsonError(clientErrorMessage(e, "proceed failed"), 400); }
}
