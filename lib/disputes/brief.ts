/**
 * Dispute brief — the arbitrator's case file.
 *
 * WHAT THIS IS FOR
 * `flagDispute` used to record only that a dispute happened. The reason and the
 * evidence lived in chat, so the middleman had to reconstruct the case by
 * scrolling a conversation before ruling — a cost that scales with dispute
 * volume and buys nothing.
 *
 * This turns that into a structured brief: the objective facts, both sides'
 * claims, and which outcomes the contract currently permits.
 *
 * ⚠️ WHAT THIS DELIBERATELY DOES NOT DO — read before changing anything here.
 *
 * 1. NO AI. By explicit product decision. Arbitration decides who keeps money.
 *    A model's judgement cannot be questioned, cannot be held accountable, and
 *    fails with confidence — the worst failure mode here, because it would back
 *    the wrong party and look authoritative doing it.
 *
 * 2. NO RECOMMENDED VERDICT. Not even a rule-based one. A brief that says
 *    "suggested: REFUND" anchors the human reading it, and a rule engine's
 *    suggestion is just a model with fewer parameters — same objection, less
 *    capability. The human rules.
 *
 * So this file computes two things and stops:
 *   • FACTS        — read straight off the deal, no interpretation
 *   • AVAILABILITY — which of release / refund / slash the CONTRACT would
 *                    currently accept, i.e. a mechanical mirror of
 *                    MarketEscrow's own `require`s
 *
 * "Available" is not "correct". It answers "can the middleman do this?" —
 * never "should they?". The gap between those two is the entire job.
 */

export interface DisputeEvidenceItem {
  side: "buyer" | "seller";
  note: string;
  link?: string | null;
  at: string; // ISO
}

/** The deal fields the brief reads. Kept narrow on purpose. */
export interface DealForBrief {
  price: string | null;
  sellerCollateral: string | null;
  deliveredAt: string | null;
  deliveryDeadline: string | null;
  confirmDeadline: string | null;
  disputedAt: string | null;
  onChainDealId: string | null;
  onChainStatus: string | null;
  collateralSlashed: string | null;
}

export interface DisputeBriefFacts {
  priceMicro: string;
  collateralMicro: string;
  collateralSlashedMicro: string;
  delivered: boolean;
  deliveredAt: string | null;
  deliveryDeadline: string | null;
  deliveryDeadlinePassed: boolean | null;
  confirmDeadline: string | null;
  confirmDeadlinePassed: boolean | null;
  disputedAt: string | null;
  /** `disputedAt + DISPUTE_BACKSTOP` — when the buyer wins by default. */
  disputeBackstopAt: string | null;
  disputeBackstopPassed: boolean | null;
  onChainDealId: string | null;
  onChainStatus: string | null;
}

export interface OutcomeAvailability {
  /** Can the middleman call this right now? Mirrors the contract's requires. */
  available: boolean;
  /** The contract condition that blocks it, or a note on why it is open. */
  reason: string;
}

export interface DisputeBrief {
  generatedAt: string;
  reason: string | null;
  facts: DisputeBriefFacts;
  claims: { buyer: DisputeEvidenceItem[]; seller: DisputeEvidenceItem[] };
  availability: {
    release: OutcomeAvailability;
    refund: OutcomeAvailability;
    slash: OutcomeAvailability;
  };
  /** Stated in the payload so no consumer mistakes this for a verdict. */
  disclaimer: string;
}

/** Mirrors `MarketEscrow.DISPUTE_BACKSTOP`. */
const DISPUTE_BACKSTOP_MS = 30 * 24 * 60 * 60 * 1000;

function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function micro(v: string | null): string {
  return v ?? "0";
}

export function buildDisputeBrief(args: {
  deal: DealForBrief;
  reason?: string | null;
  evidence?: DisputeEvidenceItem[] | null;
  now?: Date;
}): DisputeBrief {
  const { deal } = args;
  const nowMs = (args.now ?? new Date()).getTime();

  const deliveryMs = parseMs(deal.deliveryDeadline);
  const confirmMs = parseMs(deal.confirmDeadline);
  const disputedMs = parseMs(deal.disputedAt);
  const backstopMs = disputedMs === null ? null : disputedMs + DISPUTE_BACKSTOP_MS;

  const delivered = deal.deliveredAt != null;

  const facts: DisputeBriefFacts = {
    priceMicro: micro(deal.price),
    collateralMicro: micro(deal.sellerCollateral),
    collateralSlashedMicro: micro(deal.collateralSlashed),
    delivered,
    deliveredAt: deal.deliveredAt,
    deliveryDeadline: deal.deliveryDeadline,
    deliveryDeadlinePassed: deliveryMs === null ? null : nowMs > deliveryMs,
    confirmDeadline: deal.confirmDeadline,
    confirmDeadlinePassed: confirmMs === null ? null : nowMs > confirmMs,
    disputedAt: deal.disputedAt,
    disputeBackstopAt: backstopMs === null ? null : new Date(backstopMs).toISOString(),
    disputeBackstopPassed: backstopMs === null ? null : nowMs > backstopMs,
    onChainDealId: deal.onChainDealId,
    onChainStatus: deal.onChainStatus,
  };

  // Split the evidence by side, oldest first, so the arbitrator reads the case
  // in the order it was made. Anything with an unrecognised side is dropped
  // rather than guessed at.
  const evidence = Array.isArray(args.evidence) ? args.evidence : [];
  const claims = {
    buyer: evidence.filter((e) => e?.side === "buyer").sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    seller: evidence.filter((e) => e?.side === "seller").sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
  };

  // ── Availability: a mechanical mirror of the contract's own requires ───────
  //
  //   releaseEscrow            : price>0, !released && !refunded, buyerDeposited
  //   refundEscrow             : price>0, !released && !refunded
  //   refundEscrowWithSlash    : price>0, !released && !refunded, collateral > 0
  //
  // A disputed deal does NOT block any of the three — only the *timeout*
  // functions care about `disputed`. The middleman is expected to act.
  const hasOnChainId = deal.onChainDealId != null && deal.onChainDealId !== "";
  const alreadyResolved =
    deal.onChainStatus === "RELEASED" || deal.onChainStatus === "REFUNDED";

  const resolvedReason = alreadyResolved
    ? "deal is already resolved on-chain"
    : !hasOnChainId
      ? "deal has no on-chain id — the contract has nothing to act on"
      : null;

  const collateralMicro = BigInt(micro(deal.sellerCollateral));
  const priceMicro = BigInt(micro(deal.price));

  const availability = {
    release: resolvedReason
      ? { available: false, reason: resolvedReason }
      : {
          available: true,
          // The contract also requires `buyerDeposited`, but a deal can only be
          // disputed from ESCROW, which implies it was funded.
          reason: `pays ${priceMicro} micro USDC to the seller and returns the seller's collateral; no fraud is established`,
        },
    refund: resolvedReason
      ? { available: false, reason: resolvedReason }
      : {
          available: true,
          reason: "returns the buyer's funds and the seller's collateral; the deal simply did not complete",
        },
    slash: resolvedReason
      ? { available: false, reason: resolvedReason }
      : collateralMicro > 0n
        ? {
            available: true,
            reason: `pays the buyer their funds plus the seller's ${collateralMicro} micro USDC collateral as fraud compensation`,
          }
        : {
            available: false,
            reason: "no collateral was deposited on this deal — there is nothing to slash",
          },
  };

  return {
    generatedAt: new Date(nowMs).toISOString(),
    reason: args.reason ?? null,
    facts,
    claims,
    availability,
    disclaimer:
      "Facts and contract availability only. This brief does not recommend an outcome — the middleman decides.",
  };
}
