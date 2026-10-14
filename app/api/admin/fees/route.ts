import { jsonError, jsonOk } from "@/lib/utils";
import { requireRole } from "@/lib/auth-ucw";
import { isContractAddressSet, readEscrowStats } from "@/lib/contracts/escrow-client";

/**
 * GET /api/admin/fees
 * Reads on-chain fee accounting straight from the escrow contract:
 *   - pendingFees: accrued platform fees (micro-USDC) not yet swept, and
 *   - treasury:    the address authorized to call collectFees(), and
 *   - orderCounter: total orders created on-chain (sanity / reconciliation).
 *
 * Source of truth = chain (not the DB ledger). Admin session required.
 * Money fields are returned as JSON strings (bigint cannot be serialized).
 */
export async function GET() {
  try {
    await requireRole("Admin");
  } catch {
    return jsonError("Admin role required", 403);
  }

  if (!isContractAddressSet()) {
    return jsonError("escrow contract not configured (ESCROW_CONTRACT_ADDRESS)", 503);
  }

  try {
    const stats = await readEscrowStats();
    return jsonOk({
      pendingFees: stats.pendingFees.toString(),
      treasury: stats.treasury,
      orderCounter: stats.orderCounter.toString(),
    });
  } catch (e) {
    return jsonError(`failed to read on-chain fees: ${(e as Error).message}`, 502);
  }
}
