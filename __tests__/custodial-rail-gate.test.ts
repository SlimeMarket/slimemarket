import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Regression: the legacy CUSTODIAL checkout rail was reachable in
 * non-custodial mode.
 *
 * `POST /api/orders` → `checkoutOrder()` always writes `payment='Balance'` and
 * funds escrow from the Platform DCW. With `ONCHAIN_WALLET_FUNDS=1` that is
 * wrong twice over:
 *
 *   1. The buyer's USDC lives in THEIR wallet — nothing was debited — yet the
 *      order is created (and for instant delivery flipped to SENT with
 *      credentials attached) as if it had been paid.
 *   2. If the escrow relay then fails the row becomes
 *      `SENT` + `Saldo` + no on-chain id. `confirmOrder` correctly refuses that
 *      with a 409 ONCHAIN_ID_UNRESOLVED, and draft-cleanup used to skip it
 *      because `isStuckInstantDraft` required `payment === "Onchain"`.
 *      Result: the order stuck forever with no way out.
 *
 * Live proof 2026-09-28: orders `b5716370-…` and `efebc052-…` were wedged in
 * exactly this state; `GET /api/admin/sweep/drafts` reported
 * `{"stuckRestocked":2}` and both became CANCELLED only AFTER the fix.
 *
 * The guard must be present so a non-custodial deployment can never mint a
 * custodial row again.
 */
const SRC = fs.readFileSync(
  path.join(process.cwd(), "lib/order/checkout.ts"),
  "utf8",
);
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Body of `export async function checkoutOrder(...)`. */
function checkoutOrderBody(): string {
  const start = CODE.indexOf("export async function checkoutOrder");
  expect(start, "checkoutOrder not found in lib/order/checkout.ts").toBeGreaterThan(-1);
  const next = CODE.indexOf("export async function", start + 10);
  return CODE.slice(start, next > start ? next : start + 4000);
}

describe("checkoutOrder — legacy custodial rail is gated", () => {
  it("refuses to run when ONCHAIN_WALLET_FUNDS=1", () => {
    const body = checkoutOrderBody();
    // Must consult the flag BEFORE the first write to create_order_atomic.
    const guard = body.search(/ONCHAIN_FUNDS_ENABLED|onchainFundsEnabled\(\)/);
    const write = body.indexOf("create_order_atomic");
    expect(guard, "checkoutOrder does not check the on-chain flag").toBeGreaterThan(-1);
    expect(write, "create_order_atomic call not found").toBeGreaterThan(-1);
    expect(guard, "guard must run before create_order_atomic").toBeLessThan(write);
  });

  it("throws a typed 409 rather than a generic error", () => {
    const body = checkoutOrderBody();
    const guard = body.slice(
      body.search(/ONCHAIN_FUNDS_ENABLED|onchainFundsEnabled\(\)/),
      body.indexOf("create_order_atomic"),
    );
    expect(guard).toMatch(/throw\s+/);
    expect(guard).toMatch(/httpStatus\s*=\s*409/);
    expect(guard).toMatch(/code\s*=\s*"CUSTODIAL_RAIL_DISABLED"/);
  });

  it("still defaults p_payment to 'Balance' for the custodial path it guards", () => {
    // The guard must not silently rewrite the legacy rail for custodial
    // deployments — they still rely on 'Balance'.
    expect(CODE).toMatch(/p_payment:\s*input\.payment\s*\?\?\s*"Balance"/);
  });

  it("the non-custodial two-phase rail keeps defaulting to 'Onchain'", () => {
    expect(CODE).toMatch(/p_payment:\s*input\.payment\s*\?\?\s*"Onchain"/);
  });
});
