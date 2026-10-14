import { getCurrentUser } from "@/lib/auth-ucw";
import { jsonError, jsonOk } from "@/lib/utils";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { checkUserRateLimit, CHECKOUT_RATE_LIMIT } from "@/lib/rate-limit";
import { ONCHAIN_FUNDS_ENABLED } from "@/lib/wallet/onchain-funding";
import {
  isContractReady,
  releaseEscrowAfterTimeoutOnChain,
  refundEscrowAfterTimeoutOnChain,
  ESCROW_TIMEOUT_SECONDS,
} from "@/lib/contracts/escrow-client";
import { arcPublicClient } from "@/lib/arc";
import { hasOnChainDeal, settleDealAfterTimeout } from "@/lib/wl/transitions";
import type { Hex } from "viem";

const ESCROW_CONTRACT_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS ?? "";
const PLATFORM_WALLET_ID = process.env.PLATFORM_CIRCLE_WALLET_ID ?? "";

/**
 * Minimal `MarketEscrow.deals(uint256)` getter. The mapping is declared
 * `public` in contracts/MarketEscrow.sol, so Solidity auto-generates this
 * getter returning the FULL `EscrowDeal` tuple.
 *
 * BUG FIX (bug #35): this ABI used to list only 10 fields and stopped at
 * `refunded`, so every field past `createdAt` was read at the WRONG index —
 * `tuple[7]` (claimed `buyerDeposited`) actually read `deliveryDeadline`,
 * `tuple[8]` read `confirmDeadline` and `tuple[9]` read `disputedAt`, both
 * coerced to booleans. That made `alreadyResolved` true for any deal with a
 * confirm deadline (i.e. any delivered deal) and hid the real deadlines from
 * the timeout guard. The tuple is now spelled out in full so the route can read
 * the contract's OWN `deliveryDeadline`/`confirmDeadline` — the authoritative
 * clock, which no longer drifts from the DB mirror.
 */
const ESCROW_DEALS_ABI = [
  {
    type: "function",
    name: "deals",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "buyer", type: "address" },
      { name: "seller", type: "address" },
      { name: "price", type: "uint256" },
      { name: "fee", type: "uint256" },
      { name: "collateral", type: "uint256" },
      { name: "collateralReturned", type: "uint256" },
      { name: "createdAt", type: "uint256" },
      { name: "deliveryDeadline", type: "uint256" },
      { name: "confirmDeadline", type: "uint256" },
      { name: "disputedAt", type: "uint256" },
      { name: "buyerDeposited", type: "bool" },
      { name: "delivered", type: "bool" },
      { name: "buyerConfirmed", type: "bool" },
      { name: "disputed", type: "bool" },
      { name: "released", type: "bool" },
      { name: "refunded", type: "bool" },
      { name: "deliveryWindow", type: "uint256" },
    ],
  },
] as const;

/** Mirrors `MarketEscrow.DISPUTE_BACKSTOP`. */
const DISPUTE_BACKSTOP_SECONDS = 30 * 24 * 60 * 60;

/**
 * POST /api/wl/deals/[id]/escape-hatch — permissionless timeout recovery.
 *
 * The escrow contract exposes `releaseEscrowAfterTimeout` /
 * `refundEscrowAfterTimeout`, callable by ANYONE once the relevant per-deal
 * deadline has elapsed. This route is the app-side invocation so locked funds
 * have a recovery path when the platform operator cannot/will not relay the
 * normal (staff-gated) release/refund.
 *
 * Auth: any authenticated session (the contract is permissionless), but we
 * verify server-side that the deal has an on-chain id and that the deal's OWN
 * deadline has actually elapsed — otherwise the relayed tx would just revert
 * and waste gas. The deadline is read from the CONTRACT (`deals(id)` getter),
 * which is authoritative; the DB columns are only a fallback when the chain
 * read fails.
 *
 * Which clock applies (mirrors the contract exactly):
 *   release : `confirmDeadline`  (set when the seller marks delivered)
 *   refund  : `deliveryDeadline` (set at funding) — or, when disputed,
 *             `disputedAt + DISPUTE_BACKSTOP` (30 days)
 *
 * the status gate accepts THREE cases:
 *   - `ESCROW` — the normal case;
 *   - `DISPUTED` — so the contract's 30-day dispute backstop stays reachable
 *     when the operator (middleman) never resolves a dispute (bug #36);
 *   - `WAITING` **when the deal is funded on-chain**.
 *
 * The second case is the one that used to be unrecoverable: `confirmWlDeal`
 * relays `createEscrowDealFor` (so the buyer's USDC has already left their
 * wallet) but the status only advances to ESCROW when the SELLER proceeds. If
 * the seller goes silent, cancel is refused for on-chain deals and both
 * release/refund require ESCROW — so the buyer had no path at all.
 *
 * Body: { action: 'release' | 'refund' }
 *
 * DB STATE: when the relayed tx is already COMPLETE we mirror the outcome via
 * `settleDealAfterTimeout` (the same bookkeeping RPC the indexer uses). When it
 * is not yet mined we deliberately do NOT flip the status — the indexer settles
 * once it observes the on-chain event.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return jsonError("unauthorized", 401);
  if (user.banned) return jsonError("account is banned", 403);

  if (!ONCHAIN_FUNDS_ENABLED) {
    return jsonError("escape hatch requires ONCHAIN_WALLET_FUNDS=1", 503);
  }
  if (!ESCROW_CONTRACT_ADDRESS || !isContractReady()) {
    return jsonError("escrow contract not configured", 503);
  }

  const rlErr = await checkUserRateLimit(user.id, "wl-escape-hatch", CHECKOUT_RATE_LIMIT);
  if (rlErr) return jsonError(rlErr, 429);

  const { id } = await params;
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError("invalid JSON", 400); }
  const action = (body as { action?: unknown } | null)?.action;
  if (action !== "release" && action !== "refund") {
    return jsonError("action must be 'release' or 'refund'", 400, { code: "INVALID_ACTION" });
  }

  const admin = supabaseAdminClient();
  const { data: deal, error: dErr } = await admin.from("wl_deals")
    .select("id, status, on_chain_deal_id, created_at, delivery_deadline, confirm_deadline, delivered_at, disputed_at")
    .eq("id", id)
    .maybeSingle();
  if (dErr) return jsonError("deal lookup failed", 500);
  if (!deal) return jsonError("deal not found", 404);

  // "0" IS a valid on-chain deal id (first contract deal) — only null/empty
  // means the deal was never created on-chain.
  const onChainDealIdRaw = deal.on_chain_deal_id as string | null;
  const isOnChain = hasOnChainDeal(onChainDealIdRaw);

  // see the header note: an on-chain-funded deal can still be
  // WAITING (the seller has not proceeded), and that buyer needs this path.

  // bug #36 — DISPUTED is allowed too. The contract's `refundEscrowAfterTimeout`
  // opens a disputed deal to the buyer after `DISPUTE_BACKSTOP` (30 days), which
  // is the whole point of the backstop: funds must never be stuck forever if the
  // operator (the middleman) vanishes after a dispute. Blocking DISPUTED here
  // made that on-chain escape unreachable from the app. The action-specific
  // guard below still refuses a release on a disputed deal.
  if (
    deal.status !== "ESCROW" &&
    deal.status !== "DISPUTED" &&
    !(deal.status === "WAITING" && isOnChain)
  ) {
    return jsonError(
      "escape hatch applies to deals in ESCROW or DISPUTED, or to on-chain-funded deals still awaiting the seller (WAITING)",
      409,
      { code: "INVALID_STATUS", status: deal.status },
    );
  }
  if (!isOnChain) {
    return jsonError("deal has no on-chain id", 409, { code: "NOT_ON_CHAIN" });
  }
  // `isOnChain` is true here, so the id is a non-empty string.
  const onChainDealId = onChainDealIdRaw as string;

  // Read the AUTHORITATIVE on-chain state — the contract's own deadlines and
  // flags. The DB mirror is a fallback only if the RPC/getter read fails.
  let onChainCreatedAt: number | null = null;
  let onChainDeliveryDeadline: number | null = null;
  let onChainConfirmDeadline: number | null = null;
  let onChainDisputedAt: number | null = null;
  let buyerDeposited: boolean | null = null;
  let deliveredOnChain: boolean | null = null;
  let disputedOnChain: boolean | null = null;
  let alreadyResolved = false;
  try {
    const tuple = await arcPublicClient().readContract({
      address: ESCROW_CONTRACT_ADDRESS as Hex,
      abi: ESCROW_DEALS_ABI,
      functionName: "deals",
      args: [BigInt(onChainDealId)],
    }) as readonly [
      string, string, bigint, bigint, bigint, bigint, bigint,
      bigint, bigint, bigint,
      boolean, boolean, boolean, boolean, boolean, boolean,
      bigint,
    ];
    onChainCreatedAt = Number(tuple[6]);
    onChainDeliveryDeadline = Number(tuple[7]);
    onChainConfirmDeadline = Number(tuple[8]);
    onChainDisputedAt = Number(tuple[9]);
    buyerDeposited = tuple[10];
    deliveredOnChain = tuple[11];
    disputedOnChain = tuple[13];
    alreadyResolved = tuple[14] || tuple[15];
  } catch (e) {
    console.warn("[wl/escape-hatch] on-chain deal read failed; falling back to DB columns:", e);
  }
  if (alreadyResolved) {
    return jsonError("deal is already resolved on-chain", 409, { code: "ALREADY_RESOLVED" });
  }

  // Mirror the contract's preconditions exactly (MarketEscrow
  // releaseEscrowAfterTimeout / refundEscrowAfterTimeout) so a would-be relay
  // revert surfaces as a clear 409 instead of burning gas.
  const delivered = deliveredOnChain ?? (deal.delivered_at != null);
  const disputed = disputedOnChain ?? (deal.status === "DISPUTED");

  // Both timeout paths require the buyer to have funded the deal. An unfunded
  // shell has `deliveryDeadline == 0`, which would make the "deadline passed"
  // check trivially true and let the buyer refund a deal that never started.
  if (buyerDeposited === false) {
    return jsonError("deal is not funded on-chain", 409, { code: "NOT_FUNDED" });
  }

  if (action === "release") {
    if (disputed) {
      return jsonError("deal is disputed; the operator must resolve it", 409, { code: "DISPUTED" });
    }
    if (!delivered) {
      return jsonError("seller has not marked the deal delivered; release is unavailable", 409, {
        code: "NOT_DELIVERED",
      });
    }
  } else if (!disputed && delivered) {
    return jsonError("deal was delivered; use the confirmation path or raise a dispute", 409, {
      code: "ALREADY_DELIVERED",
    });
  }

  // Timeout window, read from the CONTRACT (authoritative). The DB mirror is a
  // fallback only when the chain read failed. It is written at the SAME anchor
  // as the contract (funding time for delivery, mark-delivered for confirm) —
  // see confirmWlDeal / mark_wl_deal_delivered — but relay latency of a few
  // seconds would otherwise drift the two clocks apart.
  const createdAtMs = onChainCreatedAt != null && onChainCreatedAt > 0
    ? onChainCreatedAt * 1000
    : new Date(deal.created_at as string).getTime();
  const fallbackEndsMs = createdAtMs + ESCROW_TIMEOUT_SECONDS * 1000;

  const chainDeliveryEndsMs =
    onChainDeliveryDeadline != null && onChainDeliveryDeadline > 0
      ? onChainDeliveryDeadline * 1000
      : null;
  const chainConfirmEndsMs =
    onChainConfirmDeadline != null && onChainConfirmDeadline > 0
      ? onChainConfirmDeadline * 1000
      : null;

  let windowEndsMs: number;
  if (action === "release") {
    windowEndsMs = chainConfirmEndsMs
      ?? (deal.confirm_deadline ? Date.parse(deal.confirm_deadline as string) : fallbackEndsMs);
  } else if (disputed) {
    // A disputed refund keys off the DISPUTE_BACKSTOP (30 days), not the
    // delivery deadline — the contract refunds the buyer by default if the
    // operator never resolves.
    const disputedAtMs =
      onChainDisputedAt != null && onChainDisputedAt > 0
        ? onChainDisputedAt * 1000
        : (deal.disputed_at ? Date.parse(deal.disputed_at as string) : null);
    windowEndsMs = (disputedAtMs ?? createdAtMs) + DISPUTE_BACKSTOP_SECONDS * 1000;
  } else {
    windowEndsMs = chainDeliveryEndsMs
      ?? (deal.delivery_deadline ? Date.parse(deal.delivery_deadline as string) : fallbackEndsMs);
  }

  // The contract requires `block.timestamp > deadline` (strictly) and timestamp
  // is whole seconds — require a 1s cushion so a same-second relay cannot revert.
  const nowMs = Date.now();
  if (nowMs < windowEndsMs + 1000) {
    const remainingSeconds = Math.ceil((windowEndsMs + 1000 - nowMs) / 1000);
    return jsonError(
      `escrow timeout not elapsed (${remainingSeconds}s remaining)`,
      409,
      { code: "TIMEOUT_NOT_ELAPSED", remainingSeconds },
    );
  }

  // The contract requires block.timestamp <= deadline. 1h is ample for the
  // relayed tx to mine and bounds how long the calldata stays replayable.
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  try {
    const result = action === "release"
      ? await releaseEscrowAfterTimeoutOnChain(onChainDealId, deadline, PLATFORM_WALLET_ID)
      : await refundEscrowAfterTimeoutOnChain(onChainDealId, deadline, PLATFORM_WALLET_ID);
    if (!result) return jsonError("escrow contract not ready", 503);
    // If the relay already mined synchronously (state COMPLETE), mirror the
    // on-chain outcome into the DB now via the same bookkeeping RPC the indexer
    // uses. Otherwise the indexer settles once it observes the event — we must
    // NOT flip the DB status before the chain confirms.
    if (result.state === "COMPLETE") {
      await settleDealAfterTimeout(id, action, user.id).catch(() => { /* indexer will retry */ });
    }
    // 202: the tx is relayed/accepted but not yet mined — the indexer settles
    // the on-chain status once the event is observed.
    return jsonOk({
      ok: true,
      action,
      onChainDealId,
      circleTxId: result.id,
      state: result.state,
      deadline,
    }, 202);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "escape hatch failed";
    return jsonError(msg, /not configured|required/i.test(msg) ? 503 : 500);
  }
}
