import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { parseBody, WlDisputeBodySchema } from "@/lib/schemas";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import { verifyDealActionTx } from "@/lib/wl/verify-deal-action";
import { flagDisputeDeal } from "@/lib/wl/transitions";

/**
 * POST /api/wl/deals/[id]/dispute — buyer OR seller raises a dispute.
 *
 * Either party's wallet broadcast `flagDispute(dealId)`, which FREEZES the
 * on-chain escape hatches so the middleman (platform admin) can arbitrate
 * without the other side racing settlement.
 *
 * If the platform never resolves, the contract's DISPUTE_BACKSTOP refunds the
 * buyer after 30 days — a dispute can never lock funds forever, and the buyer is
 * the default winner because they are the weaker party.
 *
 * The Admin/MM then resolves via /release, /refund, or /slash.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  if (!ONCHAIN_FUNDS_ENABLED) {
    return jsonError("non-custodial WL deals require ONCHAIN_WALLET_FUNDS=1", 503);
  }
  if (!process.env.ESCROW_CONTRACT_ADDRESS) {
    return jsonError("escrow contract address not configured", 503);
  }

  const rlErr = await checkUserRateLimit(user.id, "wl-dispute", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const { id: dealId } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const parsed = parseBody(WlDisputeBodySchema, body);
  if (parsed instanceof Response) return parsed;

  try {
    await verifyDealActionTx({
      dealId, actorId: user.id, txHash: parsed.txHash, action: "flagDispute",
    });
    // The reason/evidence ride along with the flag so the arbitrator gets a
    // case file instead of a bare "disputed" marker. Both are optional: the
    // dispute itself must never be blocked by a form.
    await flagDisputeDeal(dealId, user.id, {
      reason: parsed.reason ?? null,
      evidence: parsed.evidence ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "dispute failed";
    return jsonError(msg, /not found|only|must|malformed|not match|not configured/i.test(msg) ? 400 : 500);
  }

  return jsonOk({ dealId, ok: true, status: "DISPUTED" }, 201);
}
