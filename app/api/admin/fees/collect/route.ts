import { jsonError, jsonOk } from "@/lib/utils";
import { requireAdminAuth } from "@/lib/admin-auth";
import {
  collectFeesOnChain,
  isContractReady,
  readEscrowStats,
} from "@/lib/contracts/escrow-client";
import { createMmAuditLog } from "@/lib/mm";

/**
 * POST /api/admin/fees/collect
 *
 * Sweeps accrued platform fees out of the escrow contract to the treasury.
 *
 * this used to automate a 2-of-3 MultisigTreasury flow (submit +
 * confirm + execute) driven by `MULTISIG_OWNER_*_PRIVATE_KEY` from
 * `.env.multisig-keys`. None of that existed: the multisig was never deployed,
 * the private keys were never set, and `TREASURY_WALLET_ID` holds a plain DCW
 * address — so this endpoint could only ever return 503.
 *
 * The treasury is now a single wallet by design (the platform DCW, which is also
 * the contract owner/operator/middleman). `MarketEscrow.collectFees()` only
 * requires `msg.sender == treasury`, so the DCW relays it directly through the
 * same Circle contract-execution path every other admin action uses.
 *
 * `pendingFees` holds BOTH fees: the buyer fee (2%, taken at creation) and the
 * marketplace seller fee (2%, deducted at release). WL deals contribute the
 * buyer fee only.
 *
 * Auth: full admin action token (PIN + UCW device approval).
 */
export async function POST(req: Request) {
  const { user, error } = await requireAdminAuth(req);
  if (error) return error;

  if (!isContractReady()) {
    return jsonError("escrow contract / relayer not configured", 503);
  }

  let pendingBefore: bigint;
  let treasury: string;
  try {
    const before = await readEscrowStats();
    pendingBefore = before.pendingFees;
    treasury = before.treasury;
  } catch (e) {
    return jsonError(`could not read escrow state: ${(e as Error).message}`, 502);
  }

  if (pendingBefore <= 0n) {
    return jsonError("no pending fees to collect", 409);
  }

  let result: { id: string; state: string } | null;
  try {
    result = await collectFeesOnChain();
  } catch (e) {
    return jsonError(`collectFees relay failed: ${(e as Error).message}`, 502);
  }
  if (!result) {
    return jsonError("escrow contract / relayer not configured", 503);
  }

  // Audit (best-effort — the on-chain sweep is the source of truth).
  try {
    await createMmAuditLog({
      mmUserId: user.id,
      mmWalletId: "treasury",
      actorType: "user",
      action: "COLLECT_FEES",
      refId: result.id || "collectFees",
      circleTxId: result.id,
      detail: {
        triggeredBy: user.id,
        amountMicro: pendingBefore.toString(),
        treasury,
        circleState: result.state,
      },
    });
  } catch (e) {
    console.error("COLLECT_FEES audit log failed (non-fatal):", e);
  }

  // The relay is accepted asynchronously by Circle; the escrow balance moves
  // when the tx mines. Report the submitted amount, not a confirmed one.
  return jsonOk({
    circleTxId: result.id,
    state: result.state,
    collectedMicro: pendingBefore.toString(),
    treasury,
  });
}
