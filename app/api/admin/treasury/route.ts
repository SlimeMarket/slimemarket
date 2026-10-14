import { gateRole } from "@/lib/api-gate";
import { jsonError, jsonOk , clientErrorMessage } from "@/lib/utils";
import { getMmAuditTrail } from "@/lib/mm";
import { isContractReady } from "@/lib/contracts/escrow-client";
import { requireAdminAuth } from "@/lib/admin-auth";
import { supabaseAdminClient } from "@/lib/supabase/admin-client";
import { computeFee } from "@/lib/fee";

/** Convert micro-USDC bigint string to decimal number */
function microToNum(s: string | number): number {
  return Number(BigInt(s)) / 1_000_000;
}

/** GET — treasury overview with collected fees (read-only, no PIN needed) */
export async function GET() {
  const gate = await gateRole("Admin");
  if (gate.error) return gate.error;
  try {
    const admin = supabaseAdminClient();

    // --- Query ledger for fee account balances ---
    // platform_fee CR = marketplace fee revenue (buyer 2% + seller 2%)
    const { data: platformFeeRows } = await admin
      .from("ledger_entries")
      .select("amount, ref_id")
      .eq("account", "platform_fee")
      .eq("direction", "CR");

    // gas_pool CR = circle+gas (marketplace) + base+circle+gas (WL)
    const { data: gasPoolRows } = await admin
      .from("ledger_entries")
      .select("amount, ref_id")
      .eq("account", "gas_pool")
      .eq("direction", "CR");

    // platform_fee DR = treasury payouts from platform_fee
    const { data: platformFeeDrRows } = await admin
      .from("ledger_entries")
      .select("amount")
      .eq("account", "platform_fee")
      .eq("direction", "DR");

    // gas_pool DR = treasury payouts from gas_pool
    const { data: gasPoolDrRows } = await admin
      .from("ledger_entries")
      .select("amount")
      .eq("account", "gas_pool")
      .eq("direction", "DR");

    // --- Get order/deal IDs to split gas_pool by source ---
    const { data: doneOrders } = await admin
      .from("orders")
      .select("id")
      .eq("status", "DONE");

    const { data: doneDeals } = await admin
      .from("wl_deals")
      .select("id")
      .eq("status", "COMPLETED");

    const orderIds = new Set((doneOrders ?? []).map((o: { id: string }) => o.id));
    const dealIds = new Set((doneDeals ?? []).map((d: { id: string }) => d.id));

    // --- Compute marketplace vs WL gas_pool split ---
    let marketplaceGasMicro = 0n;
    let wlGasMicro = 0n;
    let unmappedGasMicro = 0n;

    for (const row of gasPoolRows ?? []) {
      const amt = BigInt(row.amount as string);
      const ref = row.ref_id as string | null;
      if (ref && orderIds.has(ref)) marketplaceGasMicro += amt;
      else if (ref && dealIds.has(ref)) wlGasMicro += amt;
      else unmappedGasMicro += amt;
    }

    // platform_fee is marketplace-only
    const platformFeeCredited = (platformFeeRows ?? []).reduce(
      (sum, r) => sum + BigInt(r.amount as string), 0n
    );
    const platformFeePaidOut = (platformFeeDrRows ?? []).reduce(
      (sum, r) => sum + BigInt(r.amount as string), 0n
    );
    const platformFeeBalance = platformFeeCredited - platformFeePaidOut;

    const gasPoolCredited = marketplaceGasMicro + wlGasMicro + unmappedGasMicro;
    const gasPoolPaidOut = (gasPoolDrRows ?? []).reduce(
      (sum, r) => sum + BigInt(r.amount as string), 0n
    );
    const gasPoolBalance = gasPoolCredited - gasPoolPaidOut;

    // --- Marketplace stats ---
    const { count: marketplaceOrderCount } = await admin
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("status", "DONE");

    const { data: mkOrders } = await admin
      .from("orders")
      .select("amount, circle_fee, gas_fee")
      .eq("status", "DONE");

    let mkVolume = 0n;
    let mkCircleGas = 0n;
    for (const o of mkOrders ?? []) {
      mkVolume += BigInt(o.amount as string);
      mkCircleGas += BigInt(o.circle_fee as string) + BigInt(o.gas_fee as string);
    }

    // --- WL escrow stats ---
    const { count: wlDealCount } = await admin
      .from("wl_deals")
      .select("*", { count: "exact", head: true })
      .eq("status", "COMPLETED");

    const { data: wlDeals } = await admin
      .from("wl_deals")
      .select("price, base_fee, total")
      .eq("status", "COMPLETED");

    let wlVolume = 0n;
    let wlBaseFee = 0n;
    let wlCircleGas = 0n;
    for (const d of wlDeals ?? []) {
      const price = BigInt(d.price as string);
      const total = BigInt(d.total as string);
      const base = BigInt(d.base_fee as string);
      wlVolume += price;
      // derive the WL buyer fee from `price` (2%) instead of
      // trusting the stored `base_fee`, which is persisted as 0 in v4 while the
      // contract actually charges computeFee(price). Reading the column made
      // "Pending Escrow Fees" report $0.00 forever, disagreeing with
      // /api/admin/sales-summary, which already derived it correctly. The chain
      // is the source of truth, so mirror the chain.
      wlBaseFee += computeFee(price);
      // total = price + base + circle + gas (set in proceed_wl_deal_atomic), so
      // circle+gas = total - price - base.
      wlCircleGas += (total - price - base);
    }

    const audit = await getMmAuditTrail(50);

    return jsonOk({
      treasury: process.env.NEXT_PUBLIC_AGENT_WALLET_ADDRESS ?? null,
      escrowContract: process.env.ESCROW_CONTRACT_ADDRESS ?? null,
      contractReady: isContractReady(),
      auditTrail: audit,
      // Collected fees breakdown
      collectedFees: {
        marketplace: {
          platformFee: microToNum(platformFeeCredited.toString()),
          gasPool: microToNum(marketplaceGasMicro.toString()),
          total: microToNum((platformFeeCredited + marketplaceGasMicro).toString()),
        },
        escrow: {
          baseFee: microToNum(wlBaseFee.toString()),
          gasPool: microToNum(wlGasMicro.toString()),
          total: microToNum((wlBaseFee + wlGasMicro).toString()),
        },
        total: microToNum(
          (platformFeeCredited + marketplaceGasMicro + wlBaseFee + wlGasMicro).toString()
        ),
      },
      // Available balances (after payouts)
      balances: {
        platformFee: {
          collected: microToNum(platformFeeCredited.toString()),
          paidOut: microToNum(platformFeePaidOut.toString()),
          available: microToNum(platformFeeBalance.toString()),
        },
        gasPool: {
          collected: microToNum(gasPoolCredited.toString()),
          paidOut: microToNum(gasPoolPaidOut.toString()),
          available: microToNum(gasPoolBalance.toString()),
        },
        totalAvailable: microToNum((platformFeeBalance + gasPoolBalance).toString()),
      },
      // Revenue stats
      stats: {
        marketplace: {
          orders: marketplaceOrderCount ?? 0,
          volume: microToNum(mkVolume.toString()),
          circleGasRevenue: microToNum(mkCircleGas.toString()),
        },
        escrow: {
          deals: wlDealCount ?? 0,
          volume: microToNum(wlVolume.toString()),
          circleGasRevenue: microToNum(wlCircleGas.toString()),
        },
      },
    });
  } catch (e) {
    return jsonError(clientErrorMessage(e, "error"), 500);
  }
}

/** POST — collectFees from contract (requires PIN + UCW) */
export async function POST(req: Request) {
  const auth = await requireAdminAuth(req);
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");

  if (action === "collectFees") {
    if (!isContractReady()) return jsonError("Escrow contract not deployed yet", 400);
    try {
      // this used to call sendUsdc(platform, treasury, 0n): it moved
      // ZERO USDC and still answered "Treasury fees collected". It never touched
      // `pendingFees`. Sweeping is `MarketEscrow.collectFees()`, which only the
      // treasury (the platform DCW) may call — relay it for real.
      const { collectFeesOnChain, readEscrowStats } = await import("@/lib/contracts/escrow-client");
      const before = await readEscrowStats();
      if (before.pendingFees <= 0n) return jsonError("no pending fees to collect", 409);
      const result = await collectFeesOnChain();
      if (!result) return jsonError("Escrow contract not deployed yet", 400);
      return jsonOk({
        txId: result.id,
        state: result.state,
        collectedMicro: before.pendingFees.toString(),
        message: "Fee sweep submitted on-chain",
      });
    } catch (e) {
      return jsonError(clientErrorMessage(e, "collect failed"), 400);
    }
  }

  return jsonError("unknown action", 400);
}
