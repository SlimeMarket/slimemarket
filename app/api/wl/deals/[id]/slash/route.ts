import { jsonError, jsonOk } from "@/lib/utils";
import { requireStaffAuth } from "@/lib/admin-auth";
import { slashDeal } from "@/lib/wl/transitions";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";

/**
 * POST /api/wl/deals/[id]/slash — Admin/MM rules FRAUD.
 *
 * Refunds the buyer AND forfeits the seller's collateral to them as
 * compensation. This is the whole point of requiring collateral: without this
 * path a seller could take the buyer's money, never deliver, and still get their
 * deposit back.
 *
 * Typical case: a WL/mint deal where the buyer funded the mint wallet with their
 * own money, and the seller forwarded those funds elsewhere or minted the NFT to
 * an address that is not the buyer's. The evidence usually lives on ANOTHER
 * chain, which is why a human arbitrator — the platform admin — decides.
 *
 * FUNDS FIRST: `slashDeal` relays `refundEscrowWithSlash` from the platform DCW
 * before the DB flips to CANCELLED, so the row can never read settled while the USDC
 * is still locked in MarketEscrow.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireStaffAuth(req);
  if (auth.error) return auth.error;
  const { user } = auth;

  if (!ONCHAIN_FUNDS_ENABLED) {
    return jsonError("non-custodial WL deals require ONCHAIN_WALLET_FUNDS=1", 503);
  }

  const { id: dealId } = await params;
  try {
    await slashDeal(dealId, user.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "slash failed";
    // Relay failures must not read as a client error — the deal is untouched and
    // the admin should retry.
    return jsonError(msg, /not found|must|no collateral|no on_chain|not configured/i.test(msg) ? 400 : 502);
  }

  return jsonOk({ dealId, ok: true, status: "CANCELLED", collateralSlashed: true });
}
