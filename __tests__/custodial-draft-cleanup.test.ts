import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Regression: `cleanupExpiredDrafts` only reaped `payment='Onchain'` drafts.
 *
 * `prepareCheckoutOrder` defaults `p_payment` to "Balance", and
 * `confirmCheckoutOrder` resets a failed relay to `p_target_status: "PENDING"`.
 * Nothing else ever moves a 'Balance' PENDING row out of that state, so an
 * abandoned or rolled-back custodial checkout sat in PENDING **forever**,
 * polluting the buyer's order list.
 *
 * Live evidence (2026-09-27): 7 orders sat PENDING for 8–9h and the cron job
 * always reported `{"scanned":0,"expired":0}`. After the fix: `expired:7`.
 *
 * These are source-level assertions because the sweep itself is a live DB
 * UPDATE; the pure decision helpers are covered in draft-cleanup.test.ts.
 */
const SRC = fs.readFileSync(
  path.join(process.cwd(), "lib/order/draft-cleanup.ts"),
  "utf8",
);

describe("cleanupExpiredDrafts — custodial ('Balance') PENDING drafts are reaped", () => {
  it("defines a custodial TTL constant", () => {
    expect(SRC).toMatch(/CUSTODIAL_DRAFT_TTL_MINUTES\s*=\s*\d+/);
  });

  it("has an UPDATE targeting payment = 'Balance' with status PENDING", () => {
    // The custodial pass must exist and be scoped to PENDING + Saldo.
    expect(SRC).toMatch(/\.eq\("payment",\s*"Balance"\)/);
    expect(SRC).toContain('"PENDING"');
  });

  it("guards the custodial pass against rows whose relay was submitted", () => {
    // MONEY SAFETY: if the createOrderFor relay was submitted the buyer's USDC
    // may already be in MarketEscrow; such rows belong to reconciliation, not
    // to the sweeper. Both on-chain guards must be present on the Saldo path.
    const saldoBlock = SRC.slice(SRC.indexOf('"Balance"'));
    expect(saldoBlock).toMatch(/\.is\("on_chain_order_id",\s*null\)/);
    expect(saldoBlock).toMatch(/\.is\("on_chain_circle_tx_id",\s*null\)/);
  });

  it("counts custodial expiries in the returned result", () => {
    expect(SRC).toMatch(/custodialExpiredCount/);
    // returned `expired` must include both rails
    expect(SRC).toMatch(/expired:\s*expiredCount\s*\+\s*custodialExpiredCount/);
  });

  it("keeps the original non-custodial ('Onchain') pass intact", () => {
    expect(SRC).toMatch(/\.eq\("payment",\s*"Onchain"\)/);
  });
});
